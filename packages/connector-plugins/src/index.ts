import type { ConnectorAdapter } from "@doco/host";
import { googleDriveConnector } from "./google-drive.js";
import { notionConnector } from "./notion.js";
import { slackConnector } from "./slack.js";

export interface ConnectorPlugin {
  label: string;
  adapter: ConnectorAdapter;
}

export const CONNECTOR_PLUGINS = {
  slack: { label: "Slack", adapter: slackConnector },
  notion: { label: "Notion", adapter: notionConnector },
  google_drive: { label: "Google Drive", adapter: googleDriveConnector },
} as const satisfies Record<string, ConnectorPlugin>;

export function connectorPlugin(provider: string): ConnectorPlugin {
  const plugin = CONNECTOR_PLUGINS[provider as keyof typeof CONNECTOR_PLUGINS];
  if (!plugin) throw new Error("Unknown connector provider.");
  return plugin;
}

export { googleDriveConnector, notionConnector, slackConnector };
