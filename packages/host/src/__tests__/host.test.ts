import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import {
  addOrganization,
  addPrincipal,
  createDocoInHost,
  createHost,
  createScopeInDoco,
  detectMode,
  listDocos,
  listOrganizations,
  listPrincipals,
  parseScopeNamesInput,
  resolveOwnerSlug,
} from "../index.js";
import type { EntityId } from "@doco/shared";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "doco-host-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("host lifecycle", () => {
  it("creates a host with a bootstrap principal", async () => {
    const root = join(tmp, "host");
    const { host, bootstrapPrincipalId } = await createHost(root, {
      name: "Test Host",
      ownerUsername: "alice",
      ownerEmail: "alice@example.com",
    });
    expect(host.name).toBe("Test Host");
    expect(detectMode(root)).toBe("host");
    expect(bootstrapPrincipalId).toBeTruthy();
    const principals = await listPrincipals(root);
    expect(principals.find((p) => p.slug === "alice")).toBeTruthy();
  });

  it("rejects nested overwrite of an existing root", async () => {
    const root = join(tmp, "host");
    await createHost(root, { name: "First" });
    await expect(createHost(root, { name: "Second" })).rejects.toThrow(/already a Host/);
  });

  it("addPrincipal then addOrganization", async () => {
    const root = join(tmp, "host");
    await createHost(root, { name: "Test" });
    await addPrincipal(root, { username: "alice", email: "a@example.com" });
    await addPrincipal(root, { username: "bob" });
    const orgId = await addOrganization(root, { slug: "anthropic", ownerUsername: "alice" });
    expect(orgId).toMatch(/^organization_/);
    const orgs = await listOrganizations(root);
    expect(orgs.find((o) => o.slug === "anthropic")).toBeTruthy();
  });

  it("ADR-064 shared namespace: refuses an org slug that collides with a username", async () => {
    const root = join(tmp, "host");
    await createHost(root, { name: "Test" });
    await addPrincipal(root, { username: "alice" });
    await expect(addOrganization(root, { slug: "alice", ownerUsername: "alice" })).rejects.toThrow(
      /already taken/,
    );
  });

  it("ADR-067 reserved slugs: refuses 'sign-in' as a username and 'new' as an org slug", async () => {
    const root = join(tmp, "host");
    await createHost(root, { name: "Test" });
    await expect(addPrincipal(root, { username: "sign-in" })).rejects.toThrow(/reserved/);
    await addPrincipal(root, { username: "carol" });
    await expect(addOrganization(root, { slug: "new", ownerUsername: "carol" })).rejects.toThrow(/reserved/);
  });

  it("ADR-067 slug pattern: refuses uppercase / spaces / special chars", async () => {
    const root = join(tmp, "host");
    await createHost(root, { name: "Test" });
    await expect(addPrincipal(root, { username: "Alice" })).rejects.toThrow(/kebab-case/);
    await expect(addPrincipal(root, { username: "ali ce" })).rejects.toThrow(/kebab-case/);
  });

  it("creates an Doco owned by a Principal (user-owned)", async () => {
    const root = join(tmp, "host");
    await createHost(root, { name: "Test" });
    await addPrincipal(root, { username: "alice" });
    const rec = await createDocoInHost(root, { ownerSlug: "alice", docoSlug: "my-doco" });
    expect(rec.ownerKind).toBe("principal");
    expect(rec.docoId).toMatch(/^doco_/);
    expect(rec.path.endsWith("docos/alice/my-doco")).toBe(true);
  });

  it("creates an Doco owned by an Organization (org-owned)", async () => {
    const root = join(tmp, "host");
    await createHost(root, { name: "Test" });
    await addPrincipal(root, { username: "alice" });
    await addOrganization(root, { slug: "anthropic", ownerUsername: "alice" });
    const rec = await createDocoInHost(root, {
      ownerSlug: "anthropic",
      docoSlug: "internal-policies",
    });
    expect(rec.ownerKind).toBe("organization");
    expect(rec.ownerId).toMatch(/^organization_/);
  });

  it("createDocoInHost retries cleanly after a partial-create leftover", async () => {
    const root = join(tmp, "host");
    await createHost(root, { name: "Test" });
    await addPrincipal(root, { username: "alice" });
    const docoDir = join(root, "docos", "alice", "leftover");
    // Simulate the leftover that ENOENT used to produce: dir + empty subdirs,
    // no doco.yaml. createDocoInHost should treat this as recoverable rather
    // than throwing "Doco already exists".
    await mkdir(join(docoDir, "schema"), { recursive: true });
    await mkdir(join(docoDir, "actions"), { recursive: true });
    const rec = await createDocoInHost(root, { ownerSlug: "alice", docoSlug: "leftover" });
    expect(rec.docoId).toMatch(/^doco_/);
    expect(existsSync(join(docoDir, "doco.yaml"))).toBe(true);
  });

  it("createDocoInHost refuses when a real doco.yaml already exists at that path", async () => {
    const root = join(tmp, "host");
    await createHost(root, { name: "Test" });
    await addPrincipal(root, { username: "alice" });
    await createDocoInHost(root, { ownerSlug: "alice", docoSlug: "real" });
    await expect(
      createDocoInHost(root, { ownerSlug: "alice", docoSlug: "real" }),
    ).rejects.toThrow(/already exists/);
  });

  it("createDocoInHost falls back to the bundled schema template when the host has none", async () => {
    const root = join(tmp, "host");
    await createHost(root, { name: "Test" });
    await addPrincipal(root, { username: "alice" });
    await rm(join(root, "schema"), { recursive: true, force: true });
    const rec = await createDocoInHost(root, { ownerSlug: "alice", docoSlug: "no-host-schema" });
    expect(existsSync(join(rec.path, "schema", "doco.schema.json"))).toBe(true);
  });

  it("listDocos returns both user-owned and org-owned", async () => {
    const root = join(tmp, "host");
    await createHost(root, { name: "Test" });
    await addPrincipal(root, { username: "alice" });
    await addOrganization(root, { slug: "anthropic", ownerUsername: "alice" });
    await createDocoInHost(root, { ownerSlug: "alice", docoSlug: "personal" });
    await createDocoInHost(root, { ownerSlug: "anthropic", docoSlug: "shared" });
    const list = await listDocos(root);
    expect(list.length).toBe(2);
    expect(list.find((r) => r.ownerSlug === "alice")?.ownerKind).toBe("principal");
    expect(list.find((r) => r.ownerSlug === "anthropic")?.ownerKind).toBe("organization");
  });

  it("resolveOwnerSlug returns the right kind", async () => {
    const root = join(tmp, "host");
    await createHost(root, { name: "Test" });
    await addPrincipal(root, { username: "alice" });
    await addOrganization(root, { slug: "anthropic", ownerUsername: "alice" });
    expect((await resolveOwnerSlug(root, "alice"))?.kind).toBe("principal");
    expect((await resolveOwnerSlug(root, "anthropic"))?.kind).toBe("organization");
    expect(await resolveOwnerSlug(root, "nobody")).toBeNull();
  });
});

describe("parseScopeNamesInput (ADR-081 — slash-input → segment paths)", () => {
  it("splits each line into segment paths", () => {
    const { valid, invalid } = parseScopeNamesInput(
      [
        "user-flows",
        "country/france/payment",
        "reporter/board",
        "design-system/components",
        "scope_meta",
        "",
        "  ",
        "# comment",
      ].join("\n"),
    );
    expect(valid).toEqual([
      ["user-flows"],
      ["country", "france", "payment"],
      ["reporter", "board"],
      ["design-system", "components"],
      ["scope_meta"],
    ]);
    expect(invalid).toEqual([]);
  });

  it("rejects bad names + dedupes paths", () => {
    const { valid, invalid } = parseScopeNamesInput(
      ["UPPERCASE", "1bad-leading-digit", "trailing/", "ok-name", "ok-name"].join("\n"),
    );
    expect(invalid).toEqual(["UPPERCASE", "1bad-leading-digit"]);
    // Trailing slash trims to "trailing" — single segment, valid; deduped vs ok-name.
    expect(valid).toEqual([["trailing"], ["ok-name"]]);
  });

  it("treats blank lines and # comments as ignored", () => {
    const out = parseScopeNamesInput("# header\n\n  \nfoo\n# trailing");
    expect(out.valid).toEqual([["foo"]]);
    expect(out.invalid).toEqual([]);
  });
});

describe("createScopeInDoco (ADR-080 + ADR-081 + ADR-082)", () => {
  it("writes a scope yaml with flat name + parent + purpose + guidelines", async () => {
    const root = join(tmp, "host");
    await createHost(root, { name: "Test" });
    await addPrincipal(root, { username: "alice" });
    const rec = await createDocoInHost(root, { ownerSlug: "alice", docoSlug: "demo" });
    const parentId = await createScopeInDoco({
      docoDir: rec.path,
      docoId: rec.docoId,
      name: "country",
      createdBy: null,
    });
    const childId = await createScopeInDoco({
      docoDir: rec.path,
      docoId: rec.docoId,
      name: "france",
      purpose: "France-specific work.",
      guidelines: "Cite Décret laws by article.",
      parentScopes: [parentId],
      createdBy: null,
    });
    expect(childId.startsWith("scope_")).toBe(true);
    const text = await readFile(join(rec.path, "scopes", `${childId}.yaml`), "utf8");
    expect(text).toContain("name: france");
    expect(text).toContain("purpose: France-specific work.");
    expect(text).toContain("guidelines:");
    expect(text).toContain(parentId);
  });

  it("attributes created_by when a principal is supplied", async () => {
    const root = join(tmp, "host");
    await createHost(root, { name: "Test" });
    await addPrincipal(root, { username: "alice" });
    const rec = await createDocoInHost(root, { ownerSlug: "alice", docoSlug: "demo" });
    const fakePrincipal = "principal_01HHFAKEFAKEFAKEFAKEFAKE00" as EntityId<"principal">;
    const id = await createScopeInDoco({
      docoDir: rec.path,
      docoId: rec.docoId,
      name: "user-flows",
      createdBy: fakePrincipal,
    });
    const text = await readFile(join(rec.path, "scopes", `${id}.yaml`), "utf8");
    expect(text).toContain(`created_by: ${fakePrincipal}`);
  });
});

describe("materializeScopeTree (ADR-081)", () => {
  it("creates a chain of scopes with parent edges from a slash-path", async () => {
    const root = join(tmp, "host");
    await createHost(root, { name: "Test" });
    await addPrincipal(root, { username: "alice" });
    const rec = await createDocoInHost(root, { ownerSlug: "alice", docoSlug: "demo" });
    const { materializeScopeTree } = await import("../host.js");
    const out = await materializeScopeTree({
      docoDir: rec.path,
      docoId: rec.docoId,
      paths: [
        ["country", "france", "payment"],
        ["country", "france", "shipping"],
        ["reporter", "board"],
      ],
      createdBy: null,
    });
    // 6 unique scopes: country, france, payment, shipping, reporter, board.
    expect(out.created.length).toBe(6);
    expect(out.byName.get("country")).toBeTruthy();
    expect(out.byName.get("france")).toBeTruthy();
    expect(out.byName.get("payment")).toBeTruthy();
    expect(out.byName.get("shipping")).toBeTruthy();
    // Verify france has country as parent.
    const franceFile = `${out.byName.get("france")}.yaml`;
    const franceYaml = await readFile(join(rec.path, "scopes", franceFile), "utf8");
    expect(franceYaml).toContain(out.byName.get("country")!);
  });

  it("reuses existing scopes by name (idempotent)", async () => {
    const root = join(tmp, "host");
    await createHost(root, { name: "Test" });
    await addPrincipal(root, { username: "alice" });
    const rec = await createDocoInHost(root, { ownerSlug: "alice", docoSlug: "demo" });
    const { materializeScopeTree } = await import("../host.js");
    const first = await materializeScopeTree({
      docoDir: rec.path,
      docoId: rec.docoId,
      paths: [["country", "france"]],
      createdBy: null,
    });
    expect(first.created.length).toBe(2);
    // Run again — no new scopes should be created.
    const second = await materializeScopeTree({
      docoDir: rec.path,
      docoId: rec.docoId,
      paths: [["country", "france"]],
      createdBy: null,
      existingByName: first.byName,
    });
    expect(second.created.length).toBe(0);
  });

  it("applies template purpose + guidelines to leaf scopes", async () => {
    const root = join(tmp, "host");
    await createHost(root, { name: "Test" });
    await addPrincipal(root, { username: "alice" });
    const rec = await createDocoInHost(root, { ownerSlug: "alice", docoSlug: "demo" });
    const { materializeScopeTree, findScopeTemplate } = await import("../index.js");
    const out = await materializeScopeTree({
      docoDir: rec.path,
      docoId: rec.docoId,
      paths: [["adrs"]],
      createdBy: null,
      templateForLeaf: (name) => {
        const tpl = findScopeTemplate(name);
        return tpl ? { purpose: tpl.purpose, guidelines: tpl.guidelines } : undefined;
      },
    });
    const adrsFile = `${out.byName.get("adrs")}.yaml`;
    const yaml = await readFile(join(rec.path, "scopes", adrsFile), "utf8");
    expect(yaml).toContain("purpose:");
    expect(yaml).toContain("Architecture Decision Records");
    expect(yaml).toContain("guidelines:");
  });
});

describe("updateScopeInDoco / deleteScopeInDoco (ADR-084 follow-up)", () => {
  it("updates purpose + guidelines + parents on an existing scope", async () => {
    const root = join(tmp, "host");
    await createHost(root, { name: "Test" });
    await addPrincipal(root, { username: "alice" });
    const rec = await createDocoInHost(root, { ownerSlug: "alice", docoSlug: "demo" });
    const { updateScopeInDoco } = await import("../host.js");
    const parentId = await createScopeInDoco({
      docoDir: rec.path,
      docoId: rec.docoId,
      name: "country",
      createdBy: null,
    });
    const childId = await createScopeInDoco({
      docoDir: rec.path,
      docoId: rec.docoId,
      name: "france",
      createdBy: null,
    });
    await updateScopeInDoco({
      docoDir: rec.path,
      scopeId: childId,
      purpose: "France-specific work.",
      guidelines: "Cite Décret laws by article.",
      parentScopes: [parentId],
    });
    const text = await readFile(join(rec.path, "scopes", `${childId}.yaml`), "utf8");
    expect(text).toContain("purpose: France-specific work.");
    expect(text).toContain("guidelines:");
    expect(text).toContain(parentId);
    expect(text).toContain("revision: 2");
  });

  it("clears purpose/guidelines when passed null", async () => {
    const root = join(tmp, "host");
    await createHost(root, { name: "Test" });
    await addPrincipal(root, { username: "alice" });
    const rec = await createDocoInHost(root, { ownerSlug: "alice", docoSlug: "demo" });
    const { updateScopeInDoco } = await import("../host.js");
    const id = await createScopeInDoco({
      docoDir: rec.path,
      docoId: rec.docoId,
      name: "user-flows",
      purpose: "to be cleared",
      guidelines: "to be cleared",
      createdBy: null,
    });
    await updateScopeInDoco({
      docoDir: rec.path,
      scopeId: id,
      purpose: null,
      guidelines: null,
    });
    const text = await readFile(join(rec.path, "scopes", `${id}.yaml`), "utf8");
    expect(text).not.toContain("purpose:");
    expect(text).not.toContain("guidelines:");
  });

  it("deletes the scope yaml file", async () => {
    const root = join(tmp, "host");
    await createHost(root, { name: "Test" });
    await addPrincipal(root, { username: "alice" });
    const rec = await createDocoInHost(root, { ownerSlug: "alice", docoSlug: "demo" });
    const { deleteScopeInDoco } = await import("../host.js");
    const id = await createScopeInDoco({
      docoDir: rec.path,
      docoId: rec.docoId,
      name: "doomed",
      createdBy: null,
    });
    expect(existsSync(join(rec.path, "scopes", `${id}.yaml`))).toBe(true);
    await deleteScopeInDoco({ docoDir: rec.path, scopeId: id });
    expect(existsSync(join(rec.path, "scopes", `${id}.yaml`))).toBe(false);
  });
});

describe("migrateScopesInDoco (ADR-081)", () => {
  it("splits slash-named scopes into edge-tree (idempotent)", async () => {
    const root = join(tmp, "host");
    await createHost(root, { name: "Test" });
    await addPrincipal(root, { username: "alice" });
    const rec = await createDocoInHost(root, { ownerSlug: "alice", docoSlug: "demo" });
    // Seed legacy slash-named scopes by writing the yaml directly (bypassing
    // the new createScopeInDoco's validation).
    const { writeFile: wf } = await import("node:fs/promises");
    const { stringify } = await import("yaml");
    const legacyId1 = "scope_01HHLEGACY1AAAAAAAAAAAAAA";
    const legacyId2 = "scope_01HHLEGACY2BBBBBBBBBBBBBB";
    await wf(
      join(rec.path, "scopes", `${legacyId1}.yaml`),
      stringify({
        id: legacyId1,
        doco_id: rec.docoId,
        node_type: "scope",
        schema_version: "0.1",
        summary: "Scope: country/france/payment",
        name: "country/france/payment",
        created_at: "2026-05-09T00:00:00Z",
        created_by: null,
        revision: 1,
        lifecycle: "active",
        status: "active",
        scopes: [],
      }),
      "utf8",
    );
    await wf(
      join(rec.path, "scopes", `${legacyId2}.yaml`),
      stringify({
        id: legacyId2,
        doco_id: rec.docoId,
        node_type: "scope",
        schema_version: "0.1",
        summary: "Scope: country/france/shipping",
        name: "country/france/shipping",
        created_at: "2026-05-09T00:00:00Z",
        created_by: null,
        revision: 1,
        lifecycle: "active",
        status: "active",
        scopes: [],
      }),
      "utf8",
    );

    const { migrateScopesInDoco } = await import("../host.js");
    const r1 = await migrateScopesInDoco({
      docoDir: rec.path,
      docoId: rec.docoId,
      createdBy: null,
    });
    expect(r1.renamed).toBe(2);
    expect(r1.created).toBe(2); // country, france
    // Legacy ids preserved; names are now leaves.
    const legacy1 = parseYaml(
      await readFile(join(rec.path, "scopes", `${legacyId1}.yaml`), "utf8"),
    ) as Record<string, unknown>;
    expect(legacy1.name).toBe("payment");
    expect(Array.isArray(legacy1.scopes)).toBe(true);
    // Re-running the migration is a no-op.
    const r2 = await migrateScopesInDoco({
      docoDir: rec.path,
      docoId: rec.docoId,
      createdBy: null,
    });
    expect(r2.renamed).toBe(0);
    expect(r2.created).toBe(0);
  });
});
