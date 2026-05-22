import { closePool, withClient } from "@doco/db";
import pg from "pg";
import { afterAll, beforeAll, beforeEach } from "vitest";

const { Client } = pg;

const DEFAULT_DATABASE_URL = "postgres://postgres:doco@127.0.0.1:5433/doco";
const TEST_DB_PREFIX = "doco_host_test_";

let testDatabaseName: string | null = null;
let adminDatabaseUrl: string | null = null;

function databaseUrlFor(name: string): string {
  const base = new URL(
    process.env.DOCO_TEST_ADMIN_DATABASE_URL ??
      process.env.DOCO_DATABASE_URL ??
      process.env.DATABASE_URL ??
      DEFAULT_DATABASE_URL,
  );
  base.pathname = `/${name}`;
  base.search = "";
  return base.toString();
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new Error(`Unsafe test database identifier: ${value}`);
  }
  return `"${value}"`;
}

async function withAdminClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: adminDatabaseUrl ?? databaseUrlFor("postgres") });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  const dbName = `${TEST_DB_PREFIX}${process.pid}_${Date.now()}`;
  testDatabaseName = dbName;
  adminDatabaseUrl = databaseUrlFor("postgres");
  await withAdminClient(async (client) => {
    await client.query(`CREATE DATABASE ${quoteIdentifier(dbName)}`);
  });
  process.env.DOCO_DATABASE_URL = databaseUrlFor(dbName);
  await withClient(async () => undefined);
});

beforeEach(async () => {
  await withClient(async (client) => {
    await client.query(
      `TRUNCATE
        hosts,
        principals,
        organizations,
        org_users,
        docos,
        intents,
        decisions,
        rules,
        guidance_primitives,
        neuron_authoring_primitives,
        actions,
        logs,
        evals,
        states,
        tags,
        ideas,
        reference_entities,
        audit_events,
        synapses,
        embeddings,
        entity_fts,
        doco_users,
        tokens_blob
      RESTART IDENTITY CASCADE`,
    );
  });
});

afterAll(async () => {
  if (!testDatabaseName || !adminDatabaseUrl) return;
  await closePool();
  const dbName = testDatabaseName;
  await withAdminClient(async (client) => {
    await client.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1",
      [dbName],
    );
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(dbName)}`);
  });
});
