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

describe("open Braino administration", () => {
  it("has one owner console for the single workspace", () => {
    expect(routes).toContain('route("admin", "routes/admin.tsx")');
    expect(admin).toContain("Workspace administration");
    expect(admin).toContain('id="metrics-title"');
    expect(admin).toMatch(/<h2[^>]+id="metrics-title"[^>]*>\s*Metrics\s*<\/h2>/);
    expect(admin).toContain("Current totals for this workspace.");
    expect(admin).toContain("Workspace settings");
    expect(admin).toContain("People and access");
    expect(admin).toContain("Connections");
    expect(admin).toContain("Agents and MCP");
    expect(admin).toContain("Deployment");
    expect(admin).toContain("Operations");
    expect(admin).toContain('to="/collaborators"');
    expect(admin).toContain('to="/integrations"');
    expect(admin).toContain('to="/mcp-tokens"');
  });

  it("keeps the hosted control plane out of the public console", () => {
    expect(admin).not.toMatch(/billing|waitlist|top workspaces|superadmin/i);
  });

  it("shows Admin in the global header only to workspace owners", () => {
    expect(root).toContain("isOwner");
    expect(root).toContain('to="/admin"');
    expect(root).toContain("Admin");
  });

  it("keeps each administration page connected to the console", () => {
    for (const page of [collaborators, integrations, mcpTokens]) {
      expect(page).toContain('to="/admin"');
    }
  });
});
