import {
  type BrainoPlugin,
  PLUGIN_PROTOCOL_VERSION,
  type PluginManifest,
  type SourcePullCapability,
  definePlugin,
  pluginCapability,
} from "@doco/plugin-runtime";
import { googleDriveConnector } from "./google-drive.js";
import { notionConnector } from "./notion.js";
import { slackConnector } from "./slack.js";

export interface ConnectorPlugin extends BrainoPlugin {
  /** @deprecated Use manifest.name. */
  label: string;
  /** @deprecated Use capabilities["source.pull"]. */
  adapter: SourcePullCapability;
}

function defineConnectorPlugin(input: {
  id: string;
  name: string;
  network: readonly string[];
  adapter: SourcePullCapability;
}): ConnectorPlugin {
  const manifest: PluginManifest = {
    protocolVersion: PLUGIN_PROTOCOL_VERSION,
    id: input.id,
    name: input.name,
    version: "1.0.0",
    capabilities: ["source.pull"],
    permissions: { network: input.network },
  };
  const plugin = definePlugin({
    manifest,
    capabilities: { "source.pull": input.adapter },
  });
  return Object.freeze({
    ...plugin,
    label: plugin.manifest.name,
    adapter: pluginCapability(plugin, "source.pull"),
  });
}

export const CONNECTOR_PLUGINS = {
  slack: defineConnectorPlugin({
    id: "braino.slack",
    name: "Slack",
    network: ["slack.com"],
    adapter: slackConnector,
  }),
  notion: defineConnectorPlugin({
    id: "braino.notion",
    name: "Notion",
    network: ["api.notion.com"],
    adapter: notionConnector,
  }),
  google_drive: defineConnectorPlugin({
    id: "braino.google-drive",
    name: "Google Drive",
    network: ["www.googleapis.com", "oauth2.googleapis.com"],
    adapter: googleDriveConnector,
  }),
} as const satisfies Record<string, ConnectorPlugin>;

export function connectorPlugin(provider: string): ConnectorPlugin {
  const plugin = CONNECTOR_PLUGINS[provider as keyof typeof CONNECTOR_PLUGINS];
  if (!plugin) throw new Error("Unknown connector provider.");
  return plugin;
}

export { googleDriveConnector, notionConnector, slackConnector };
