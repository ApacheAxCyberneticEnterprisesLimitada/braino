import { readFileSync } from "node:fs";
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
});
