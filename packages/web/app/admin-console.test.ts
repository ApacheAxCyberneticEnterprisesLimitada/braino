import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const app = resolve(import.meta.dirname);
const admin = readFileSync(resolve(app, "routes/admin.tsx"), "utf8");
const routes = readFileSync(resolve(app, "routes.ts"), "utf8");
const root = readFileSync(resolve(app, "root.tsx"), "utf8");
const collaborators = readFileSync(resolve(app, "routes/collaborators.tsx"), "utf8");
const integrations = readFileSync(resolve(app, "routes/integrations.tsx"), "utf8");
const mcpTokens = readFileSync(resolve(app, "routes/mcp-tokens.tsx"), "utf8");
const timesIndex = readFileSync(resolve(app, "routes/times._index.tsx"), "utf8");

describe("open Braino administration", () => {
  it("has one owner console for the single workspace", () => {
    expect(routes).toContain('route("admin", "routes/admin.tsx")');
    expect(routes).toContain('route("times", "routes/times._index.tsx")');
    expect(routes).toContain('route("times/:day", "routes/times.$day.tsx")');
    expect(admin).toContain("Workspace administration");
    expect(admin).toContain('id="metrics-title"');
    expect(admin).toMatch(/<h2[^>]+id="metrics-title"[^>]*>\s*Metrics\s*<\/h2>/);
    expect(admin).toContain("Current totals for this workspace.");
    expect(admin).toContain("Workspace settings");
    expect(admin).toContain("Braino Times");
    expect(admin).toContain('name="times_timezone"');
    expect(admin).toContain('name="times_public"');
    expect(admin).toContain('to="/times"');
    expect(admin).toContain("People and access");
    expect(admin).toContain("Connections");
    expect(admin).toContain("Connect Señor Braino");
    expect(mcpTokens).toContain("Connect Señor Braino");
    expect(mcpTokens).toContain("OAuth");
    expect(mcpTokens).toContain("This instance connects directly");
    expect(admin).toContain("Deployment");
    expect(admin).toContain("Embedding model plugin");
    expect(admin).toContain('name="embedding_model"');
    expect(admin).toContain('name="embedding_dimensions"');
    expect(admin).toContain('"install_ollama_embedding"');
    expect(admin).toContain("listPluginInstallations");
    expect(admin).toContain("installPlugin");
    expect(admin).toContain("configurePluginInstallation");
    expect(admin).toContain("Operations");
    expect(admin).toContain("CodeLinker");
    expect(admin).toContain("BRAINO_CODELINKER_URL");
    expect(admin).toContain("BRAINO_CODELINKER_API_TOKEN");
    expect(admin).toContain('to="/collaborators"');
    expect(admin).toContain('to="/integrations"');
    expect(admin).toContain('to="/mcp-tokens"');
  });

  it("shows rolling operational metrics with the required comparison context", () => {
    expect(admin).toContain("METRIC_PERIODS");
    expect(admin).toContain('{ value: "24h", label: "24 hours"');
    expect(admin).toContain('{ value: "7d", label: "7 days"');
    expect(admin).toContain('{ value: "30d", label: "30 days"');
    expect(admin).toContain('aria-label="Metrics time period"');
    expect(admin).toContain("to={`?period=${option.value}`}");
    expect(admin).toContain(
      'aria-current={option.value === overview.activity.period ? "true" : undefined}',
    );
    expect(admin).toContain("vs previous ${period}");
    expect(admin).toContain("by agents");
  });

  it("keeps the hosted control plane out of the public console", () => {
    expect(admin).not.toMatch(/billing|waitlist|top workspaces|superadmin/i);
  });

  it("does not reveal a private Times edition through the latest-edition redirect", () => {
    expect(timesIndex).toContain("loadTimesEdition");
    expect(timesIndex).toContain('edition.kind === "hidden"');
  });

  it("shows Admin in the global header only to workspace owners", () => {
    expect(root).toContain("isOwner");
    expect(root).toContain('to="/admin"');
    expect(root).toContain("Admin");
    expect(root).toContain('to="/times"');
  });

  it("keeps each administration page connected to the console", () => {
    for (const page of [collaborators, integrations, mcpTokens]) {
      expect(page).toContain('to="/admin"');
    }
  });
});
