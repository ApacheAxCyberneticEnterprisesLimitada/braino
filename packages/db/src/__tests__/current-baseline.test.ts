import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const dbRoot = join(here, "..", "..");
const schemaSql = readFileSync(join(here, "..", "schema.sql"), "utf8");

function tableBlock(table: string): string {
  const match = schemaSql.match(
    new RegExp(
      `CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${table}\\s*\\(([\\s\\S]*?)\\);`,
      "i",
    ),
  );
  if (!match?.[1]) throw new Error(`Could not locate CREATE TABLE ${table}`);
  return match[1].replace(/--[^\n]*/g, "");
}

describe("current database baseline", () => {
  it("does not bundle historical SQL migrations", () => {
    const migrationsDir = join(dbRoot, "migrations");
    const migrations = existsSync(migrationsDir)
      ? readdirSync(migrationsDir)
          .filter((name) => /^\d{3,}_[a-z0-9_]+\.sql$/i.test(name))
          .sort()
      : [];

    expect(migrations).toEqual([]);
    expect(schemaSql).not.toMatch(/\bapplied_migrations\b/);
  });

  it("keeps users as human OAuth identities, not agent-user records", () => {
    const users = tableBlock("users");

    expect(users).not.toMatch(/\bkind\b/);
    expect(users).not.toMatch(/\bowner_id\b/);
    expect(schemaSql).not.toMatch(/\busers_kind_idx\b/);
    expect(schemaSql).not.toMatch(/\busers_owner_idx\b/);
  });

  it("stores chat Doco attachments by stable ids only", () => {
    const chatConversations = tableBlock("chat_conversations");

    expect(chatConversations).toMatch(/\battached_doco_ids\b/);
    expect(chatConversations).not.toMatch(/\battached_doco_handles\b/);
  });

  it("keeps schema comments focused on the current architecture", () => {
    expect(schemaSql).not.toMatch(/\bmigration[- ]\d{3}\b/i);
    expect(schemaSql).not.toMatch(/\b(previous|legacy|post-migration|pre-migration|doco-vnext)\b/i);
  });
});
