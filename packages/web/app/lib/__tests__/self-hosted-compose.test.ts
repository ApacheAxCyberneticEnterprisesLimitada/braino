import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "../../../../../");

function runUpgradeWithImages(
  appImage: string,
  codeLinkerImage = "ghcr.io/brainoinc/braino-codelinker:0.1.14",
  pluginHostImage = "ghcr.io/brainoinc/braino-plugin-host:0.1.14",
) {
  const runtime = mkdtempSync(join(tmpdir(), "doco-upgrade-test-"));
  const docker = join(runtime, "docker");
  const log = join(runtime, "docker.log");
  writeFileSync(
    docker,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$DOCO_DOCKER_LOG"
if [ "$*" = "compose config --images" ]; then
  printf '%s\\n' qdrant/qdrant:v1.20.0 "$FAKE_APP_IMAGE" "$FAKE_CODELINKER_IMAGE" "$FAKE_PLUGIN_HOST_IMAGE" postgres:16.10-bookworm
elif [ "$*" = "compose config --format json" ]; then
  cat <<EOF
{
  "services": {
    "app": {
      "image": "$FAKE_APP_IMAGE"
    },
    "codelinker": {
      "image": "$FAKE_CODELINKER_IMAGE"
    },
    "plugin-host": {
      "image": "$FAKE_PLUGIN_HOST_IMAGE"
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
        FAKE_APP_IMAGE: appImage,
        FAKE_CODELINKER_IMAGE: codeLinkerImage,
        FAKE_PLUGIN_HOST_IMAGE: pluginHostImage,
        DOCO_ENCRYPTION_KEY: "test-encryption-key-with-thirty-two-characters",
        DOCO_POSTGRES_PASSWORD: "test-postgres-password",
        BRAINO_SETUP_TOKEN: "test-setup-token",
        BRAINO_CODELINKER_API_TOKEN: "test-codelinker-token-with-thirty-two-characters",
        BRAINO_PLUGIN_HOST_API_TOKEN: "test-plugin-host-token-with-thirty-two-characters",
      },
    });
    return { ...result, calls: readFileSync(log, "utf8") };
  } finally {
    rmSync(runtime, { recursive: true, force: true });
  }
}

describe("the supported self-hosted stack", () => {
  it("boots one app with durable PostgreSQL and Qdrant services", () => {
    const compose = parse(readFileSync(resolve(root, "compose.yml"), "utf8"), { merge: true }) as {
      services: Record<string, Record<string, unknown>>;
      volumes: Record<string, unknown>;
    };

    expect(Object.keys(compose.services)).toEqual([
      "app",
      "scheduler",
      "codelinker",
      "plugin-host",
      "postgres",
      "qdrant",
      "caddy",
    ]);
    expect(compose.services.app?.build).toEqual(
      expect.objectContaining({ dockerfile: "Dockerfile" }),
    );
    expect(compose.services.scheduler?.image).toBe(compose.services.app?.image);
    expect(compose.services.scheduler?.build).toEqual(compose.services.app?.build);
    expect(compose.services.scheduler?.command).toEqual(["node", "runtime/scheduler.mjs"]);
    expect(compose.services.scheduler?.depends_on).toEqual({
      app: { condition: "service_healthy" },
    });
    // The image's healthcheck asks the web server, which the scheduler doesn't
    // run: inherited, it marks the scheduler unhealthy and fails
    // `docker compose up --wait`, as it failed every release since #53.
    expect(compose.services.scheduler?.healthcheck).toEqual({ disable: true });
    expect(compose.services.app?.depends_on).toEqual(
      expect.objectContaining({
        codelinker: expect.any(Object),
        "plugin-host": expect.any(Object),
        postgres: expect.any(Object),
        qdrant: expect.any(Object),
      }),
    );
    expect(compose.services.codelinker?.build).toEqual(
      expect.objectContaining({ dockerfile: "services/codelinker/Dockerfile" }),
    );
    expect(compose.services.codelinker?.read_only).toBe(true);
    expect(compose.services.codelinker?.cap_drop).toEqual(["ALL"]);
    expect(compose.services.codelinker?.ports).toBeUndefined();
    expect(compose.services["plugin-host"]?.build).toEqual(
      expect.objectContaining({ dockerfile: "services/plugin-host/Dockerfile" }),
    );
    expect(compose.services["plugin-host"]?.read_only).toBe(true);
    expect(compose.services["plugin-host"]?.cap_drop).toEqual(["ALL"]);
    expect(compose.services["plugin-host"]?.ports).toBeUndefined();
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
    const runtimeStage = dockerfile.split(" AS runtime")[1] ?? "";

    expect(env).toContain("DOCO_ENCRYPTION_KEY=");
    expect(env).toContain("DOCO_POSTGRES_PASSWORD=");
    expect(env).toContain("BRAINO_SETUP_TOKEN=");
    expect(env).toContain("BRAINO_CODELINKER_API_TOKEN=");
    expect(env).toContain("BRAINO_PLUGIN_HOST_API_TOKEN=");
    expect(dockerfile).toContain("pnpm --filter @doco/web build");
    expect(runtimeStage).toContain("ARG DOCO_VERSION");
    expect(runtimeStage).toContain("ENV DOCO_VERSION=$DOCO_VERSION");
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
    for (const directory of [
      "/services/codelinker",
      "/services/plugin-host",
      "/services/plugin-host/fixtures/echo-plugin",
    ]) {
      expect(dependabot.updates).toContainEqual(
        expect.objectContaining({ "package-ecosystem": "cargo", directory }),
      );
    }
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
    expect(command).toContain("BRAINO_CODELINKER_API_TOKEN");
    expect(command).toContain("BRAINO_PLUGIN_HOST_API_TOKEN");
    expect(command.indexOf("compose stop app")).toBeLessThan(
      command.indexOf("node_modules/@doco/db/dist/migrate.js"),
    );
    expect(command).toContain("node_modules/@doco/db/dist/migrate.js");
    expect(command).toContain("compose stop app scheduler codelinker plugin-host qdrant");
    expect(command).toContain("compose stop app scheduler");
    expect(command).toContain("/qdrant/storage");
    expect(readme).toContain("./doco backup");
    expect(readme).toContain("./doco restore");
    expect(readme).toContain("./doco upgrade");
  });

  it("applies ordered migrations before the web server accepts traffic", () => {
    const webPackage = JSON.parse(
      readFileSync(resolve(root, "packages/web/package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(webPackage.scripts.start).toBe(
      "node node_modules/@doco/db/dist/migrate.js && node server.mjs",
    );
  });

  it("preserves the public HTTPS origin behind the bundled reverse proxy", () => {
    const serverModule = pathToFileURL(resolve(root, "packages/web/server.mjs")).href;
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
          import express from "express";
          import { trustSingleProxy } from ${JSON.stringify(serverModule)};

          const app = express();
          trustSingleProxy(app);
          app.post("/", (request, response) => {
            response.send(new URL(request.originalUrl, \`${"${request.protocol}"}://${"${request.hostname}"}\`).origin);
          });
          const server = app.listen(0, "127.0.0.1", async () => {
            const address = server.address();
            const response = await fetch(\`http://127.0.0.1:${"${address.port}"}/\`, {
              method: "POST",
              headers: {
                Host: "meta.braino.dev",
                "X-Forwarded-Host": "meta.braino.dev",
                "X-Forwarded-Proto": "https",
              },
            });
            console.log(await response.text());
            server.close();
          });
        `,
      ],
      { cwd: resolve(root, "packages/web"), encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("https://meta.braino.dev");
  });

  it("refuses to upgrade a local app image regardless of Compose image order", () => {
    const result = runUpgradeWithImages("doco:local");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Set DOCO_IMAGE to a released");
    expect(result.stdout).not.toContain("Backup written");
    expect(result.calls).not.toContain("compose pull");
  });

  it("refuses to upgrade a local CodeLinker image", () => {
    const result = runUpgradeWithImages(
      "ghcr.io/brainoinc/braino:0.1.14",
      "braino-codelinker:local",
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Set BRAINO_CODELINKER_IMAGE to a released");
    expect(result.stdout).not.toContain("Backup written");
    expect(result.calls).not.toContain("compose pull");
  });

  it("refuses to upgrade a local plugin host image", () => {
    const result = runUpgradeWithImages(
      "ghcr.io/brainoinc/braino:0.1.14",
      "ghcr.io/brainoinc/braino-codelinker:0.1.14",
      "braino-plugin-host:local",
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Set BRAINO_PLUGIN_HOST_IMAGE to a released");
    expect(result.stdout).not.toContain("Backup written");
    expect(result.calls).not.toContain("compose pull");
  });

  it("reports and migrates the configured released app image", () => {
    const image = "ghcr.io/brainoinc/braino:0.1.0";
    const result = runUpgradeWithImages(image);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Upgrade completed with ${image}`);
    expect(result.stdout).toContain("ghcr.io/brainoinc/braino-codelinker:0.1.14");
    expect(result.stdout).toContain("ghcr.io/brainoinc/braino-plugin-host:0.1.14");
    expect(result.calls).toContain("compose pull");
    expect(result.calls).toContain("node_modules/@doco/db/dist/migrate.js");
  });

  // Alexander, 2026-11-11: agents can't push tags, so a version bump merged to
  // main releases itself; nobody pushes a v* tag by hand.
  it("releases each version bump merged to main, once", () => {
    const workflow = readFileSync(resolve(root, ".github/workflows/release.yml"), "utf8");

    expect(workflow).toMatch(/on:\n {2}push:\n {4}branches: \[main\]\n/);
    expect(workflow).not.toMatch(/tags: \[/);
    expect(workflow).toContain('TAG="v$(jq -r .version package.json)"');
    expect(workflow).toContain('git ls-remote --exit-code --tags origin "refs/tags/$TAG"');
    expect(workflow).toContain("if: needs.version.outputs.unreleased == 'true'");
    expect(workflow).toContain(
      'gh release create "$TAG" release-packages/*.tgz --target "$GITHUB_SHA"',
    );
    expect(workflow).toContain("cancel-in-progress: false");
  });

  it("publishes signed AMD64 and ARM64 images tagged with the release's version", () => {
    const workflow = readFileSync(resolve(root, ".github/workflows/release.yml"), "utf8");

    expect(workflow).toContain("linux/amd64,linux/arm64");
    expect(workflow).toContain(
      "type=semver,pattern={{version}},value=${{ needs.version.outputs.tag }}",
    );
    expect(workflow).toContain("type=raw,value=latest");
    expect(workflow).toContain("DOCO_VERSION=${{ needs.version.outputs.tag }}");
    expect(workflow).toContain("provenance: mode=max");
    expect(workflow).toContain("sbom: true");
    expect(workflow).toContain("cosign sign --yes");
    expect(workflow).toContain("ghcr.io/${GITHUB_REPOSITORY_OWNER,,}/braino-codelinker");
    expect(workflow).toContain("ghcr.io/${GITHUB_REPOSITORY_OWNER,,}/braino-plugin-host");
    expect(workflow).toContain("services/codelinker/Dockerfile");
    expect(workflow).toContain("services/plugin-host/Dockerfile");
    expect(workflow.match(/cosign sign --yes/g)).toHaveLength(3);
  });

  it("tests the separately versioned Rust services in the required CI gate", () => {
    const workflow = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
    const releaseVersion = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      version: string;
    };

    for (const [service, name] of [
      ["codelinker", "braino-codelinker"],
      ["plugin-host", "braino-plugin-host"],
    ]) {
      const manifest = readFileSync(resolve(root, `services/${service}/Cargo.toml`), "utf8");
      expect(manifest).toContain(`name = "${name}"`);
      expect(manifest).toContain(`version = "${releaseVersion.version}"`);
      expect(workflow).toContain(
        `cargo fmt --check --manifest-path services/${service}/Cargo.toml`,
      );
      expect(workflow).toContain(
        `cargo test --locked --manifest-path services/${service}/Cargo.toml`,
      );
      expect(workflow).toContain(
        `cargo clippy --locked --manifest-path services/${service}/Cargo.toml`,
      );
    }
    expect(workflow).toContain("rustup target add wasm32-wasip2");
    expect(workflow).toContain("services/plugin-host/fixtures/echo-plugin/Cargo.toml");
  });

  it("publishes every versioned core package beside each release image", () => {
    const rootPackage = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      version: string;
    };
    const workflow = readFileSync(resolve(root, ".github/workflows/release.yml"), "utf8");

    for (const name of ["shared", "plugin-runtime", "db", "index", "host", "connector-plugins"]) {
      const packageJson = JSON.parse(
        readFileSync(resolve(root, `packages/${name}/package.json`), "utf8"),
      ) as { name: string; private?: boolean; version: string };

      expect(packageJson.private, packageJson.name).not.toBe(true);
      expect(packageJson.version, packageJson.name).toBe(rootPackage.version);
      expect(workflow).toContain(`pnpm --filter ${packageJson.name} pack`);
    }
    expect(workflow).toContain("node scripts/verify-release-packages.mjs release-packages");
    expect(workflow).toContain('gh release create "$TAG" release-packages/*.tgz');
    expect(workflow).not.toContain("--clobber");
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
      "workspace-admin.real-db.test.ts",
      "times.real-db.test.ts",
      "collaborators.real-db.test.ts",
      "changesets.real-db.test.ts",
      "workspace-search.real-db.test.ts",
      "mcp-core.real-db.test.ts",
      "incoming-webhooks.real-db.test.ts",
      "github-connections.real-db.test.ts",
      "schema-apply-once.test.ts",
      "self-hosted-compose.test.ts",
      "design-language.test.ts",
      "admin-console.test.ts",
    ]) {
      expect(script).toContain(proof);
      expect(contract).toContain(proof);
    }
    expect(script).toContain("docker compose");
    expect(script).toContain("http://codelinker:8080/healthz");
    expect(script).toContain("http://plugin-host:8080/healthz");
    expect(script).toContain("doco_records");
    expect(script).toContain("/collections/doco_records");
    expect(script).toContain('"$origin/admin"');
    expect(script).toContain('"$origin/times"');
    expect(script).toContain("./doco backup");
    expect(script).toContain("./doco restore");
    expect(script).toContain("600");
    expect(workflow.indexOf("pnpm conformance")).toBeGreaterThan(0);
    expect(workflow.indexOf("pnpm conformance")).toBeLessThan(
      workflow.indexOf("docker/build-push-action"),
    );
  });
});
