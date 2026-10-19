import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import pg from "pg";
import {
  type RetrievalSnapshot,
  exportRetrievalSnapshot,
  restoreRetrievalSnapshot,
} from "../src/retrieval-snapshot.js";
import { SCHEMA_SQL } from "../src/schema-embedded.js";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

function usage(): never {
  throw new Error(`Usage:
  pnpm eval:corpus export --doco <id-or-handle> [--out .doco/snapshots/name.json.gz] [--app-revision <sha>]
  pnpm eval:corpus restore --in <snapshot.json.gz> [--grant-user <local-github-login>]

Environment:
  export reads DOCO_SNAPSHOT_SOURCE_DATABASE_URL
  restore reads DOCO_SNAPSHOT_TARGET_DATABASE_URL (loopback/local targets only)`);
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assertLocalTarget(connectionString: string): void {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("DOCO_SNAPSHOT_TARGET_DATABASE_URL must be a PostgreSQL URL");
  }
  const localHosts = new Set(["", "localhost", "127.0.0.1", "[::1]", "::1"]);
  if (!localHosts.has(url.hostname)) {
    throw new Error(
      `refusing to restore into non-local host ${url.hostname}; snapshots restore only to an isolated local database`,
    );
  }
}

function safeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "doco";
}

async function writeSnapshot(path: string, snapshot: RetrievalSnapshot): Promise<void> {
  const json = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`);
  const bytes = path.endsWith(".gz") ? await gzipAsync(json) : json;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
}

async function readSnapshot(path: string): Promise<RetrievalSnapshot> {
  const bytes = await readFile(path);
  const json = path.endsWith(".gz") ? await gunzipAsync(bytes) : bytes;
  return JSON.parse(json.toString("utf8")) as RetrievalSnapshot;
}

async function exportCommand(args: string[]): Promise<void> {
  const doco = option(args, "--doco");
  if (!doco) usage();
  const pool = new pg.Pool({
    connectionString: requiredEnv("DOCO_SNAPSHOT_SOURCE_DATABASE_URL"),
    max: 1,
  });
  const client = await pool.connect();
  try {
    const snapshot = await exportRetrievalSnapshot(client, doco, {
      appRevision:
        option(args, "--app-revision") ??
        process.env.VERCEL_GIT_COMMIT_SHA ??
        process.env.GITHUB_SHA ??
        null,
    });
    const defaultName = `${safeFilename(snapshot.manifest.docoHandle)}-${snapshot.manifest.digest.slice(0, 12)}.json.gz`;
    const output = resolve(option(args, "--out") ?? `.doco/snapshots/${defaultName}`);
    await writeSnapshot(output, snapshot);
    process.stdout.write(
      `${JSON.stringify(
        {
          operation: "export",
          output,
          docoId: snapshot.manifest.docoId,
          digest: snapshot.manifest.digest,
          modelIds: snapshot.manifest.modelIds,
          rowCounts: snapshot.manifest.rowCounts,
          credentialsIncluded: false,
          warning: "The file contains production knowledge and must remain local.",
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    client.release();
    await pool.end();
  }
}

async function localUserId(client: pg.PoolClient, githubLogin: string): Promise<string> {
  const user = await client.query<{ id: string }>(
    "SELECT id FROM users WHERE lower(github_login) = lower($1) LIMIT 1",
    [githubLogin],
  );
  const userId = user.rows[0]?.id;
  if (!userId) throw new Error(`local user ${githubLogin} was not found; sign in locally first`);
  return userId;
}

async function grantLocalUser(
  client: pg.PoolClient,
  snapshot: RetrievalSnapshot,
  userId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO workspace_users (workspace_id, user_id, role, write_types)
     VALUES ($1, $2, 'owner', ARRAY['*']::text[])
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = 'owner', write_types = ARRAY['*']::text[]`,
    [snapshot.manifest.workspaceId, userId],
  );
}

async function restoreCommand(args: string[]): Promise<void> {
  const inputArg = option(args, "--in");
  if (!inputArg) usage();
  const input = resolve(inputArg);
  const connectionString = requiredEnv("DOCO_SNAPSHOT_TARGET_DATABASE_URL");
  assertLocalTarget(connectionString);
  const snapshot = await readSnapshot(input);
  const pool = new pg.Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  try {
    await client.query(SCHEMA_SQL);
    const grantUser = option(args, "--grant-user");
    const grantUserId = grantUser ? await localUserId(client, grantUser) : null;
    const result = await restoreRetrievalSnapshot(client, snapshot);
    if (grantUserId) await grantLocalUser(client, snapshot, grantUserId);
    process.stdout.write(
      `${JSON.stringify(
        {
          operation: "restore",
          input,
          ...result,
          parityVerified: true,
          grantedTo: grantUser ?? null,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    client.release();
    await pool.end();
  }
}

const [command, ...args] = process.argv.slice(2);
if (command === "export") await exportCommand(args);
else if (command === "restore") await restoreCommand(args);
else usage();
