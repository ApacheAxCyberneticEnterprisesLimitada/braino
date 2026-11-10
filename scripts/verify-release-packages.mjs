import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";

const PACKAGE_NAMES = ["shared", "db", "index", "host", "connector-plugins"];
const root = resolve(import.meta.dirname, "..");
const releaseDir = resolve(process.argv[2] ?? resolve(root, "release-packages"));
const { version } = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const tarballs = PACKAGE_NAMES.map((name) => resolve(releaseDir, `doco-${name}-${version}.tgz`));
const smokeDir = mkdtempSync(resolve(tmpdir(), "braino-package-smoke-"));

try {
  const overrides = Object.fromEntries(
    PACKAGE_NAMES.map((name, index) => [`@doco/${name}`, `file:${tarballs[index]}`]),
  );
  writeFileSync(
    resolve(smokeDir, "package.json"),
    `${JSON.stringify({ private: true, pnpm: { overrides } }, null, 2)}\n`,
  );

  const install = spawnSync("pnpm", ["add", ...tarballs], {
    cwd: smokeDir,
    encoding: "utf8",
  });
  if (install.status !== 0) {
    process.stderr.write(install.stdout);
    process.stderr.write(install.stderr);
    process.exit(install.status ?? 1);
  }

  const imports = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `await Promise.all(${JSON.stringify([...PACKAGE_NAMES.map((name) => `@doco/${name}`), "@doco/db/schema", "@doco/db/test-support"])}.map((name) => import(name)))`,
    ],
    { cwd: smokeDir, encoding: "utf8" },
  );
  if (imports.status !== 0) {
    process.stderr.write(imports.stdout);
    process.stderr.write(imports.stderr);
    process.exit(imports.status ?? 1);
  }

  console.log(
    `Verified ${tarballs.map((tarball) => basename(tarball)).join(", ")} as one installable release.`,
  );
} finally {
  rmSync(smokeDir, { recursive: true, force: true });
}
