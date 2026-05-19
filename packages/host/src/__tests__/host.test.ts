import { mkdtemp, rm } from "node:fs/promises";
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withClient } from "@doco/db";
import { type EntityId, generateUlid, makeEntityId } from "@doco/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  addOrganization,
  addPrincipal,
  createDocoInHost,
  createHost,
  createScopeInDoco,
  detectMode,
  findScopeTemplate,
  listDocos,
  listOrganizations,
  listPrincipals,
  parseScopeNamesInput,
  resolveOwnerSlug,
} from "../index.js";

let tmp: string;

async function readScopeRawYaml(scopeId: EntityId<"scope">): Promise<Record<string, unknown>> {
  const row = await withClient(async (c) => {
    const result = await c.query<{ raw_yaml: string }>(
      "SELECT raw_yaml FROM scopes WHERE id = $1 LIMIT 1",
      [scopeId],
    );
    return result.rows[0];
  });
  if (!row) throw new Error(`Scope not found: ${scopeId}`);
  return JSON.parse(row.raw_yaml) as Record<string, unknown>;
}

async function findScopeRawYamlByName(
  docoId: EntityId<"doco">,
  name: string,
): Promise<Record<string, unknown> | null> {
  const row = await withClient(async (c) => {
    const result = await c.query<{ raw_yaml: string }>(
      "SELECT raw_yaml FROM scopes WHERE doco_id = $1 AND name = $2 LIMIT 1",
      [docoId, name],
    );
    return result.rows[0] ?? null;
  });
  return row ? (JSON.parse(row.raw_yaml) as Record<string, unknown>) : null;
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "doco-host-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("host lifecycle", () => {
  it("global template description names the rules-only constitution", () => {
    const tpl = findScopeTemplate("global");

    expect(tpl?.purpose).toBe(
      "Your doco's rule book — the standing rules, invariants, and authority claims anyone can cite from anywhere. Rules only.",
    );
    expect(tpl?.allowed_node_types).toEqual(["rule"]);
  });

  it("keeps user-flows template picker copy concise", () => {
    const tpl = findScopeTemplate("user-flows");

    expect(tpl?.purpose).toBe(
      "Document end-to-end user journeys as ordered steps, branches, and decisions.",
    );
    expect(tpl?.purpose.length).toBeLessThan(90);
  });

  it("seeds deterministic principal rules for user-flows", () => {
    const tpl = findScopeTemplate("user-flows");
    const predicates = tpl?.rules.map((rule) => rule.predicate);

    expect(predicates).toContainEqual({
      kind: "requires_node_type",
      node_types: ["intent", "action", "decision", "reference", "rule"],
    });
    expect(predicates).toContainEqual({
      kind: "requires_field",
      fields: ["wanted_by"],
      when_node_type: ["intent"],
    });
    expect(predicates).toContainEqual({
      kind: "requires_field",
      fields: ["actor_id"],
      when_node_type: ["action"],
    });
    expect(predicates).toContainEqual({
      kind: "requires_field",
      fields: ["decided_by"],
      when_node_type: ["decision"],
    });
  });

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
    await expect(addOrganization(root, { slug: "new", ownerUsername: "carol" })).rejects.toThrow(
      /reserved/,
    );
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
    expect(rec.handle).toBe("alice-my-doco");
  });

  it("createDocoInHost can use a preallocated Doco id", async () => {
    const root = join(tmp, "host");
    await createHost(root, { name: "Test" });
    const docoId = makeEntityId("doco", generateUlid()) as EntityId<"doco">;
    const ownerSlug = `setup-agent-${docoId.toLowerCase()}`;
    await addPrincipal(root, { username: ownerSlug });
    const rec = await createDocoInHost(root, {
      ownerSlug,
      docoSlug: "setup",
      docoId,
    });

    expect(rec.docoId).toBe(docoId);
    expect((await listDocos(root)).some((doco) => doco.docoId === docoId)).toBe(true);
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
    // Simulate the leftover that ENOENT used to produce: dir + empty subdirs.
    // Postgres is the source of truth now, so this should not block creation.
    await mkdir(join(docoDir, "scopes"), { recursive: true });
    await mkdir(join(docoDir, "actions"), { recursive: true });
    const rec = await createDocoInHost(root, { ownerSlug: "alice", docoSlug: "leftover" });
    expect(rec.docoId).toMatch(/^doco_/);
    expect((await listDocos(root)).some((doco) => doco.docoId === rec.docoId)).toBe(true);
  });

  it("createDocoInHost refuses when a real doco.yaml already exists at that path", async () => {
    const root = join(tmp, "host");
    await createHost(root, { name: "Test" });
    await addPrincipal(root, { username: "alice" });
    await createDocoInHost(root, { ownerSlug: "alice", docoSlug: "real" });
    await expect(createDocoInHost(root, { ownerSlug: "alice", docoSlug: "real" })).rejects.toThrow(
      /already exists/,
    );
  });

  it("createDocoInHost auto-suffixes on collision when autoSuffixOnCollision is set", async () => {
    // Anonymous agent-onboarding case: shouldn't surface that a Doco
    // already exists at the desired slug (would leak existence to an
    // unauthorized caller). Server picks the next free `-N` and reports
    // the actual slug back so the caller can build the right URLs.
    const root = join(tmp, "host");
    await createHost(root, { name: "Test" });
    await addPrincipal(root, { username: "alice" });
    const first = await createDocoInHost(root, { ownerSlug: "alice", docoSlug: "demo" });
    expect(first.handle).toBe("alice-demo");
    const second = await createDocoInHost(root, {
      ownerSlug: "alice",
      docoSlug: "demo",
      autoSuffixOnCollision: true,
    });
    expect(second.handle).toBe("alice-demo-2");
    const third = await createDocoInHost(root, {
      ownerSlug: "alice",
      docoSlug: "demo",
      autoSuffixOnCollision: true,
    });
    expect(third.handle).toBe("alice-demo-3");
  });

  it("createDocoInHost returns the originally requested slug when there is no collision (autoSuffixOnCollision no-op)", async () => {
    const root = join(tmp, "host");
    await createHost(root, { name: "Test" });
    await addPrincipal(root, { username: "alice" });
    const rec = await createDocoInHost(root, {
      ownerSlug: "alice",
      docoSlug: "fresh",
      autoSuffixOnCollision: true,
    });
    expect(rec.handle).toBe("alice-fresh");
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
  it("splits each line into segment paths (auto-prefixes # on bare segments)", () => {
    const { valid, invalid } = parseScopeNamesInput(
      [
        "#user-flows",
        "country/france/payment",
        "#reporter/board",
        "design-system/components",
        "#scope_meta",
        "",
        "  ",
        "# comment",
      ].join("\n"),
    );
    expect(valid).toEqual([
      ["#user-flows"],
      ["#country", "#france", "#payment"],
      ["#reporter", "#board"],
      ["#design-system", "#components"],
      ["#scope_meta"],
    ]);
    expect(invalid).toEqual([]);
  });

  it("rejects bad names + dedupes paths", () => {
    const { valid, invalid } = parseScopeNamesInput(
      ["UPPERCASE", "1bad-leading-digit", "trailing/", "ok-name", "ok-name"].join("\n"),
    );
    expect(invalid).toEqual(["UPPERCASE", "1bad-leading-digit"]);
    // Trailing slash trims to "trailing" — single segment, valid; deduped vs ok-name.
    expect(valid).toEqual([["#trailing"], ["#ok-name"]]);
  });

  it("treats blank lines and `# ` (hash-space) comments as ignored, but `#name` is a scope", () => {
    const out = parseScopeNamesInput("# header\n\n  \nfoo\n# trailing\n#explicit");
    expect(out.valid).toEqual([["#foo"], ["#explicit"]]);
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
      watched: false,
      createdBy: null,
    });
    const childId = await createScopeInDoco({
      docoDir: rec.path,
      docoId: rec.docoId,
      name: "france",
      purpose: "France-specific work.",
      guidelines: "Cite Décret laws by article.",
      parentScopes: [parentId],
      watched: false,
      createdBy: null,
    });
    expect(childId.startsWith("scope_")).toBe(true);
    const scope = await readScopeRawYaml(childId);
    expect(scope.name).toBe("france");
    expect(scope.purpose).toBe("France-specific work.");
    expect(scope.scopes).toContain(parentId);
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
      watched: false,
      createdBy: fakePrincipal,
    });
    const scope = await readScopeRawYaml(id);
    expect(scope.created_by).toBe(fakePrincipal);
  });

  it("ADR-137bis: when watched=true, writes `watched: true` on the scope YAML", async () => {
    const root = join(tmp, "host");
    await createHost(root, { name: "Test" });
    await addPrincipal(root, { username: "alice" });
    const rec = await createDocoInHost(root, { ownerSlug: "alice", docoSlug: "demo" });

    const newId = await createScopeInDoco({
      docoDir: rec.path,
      docoId: rec.docoId,
      name: "user-flows",
      watched: true,
      createdBy: null,
    });

    const scope = await readScopeRawYaml(newId);
    expect(scope.watched).toBe(true);
  });

  it("ADR-137bis: when watched=true, the Global scope is NOT mutated (soft signal only)", async () => {
    const root = join(tmp, "host");
    await createHost(root, { name: "Test" });
    await addPrincipal(root, { username: "alice" });
    const rec = await createDocoInHost(root, { ownerSlug: "alice", docoSlug: "demo" });

    const globalBefore = await findScopeRawYamlByName(rec.docoId, "#global");
    expect(globalBefore).not.toBeNull();
    const beforeText = JSON.stringify(globalBefore);

    await createScopeInDoco({
      docoDir: rec.path,
      docoId: rec.docoId,
      name: "bugs",
      watched: true,
      createdBy: null,
    });

    const afterText = JSON.stringify(await findScopeRawYamlByName(rec.docoId, "#global"));
    expect(afterText).toBe(beforeText);
  });

  it("ADR-137bis: when watched=false, no `watched` key is written", async () => {
    const root = join(tmp, "host");
    await createHost(root, { name: "Test" });
    await addPrincipal(root, { username: "alice" });
    const rec = await createDocoInHost(root, { ownerSlug: "alice", docoSlug: "demo" });

    const newId = await createScopeInDoco({
      docoDir: rec.path,
      docoId: rec.docoId,
      name: "bugs",
      watched: false,
      createdBy: null,
    });

    const scope = await readScopeRawYaml(newId);
    expect(scope.watched).toBeUndefined();
  });

  it("ADR-137bis: setScopeWatchedInDoco toggles the flag idempotently", async () => {
    const { setScopeWatchedInDoco } = await import("../host.js");
    const root = join(tmp, "host");
    await createHost(root, { name: "Test" });
    await addPrincipal(root, { username: "alice" });
    const rec = await createDocoInHost(root, { ownerSlug: "alice", docoSlug: "demo" });

    const id = await createScopeInDoco({
      docoDir: rec.path,
      docoId: rec.docoId,
      name: "user-flows",
      watched: false,
      createdBy: null,
    });

    await setScopeWatchedInDoco({ docoDir: rec.path, targetScopeId: id, watched: true });
    let scope = await readScopeRawYaml(id);
    expect(scope.watched).toBe(true);

    // Setting it again should be idempotent (no rev bump expected, but no error).
    await setScopeWatchedInDoco({ docoDir: rec.path, targetScopeId: id, watched: true });

    await setScopeWatchedInDoco({ docoDir: rec.path, targetScopeId: id, watched: false });
    scope = await readScopeRawYaml(id);
    expect(scope.watched).toBeUndefined();
  });

  it("Global is always watched: createDocoInHost seeds the Global scope with watched: true and globe icon", async () => {
    const root = join(tmp, "host");
    await createHost(root, { name: "Test" });
    await addPrincipal(root, { username: "alice" });
    const rec = await createDocoInHost(root, { ownerSlug: "alice", docoSlug: "demo" });

    const globalScope = await findScopeRawYamlByName(rec.docoId, "#global");
    expect(globalScope).not.toBeNull();
    expect(globalScope?.watched).toBe(true);
    expect(globalScope?.icon).toBe("🌐");
  });

  it("Global is always watched: createScopeInDoco forces watched: true when name === '#global'", async () => {
    // Defense-in-depth: even if a caller passes watched: false for a
    // scope named '#global', the YAML must still land as
    // watched: true. (The normal seeding path passes watched: true
    // already; this guards the rare direct-call from a test or
    // bespoke import script.)
    const root = join(tmp, "host");
    await createHost(root, { name: "Test" });
    await addPrincipal(root, { username: "alice" });
    const rec = await createDocoInHost(root, { ownerSlug: "alice", docoSlug: "demo" });

    // Remove the auto-seeded Global scope to free the name slot,
    // then re-create with watched: false to verify the force.
    await withClient(async (c) => {
      await c.query("DELETE FROM scopes WHERE doco_id = $1 AND name = '#global'", [rec.docoId]);
    });
    const newId = await createScopeInDoco({
      docoDir: rec.path,
      docoId: rec.docoId,
      name: "#global",
      watched: false,
      createdBy: null,
    });
    const scope = await readScopeRawYaml(newId);
    expect(scope.watched).toBe(true);
  });

  it("Global is always watched: setScopeWatchedInDoco throws when asked to unwatch the Global scope", async () => {
    const { setScopeWatchedInDoco } = await import("../host.js");
    const root = join(tmp, "host");
    await createHost(root, { name: "Test" });
    await addPrincipal(root, { username: "alice" });
    const rec = await createDocoInHost(root, { ownerSlug: "alice", docoSlug: "demo" });

    // Locate the auto-seeded Global scope's id.
    const global = await findScopeRawYamlByName(rec.docoId, "#global");
    const globalId = global?.id as EntityId<"scope"> | undefined;
    expect(globalId).toBeTruthy();
    if (!globalId) throw new Error("Global scope not found.");

    await expect(
      setScopeWatchedInDoco({
        docoDir: rec.path,
        targetScopeId: globalId,
        watched: false,
      }),
    ).rejects.toThrow(/always watched/i);

    // And the YAML stayed watched: true (no half-write).
    const scope = await readScopeRawYaml(globalId);
    expect(scope.watched).toBe(true);

    // Setting watched: true is a harmless idempotent no-op (no throw).
    await setScopeWatchedInDoco({
      docoDir: rec.path,
      targetScopeId: globalId,
      watched: true,
    });
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
    const franceId = out.byName.get("france");
    const countryId = out.byName.get("country");
    if (!franceId || !countryId) throw new Error("Expected country/france scopes.");
    const france = await readScopeRawYaml(franceId);
    expect(france.scopes).toContain(countryId);
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
      paths: [["#user-flows"]],
      createdBy: null,
      templateForLeaf: (name) => findScopeTemplate(name),
    });
    const userFlowsId = out.byName.get("#user-flows");
    if (!userFlowsId) throw new Error("Expected #user-flows scope.");
    const userFlows = await readScopeRawYaml(userFlowsId);
    expect(userFlows.purpose).toContain("Document end-to-end user journeys");
  });
});

describe("updateScopeInDoco (ADR-084 follow-up)", () => {
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
      watched: false,
      createdBy: null,
    });
    const childId = await createScopeInDoco({
      docoDir: rec.path,
      docoId: rec.docoId,
      name: "france",
      watched: false,
      createdBy: null,
    });
    await updateScopeInDoco({
      docoDir: rec.path,
      scopeId: childId,
      purpose: "France-specific work.",
      guidelines: "Cite Décret laws by article.",
      parentScopes: [parentId],
    });
    const scope = await readScopeRawYaml(childId);
    expect(scope.purpose).toBe("France-specific work.");
    expect(scope.scopes).toContain(parentId);
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
      watched: false,
      createdBy: null,
    });
    await updateScopeInDoco({
      docoDir: rec.path,
      scopeId: id,
      purpose: null,
      guidelines: null,
    });
    const scope = await readScopeRawYaml(id);
    expect(scope.purpose).toBeUndefined();
  });

  // Scope deletion was removed (see rule "scopes-never-deleted"); abandonment
  // happens via `updateScopeInDoco({ lifecycle: 'abandoned' })`. No test
  // for `deleteScopeInDoco` because the helper no longer exists.
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
    await mkdir(join(rec.path, "scopes"), { recursive: true });
    await wf(
      join(rec.path, "scopes", `${legacyId1}.yaml`),
      stringify({
        id: legacyId1,
        doco_id: rec.docoId,
        node_type: "scope",
        purpose: "Scope: country/france/payment",
        name: "country/france/payment",
        created_at: "2026-05-09T00:00:00Z",
        created_by: null,
        lifecycle: "active",
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
        purpose: "Scope: country/france/shipping",
        name: "country/france/shipping",
        created_at: "2026-05-09T00:00:00Z",
        created_by: null,
        lifecycle: "active",
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
