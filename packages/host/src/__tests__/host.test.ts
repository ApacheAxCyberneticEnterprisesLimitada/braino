import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addOrganization,
  addPrincipal,
  createEvaloInHost,
  createHost,
  detectMode,
  listEvalos,
  listOrganizations,
  listPrincipals,
  resolveOwnerSlug,
} from "../index.js";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "evalo-host-"));
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

  it("creates an Evalo owned by a Principal (user-owned)", async () => {
    const root = join(tmp, "host");
    await createHost(root, { name: "Test" });
    await addPrincipal(root, { username: "alice" });
    const rec = await createEvaloInHost(root, { ownerSlug: "alice", evaloSlug: "my-evalo" });
    expect(rec.ownerKind).toBe("principal");
    expect(rec.evaloId).toMatch(/^evalo_/);
    expect(rec.path.endsWith("evalos/alice/my-evalo")).toBe(true);
  });

  it("creates an Evalo owned by an Organization (org-owned)", async () => {
    const root = join(tmp, "host");
    await createHost(root, { name: "Test" });
    await addPrincipal(root, { username: "alice" });
    await addOrganization(root, { slug: "anthropic", ownerUsername: "alice" });
    const rec = await createEvaloInHost(root, {
      ownerSlug: "anthropic",
      evaloSlug: "internal-policies",
    });
    expect(rec.ownerKind).toBe("organization");
    expect(rec.ownerId).toMatch(/^organization_/);
  });

  it("listEvalos returns both user-owned and org-owned", async () => {
    const root = join(tmp, "host");
    await createHost(root, { name: "Test" });
    await addPrincipal(root, { username: "alice" });
    await addOrganization(root, { slug: "anthropic", ownerUsername: "alice" });
    await createEvaloInHost(root, { ownerSlug: "alice", evaloSlug: "personal" });
    await createEvaloInHost(root, { ownerSlug: "anthropic", evaloSlug: "shared" });
    const list = await listEvalos(root);
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
