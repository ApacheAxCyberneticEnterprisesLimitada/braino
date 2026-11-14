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
  it("ships one current baseline plus ordered forward migrations", () => {
    const migrationsDir = join(dbRoot, "migrations");
    const migrations = existsSync(migrationsDir)
      ? readdirSync(migrationsDir)
          .filter((name) => /^\d{3,}_[a-z0-9_]+\.sql$/i.test(name))
          .sort()
      : [];

    expect(migrations).toEqual([
      "001_github_operation_lease.sql",
      "002_braino_product_identity.sql",
      "003_runtime_compatibility.sql",
      "004_nps_surveys.sql",
      "005_leads.sql",
      "006_github_codebase.sql",
      "007_braino_times.sql",
      "008_mcp_oauth_resource.sql",
      "009_retire_unseen_work.sql",
      "010_retrieval_relations_long_facts.sql",
      "011_hook_copies.sql",
      "012_plugin_installations.sql",
      "013_plugin_secrets.sql",
      "014_plugin_artifacts.sql",
      "015_unretire_rewritten_logs.sql",
    ]);
    expect(schemaSql).not.toMatch(/\bapplied_migrations\b/);
    expect(schemaSql).not.toMatch(/\bschema_applied\b/);
  });

  it("binds every plugin installation to one workspace and immutable artifact digest", () => {
    const artifacts = tableBlock("plugin_artifacts");
    const installations = tableBlock("plugin_installations");
    const secrets = tableBlock("plugin_installation_secrets");

    expect(artifacts).toMatch(/digest\s+text\s+PRIMARY KEY/i);
    expect(artifacts).toMatch(/component\s+bytea\s+NOT NULL/i);
    expect(installations).toMatch(/workspace_id\s+text\s+NOT NULL/i);
    expect(installations).toMatch(/manifest\s+jsonb\s+NOT NULL/i);
    expect(installations).toMatch(/artifact_digest\s+text\s+NOT NULL/i);
    expect(installations).toMatch(/configuration\s+jsonb\s+NOT NULL/i);
    expect(secrets).toMatch(/installation_id\s+text\s+NOT NULL/i);
    expect(secrets).toMatch(/value_sealed\s+text\s+NOT NULL/i);
    expect(schemaSql).toMatch(/plugin_installations_workspace_plugin_idx/i);
    expect(schemaSql).toMatch(/REFERENCES\s+plugin_artifacts\s*\(digest\)/i);
  });

  it("binds OAuth authorization codes to one MCP resource", () => {
    const codes = tableBlock("oauth_authorization_codes");
    const accessTokens = tableBlock("oauth_access_tokens");
    const refreshTokens = tableBlock("oauth_refresh_tokens");

    expect(codes).toMatch(/\bresource\s+text\s+NOT NULL\b/);
    expect(accessTokens).toMatch(/\bresource\s+text\b/);
    expect(refreshTokens).toMatch(/\bresource\s+text\b/);
  });

  it("owns the recommend-survey schema used by hosted Braino", () => {
    const users = tableBlock("users");
    const surveys = tableBlock("nps_surveys");

    expect(users).toMatch(/\bnps_emails\b/);
    expect(surveys).toMatch(/\buser_id\b/);
    expect(surveys).toMatch(/\bscore\b[\s\S]*?BETWEEN\s+0\s+AND\s+10/i);
    expect(schemaSql).toMatch(/\bnps_surveys_user_idx\b/);
  });

  it("keeps users as human OAuth identities, not agent-user records", () => {
    const users = tableBlock("users");

    expect(users).not.toMatch(/\bkind\b/);
    expect(users).not.toMatch(/\bowner_id\b/);
    expect(schemaSql).not.toMatch(/\busers_kind_idx\b/);
    expect(schemaSql).not.toMatch(/\busers_owner_idx\b/);
  });

  it("stores chat collection attachments by stable ids only", () => {
    const chatConversations = tableBlock("chat_conversations");

    expect(chatConversations).toMatch(/\battached_collection_ids\b/);
    expect(chatConversations).not.toMatch(/\battached_collection_handles\b/);
  });

  it("keeps schema comments focused on the current architecture", () => {
    expect(schemaSql).not.toMatch(/\bmigration[- ]\d{3}\b/i);
    expect(schemaSql).not.toMatch(
      /\b(previous|legacy|post-migration|pre-migration|collection-vnext)\b/i,
    );
  });
});
