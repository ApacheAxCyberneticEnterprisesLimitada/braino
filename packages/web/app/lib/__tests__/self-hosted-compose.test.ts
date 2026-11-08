import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "../../../../../");

describe("the supported self-hosted stack", () => {
  it("boots one app with durable PostgreSQL and Qdrant services", () => {
    const compose = parse(readFileSync(resolve(root, "compose.yml"), "utf8")) as {
      services: Record<string, Record<string, unknown>>;
      volumes: Record<string, unknown>;
    };

    expect(Object.keys(compose.services)).toEqual(["app", "postgres", "qdrant", "caddy"]);
    expect(compose.services.app?.build).toEqual(
      expect.objectContaining({ dockerfile: "Dockerfile" }),
    );
    expect(compose.services.app?.depends_on).toEqual(
      expect.objectContaining({ postgres: expect.any(Object), qdrant: expect.any(Object) }),
    );
    expect(compose.services.postgres?.ports).toBeUndefined();
    expect(compose.services.qdrant?.ports).toBeUndefined();
    expect(compose.services.caddy?.profiles).toEqual(["tls"]);
    expect(Object.keys(compose.volumes)).toEqual([
      "doco-postgres",
      "doco-qdrant",
      "doco-caddy-data",
      "doco-caddy-config",
    ]);
  });

  it("documents the required secrets and builds a non-root web image", () => {
    const env = readFileSync(resolve(root, ".env.example"), "utf8");
    const dockerfile = readFileSync(resolve(root, "Dockerfile"), "utf8");

    expect(env).toContain("DOCO_ENCRYPTION_KEY=");
    expect(env).toContain("DOCO_POSTGRES_PASSWORD=");
    expect(dockerfile).toContain("pnpm --filter @doco/web build");
    expect(dockerfile).toContain("USER node");
  });

  it("ships executable backup, restore, preflight, and upgrade commands", () => {
    const commandPath = resolve(root, "doco");
    const command = readFileSync(commandPath, "utf8");
    const readme = readFileSync(resolve(root, "README.md"), "utf8");

    expect(statSync(commandPath).mode & 0o111).not.toBe(0);
    expect(command).toContain("pg_dump");
    expect(command).toContain("pg_restore");
    expect(command).toContain("doctor)");
    expect(command).toContain("upgrade)");
    expect(command).toContain("/qdrant/storage");
    expect(readme).toContain("./doco backup");
    expect(readme).toContain("./doco restore");
    expect(readme).toContain("./doco upgrade");
  });

  it("publishes signed AMD64 and ARM64 images from version tags", () => {
    const workflow = readFileSync(resolve(root, ".github/workflows/release.yml"), "utf8");

    expect(workflow).toContain("linux/amd64,linux/arm64");
    expect(workflow).toContain("type=ref,event=tag");
    expect(workflow).toContain("provenance: mode=max");
    expect(workflow).toContain("sbom: true");
    expect(workflow).toContain("cosign sign --yes");
  });
});
