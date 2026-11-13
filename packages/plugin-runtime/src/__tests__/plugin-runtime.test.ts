import { describe, expect, it } from "vitest";
import {
  ConnectorError,
  PLUGIN_PROTOCOL_VERSION,
  type SourcePullCapability,
  definePlugin,
  pluginCapability,
} from "../index.js";

const sourcePull: SourcePullCapability = {
  provider: "slack",
  async verify() {
    return { id: "T_ACME", name: "Acme" };
  },
  async *documents() {
    yield {
      externalId: "message-1",
      title: "Announcement",
      content: "Launch is Monday",
      url: "https://acme.slack.com/archives/general/message-1",
      updatedAt: "2026-11-13T00:00:00.000Z",
    };
  },
};

function sourcePlugin() {
  return definePlugin({
    manifest: {
      protocolVersion: PLUGIN_PROTOCOL_VERSION,
      id: "braino.slack",
      name: "Slack",
      version: "1.0.0",
      capabilities: ["source.pull"],
      permissions: { network: ["slack.com", "*.slack.com"] },
    },
    capabilities: { "source.pull": sourcePull },
  });
}

describe("Braino plugin protocol", () => {
  it("carries connector failures across the host boundary", () => {
    const error = new ConnectorError("Provider unavailable.", "provider_unavailable", 502);

    expect(error).toMatchObject({
      name: "ConnectorError",
      message: "Provider unavailable.",
      code: "provider_unavailable",
      status: 502,
    });
  });

  it("defines an immutable, versioned plugin with matching capabilities", () => {
    const plugin = sourcePlugin();

    expect(plugin.manifest).toMatchObject({
      protocolVersion: 1,
      id: "braino.slack",
      capabilities: ["source.pull"],
    });
    expect(pluginCapability(plugin, "source.pull")).toBe(sourcePull);
    expect(Object.isFrozen(plugin)).toBe(true);
    expect(Object.isFrozen(plugin.manifest)).toBe(true);
  });

  it("rejects a manifest whose implementation does not match its declaration", () => {
    expect(() =>
      definePlugin({
        manifest: {
          protocolVersion: PLUGIN_PROTOCOL_VERSION,
          id: "braino.slack",
          name: "Slack",
          version: "1.0.0",
          capabilities: ["source.pull", "event.receive"],
          permissions: { network: ["slack.com"] },
        },
        capabilities: { "source.pull": sourcePull },
      }),
    ).toThrow("event.receive");
  });

  it("rejects undeclared implementations and missing capability lookups", () => {
    expect(() =>
      definePlugin({
        manifest: {
          protocolVersion: PLUGIN_PROTOCOL_VERSION,
          id: "braino.slack",
          name: "Slack",
          version: "1.0.0",
          capabilities: ["source.pull"],
          permissions: { network: ["slack.com"] },
        },
        capabilities: {
          "source.pull": sourcePull,
          "event.receive": {
            async receive() {
              return [];
            },
          },
        },
      }),
    ).toThrow("undeclared capability");

    expect(() => pluginCapability(sourcePlugin(), "event.receive")).toThrow(
      "does not provide event.receive",
    );
  });

  it.each([
    [{ protocolVersion: 2 }, "protocol version"],
    [{ id: "Slack" }, "identifier"],
    [{ version: "latest" }, "semantic version"],
    [{ name: " " }, "name is required"],
    [{ capabilities: [] }, "at least one capability"],
    [{ capabilities: ["unknown.capability"] }, "Unknown plugin capability"],
    [{ capabilities: ["source.pull", "source.pull"] }, "duplicate capability"],
    [{ permissions: { network: ["https://slack.com/api"] } }, "network host"],
  ])("rejects an unsafe or incompatible manifest override", (override, message) => {
    const manifest = {
      protocolVersion: PLUGIN_PROTOCOL_VERSION,
      id: "braino.slack",
      name: "Slack",
      version: "1.0.0",
      capabilities: ["source.pull"] as const,
      permissions: { network: ["slack.com"] },
      ...override,
    };

    expect(() =>
      definePlugin({
        // This cast exercises runtime validation of untrusted marketplace input.
        manifest: manifest as never,
        capabilities: { "source.pull": sourcePull },
      }),
    ).toThrow(message);
  });
});
