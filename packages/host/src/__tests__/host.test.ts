import { mkdtemp, rm } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withClient } from "@doco/db";
import { type EntityId, generateUlid, makeEntityId } from "@doco/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addOrganization,
  addOrganizationByHandle,
  addPrincipal,
  createDocoInHost,
  createHost,
  detectMode,
  findAvailableOrgHandle,
  listDocos,
  listOrganizations,
  listPrincipals,
  resolveOwnerSlug,
} from "../index.js";

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
    await mkdir(join(docoDir, "states"), { recursive: true });
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

describe("organization handle creation", () => {
  it("scopes v15 organization handle availability to organizations only", async () => {
    const ownerId = makeEntityId("collaborator", generateUlid()) as EntityId<"collaborator">;
    const principalId = makeEntityId("principal", generateUlid()) as EntityId<"principal">;
    const docoId = makeEntityId("doco", generateUlid()) as EntityId<"doco">;
    const handle = "me-torrenegra-com";

    await withClient(async (c) => {
      await c.query(
        `INSERT INTO collaborators (id, kind, github_login, raw_yaml)
         VALUES ($1, 'person', 'owner', $2)`,
        [ownerId, JSON.stringify({ id: ownerId, kind: "person", github_login: "owner" })],
      );
      await c.query(
        `INSERT INTO principals (id, username, raw_yaml)
         VALUES ($1, $2, $3)`,
        [principalId, handle, JSON.stringify({ id: principalId, username: handle })],
      );
      await c.query(
        `INSERT INTO docos (id, handle, owner_id, visibility, raw_yaml)
         VALUES ($1, $2, $3, 'private', $4)`,
        [docoId, handle, ownerId, JSON.stringify({ id: docoId, handle })],
      );
    });

    await expect(findAvailableOrgHandle(handle)).resolves.toBe(handle);

    await expect(
      addOrganizationByHandle({ handle, ownerPrincipalId: ownerId }),
    ).resolves.toMatchObject({ handle });

    await expect(findAvailableOrgHandle(handle)).resolves.toBe(`${handle}-2`);
  });
});
