import { readFileSync } from "node:fs";
import { CONNECTOR_PLUGINS, connectorPlugin } from "@doco/connector-plugins";
import * as host from "@doco/host";
import { describe, expect, it } from "vitest";

describe("connector plugin boundary", () => {
  it("keeps provider adapters out of the host runtime", () => {
    expect(host).not.toHaveProperty("slackConnector");
    expect(host).not.toHaveProperty("notionConnector");
    expect(host).not.toHaveProperty("googleDriveConnector");
  });

  it("resolves every bundled provider through one registry", () => {
    expect(Object.keys(CONNECTOR_PLUGINS)).toEqual(["slack", "notion", "google_drive"]);
    for (const provider of Object.keys(CONNECTOR_PLUGINS)) {
      const plugin = connectorPlugin(provider);
      expect(plugin.manifest).toMatchObject({
        protocolVersion: 1,
        capabilities: ["source.pull"],
      });
      expect(plugin.capabilities["source.pull"]?.provider).toBe(provider);
      // The released adapter field remains the same implementation during the protocol migration.
      expect(plugin.adapter).toBe(plugin.capabilities["source.pull"]);
    }
    expect(() => connectorPlugin("unknown")).toThrow("Unknown connector provider");
  });

  it("declares connector egress instead of granting unrestricted networking", () => {
    expect(connectorPlugin("slack").manifest.permissions.network).toEqual(["slack.com"]);
    expect(connectorPlugin("notion").manifest.permissions.network).toEqual(["api.notion.com"]);
    expect(connectorPlugin("google_drive").manifest.permissions.network).toEqual([
      "www.googleapis.com",
      "oauth2.googleapis.com",
    ]);
  });

  it("installs the plugin package in the container dependency layer", () => {
    const dockerfile = readFileSync(new URL("../../../../../Dockerfile", import.meta.url), "utf8");
    expect(dockerfile).toContain(
      "COPY packages/connector-plugins/package.json packages/connector-plugins/package.json",
    );
    expect(dockerfile).toContain(
      "COPY packages/plugin-runtime/package.json packages/plugin-runtime/package.json",
    );
  });
});
