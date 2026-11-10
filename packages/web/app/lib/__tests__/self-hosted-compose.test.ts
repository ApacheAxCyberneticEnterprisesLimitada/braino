import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "../../../../../");

function runUpgradeWithImage(image: string) {
  const runtime = mkdtempSync(join(tmpdir(), "doco-upgrade-test-"));
  const docker = join(runtime, "docker");
  const log = join(runtime, "docker.log");
  writeFileSync(
    docker,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$DOCO_DOCKER_LOG"
if [ "$*" = "compose config --images" ]; then
  printf '%s\\n' qdrant/qdrant:v1.20.0 "$FAKE_APP_IMAGE" postgres:16.10-bookworm
elif [ "$*" = "compose config --format json" ]; then
  cat <<EOF
{
  "services": {
    "app": {
      "image": "$FAKE_APP_IMAGE"
    }
  }
}
EOF
fi
`,
  );
  chmodSync(docker, 0o755);

  try {
    const result = spawnSync(resolve(root, "doco"), ["upgrade"], {
      cwd: runtime,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${runtime}:${process.env.PATH ?? ""}`,
        DOCO_DOCKER_LOG: log,
        FAKE_APP_IMAGE: image,
        DOCO_ENCRYPTION_KEY: "test-encryption-key-with-thirty-two-characters",
        DOCO_POSTGRES_PASSWORD: "test-postgres-password",
        DOCO_SETUP_TOKEN: "test-setup-token",
      },
    });
    return { ...result, calls: readFileSync(log, "utf8") };
  } finally {
    rmSync(runtime, { recursive: true, force: true });
  }
}

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
    expect(compose.services.app?.ports).toEqual(["127.0.0.1:${DOCO_HTTP_PORT:-3000}:3000"]);
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
    const dockerignore = readFileSync(resolve(root, ".dockerignore"), "utf8");

    expect(env).toContain("DOCO_ENCRYPTION_KEY=");
    expect(env).toContain("DOCO_POSTGRES_PASSWORD=");
    expect(env).toContain("DOCO_SETUP_TOKEN=");
    expect(dockerfile).toContain("pnpm --filter @doco/web build");
    expect(dockerfile).toContain("USER node");
    expect(dockerignore).toContain(".env*");
    expect(dockerignore).toContain("!.env.example");
    expect(dockerignore).toContain("backups");
    expect(dockerignore).toContain("*.tar.gz");
  });

  it("fails CI on high or critical dependency advisories", () => {
    const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const workflow = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");

    expect(packageJson.scripts.audit).toBe("pnpm audit --audit-level high");
    expect(workflow).toContain("pnpm run audit");
  });

  it("pins every workflow action to an immutable commit", () => {
    for (const name of ["ci.yml", "release.yml"]) {
      const workflow = readFileSync(resolve(root, ".github/workflows", name), "utf8");
      const actions = [...workflow.matchAll(/uses:\s+(\S+)/g)].map((match) => match[1]);
      expect(actions.length).toBeGreaterThan(0);
      expect(actions, name).toEqual(
        actions.map((action) => expect.stringMatching(/@[0-9a-f]{40}$/)),
      );
    }
  });

  it("keeps pinned workflow actions on an automated update path", () => {
    const dependabot = parse(readFileSync(resolve(root, ".github/dependabot.yml"), "utf8")) as {
      updates: Array<Record<string, unknown>>;
    };

    expect(dependabot.updates).toContainEqual(
      expect.objectContaining({ "package-ecosystem": "github-actions", directory: "/" }),
    );
  });

  it("ships executable backup, restore, preflight, and upgrade commands", () => {
    const commandPath = resolve(root, "doco");
    const command = readFileSync(commandPath, "utf8");
    const readme = readFileSync(resolve(root, "README.md"), "utf8");

    expect(statSync(commandPath).mode & 0o111).not.toBe(0);
    expect(command).toContain("pg_dump");
    expect(command).toContain("pg_restore");
    expect(command).toContain("DROP DATABASE doco WITH (FORCE)");
    expect(command).toContain("CREATE DATABASE doco OWNER doco");
    expect(command).not.toContain("--clean");
    expect(command).toContain("doctor)");
    expect(command).toContain("upgrade)");
    expect(command.indexOf("compose stop app")).toBeLessThan(
      command.indexOf("node_modules/@doco/db/dist/migrate.js"),
    );
    expect(command).toContain("node_modules/@doco/db/dist/migrate.js");
    expect(command).toContain("/qdrant/storage");
    expect(readme).toContain("./doco backup");
    expect(readme).toContain("./doco restore");
    expect(readme).toContain("./doco upgrade");
  });

  it("applies ordered migrations before the web server accepts traffic", () => {
    const webPackage = JSON.parse(
      readFileSync(resolve(root, "packages/web/package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(webPackage.scripts.start).toMatch(
      /^node node_modules\/@doco\/db\/dist\/migrate\.js && react-router-serve/,
    );
  });

  it("refuses to upgrade a local app image regardless of Compose image order", () => {
    const result = runUpgradeWithImage("doco:local");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Set DOCO_IMAGE to a released");
    expect(result.stdout).not.toContain("Backup written");
    expect(result.calls).not.toContain("compose pull");
  });

  it("reports and migrates the configured released app image", () => {
    const image = "ghcr.io/brainoinc/braino:0.1.0";
    const result = runUpgradeWithImage(image);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Upgrade completed with ${image}`);
    expect(result.calls).toContain("compose pull");
    expect(result.calls).toContain("node_modules/@doco/db/dist/migrate.js");
  });

  it("publishes signed AMD64 and ARM64 images from version tags", () => {
    const workflow = readFileSync(resolve(root, ".github/workflows/release.yml"), "utf8");

    expect(workflow).toContain("linux/amd64,linux/arm64");
    expect(workflow).toContain("type=ref,event=tag");
    expect(workflow).toContain("provenance: mode=max");
    expect(workflow).toContain("sbom: true");
    expect(workflow).toContain("cosign sign --yes");
  });

  it("gates releases on the executable v0.1 conformance contract", () => {
    const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const script = readFileSync(resolve(root, "scripts/conformance.sh"), "utf8");
    const workflow = readFileSync(resolve(root, ".github/workflows/release.yml"), "utf8");
    const contract = readFileSync(resolve(root, "docs/v0.1-conformance.md"), "utf8");

    expect(packageJson.scripts.conformance).toBe("bash scripts/conformance.sh");
    for (const proof of [
      "single-workspace.real-db.test.ts",
      "collaborators.real-db.test.ts",
      "changesets.real-db.test.ts",
      "workspace-search.real-db.test.ts",
      "mcp-core.real-db.test.ts",
      "incoming-webhooks.real-db.test.ts",
      "github-connections.real-db.test.ts",
      "schema-apply-once.test.ts",
      "self-hosted-compose.test.ts",
      "design-language.test.ts",
    ]) {
      expect(script).toContain(proof);
      expect(contract).toContain(proof);
    }
    expect(script).toContain("docker compose");
    expect(script).toContain("doco_records");
    expect(script).toContain("/collections/doco_records");
    expect(script).toContain("./doco backup");
    expect(script).toContain("./doco restore");
    expect(script).toContain("600");
    expect(workflow.indexOf("pnpm conformance")).toBeGreaterThan(0);
    expect(workflow.indexOf("pnpm conformance")).toBeLessThan(
      workflow.indexOf("docker/build-push-action"),
    );
  });
});
