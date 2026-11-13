export const PLUGIN_PROTOCOL_VERSION = 1 as const;

export const PLUGIN_CAPABILITIES = [
  "source.pull",
  "event.receive",
  "email.send",
  "team_chat.send",
  "embedding.embed",
  "chat.complete",
] as const;

export type PluginCapabilityName = (typeof PLUGIN_CAPABILITIES)[number];

export type ConnectorFetcher = typeof fetch;

export class ConnectorError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}

export interface ConnectorSource {
  id: string;
  name: string;
  config?: Record<string, unknown>;
}

export interface ConnectorDocument {
  externalId: string;
  title: string;
  content: string;
  url: string;
  createdAt?: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface SourcePullCapability {
  provider: string;
  verify(input: { credential: string; fetcher: ConnectorFetcher }): Promise<ConnectorSource>;
  documents(input: {
    credential: string;
    source: ConnectorSource;
    fetcher: ConnectorFetcher;
  }): AsyncIterable<ConnectorDocument>;
}

/** Existing connector consumers use this name; it is the source.pull capability. */
export type ConnectorAdapter = SourcePullCapability;

export interface PluginEventRequest {
  body: Uint8Array;
  headers: Readonly<Record<string, string>>;
}

export interface PluginEvent {
  id: string;
  occurredAt: string;
  kind: string;
  data: Record<string, unknown>;
}

export interface EventReceiveCapability {
  receive(input: PluginEventRequest): Promise<readonly PluginEvent[]>;
}

export interface EmailMessage {
  from: string;
  to: readonly string[];
  subject: string;
  text?: string;
  html?: string;
  replyTo?: readonly string[];
}

export interface EmailSendCapability {
  send(input: EmailMessage): Promise<{ externalId: string }>;
}

export interface TeamChatMessage {
  channel: string;
  text: string;
  threadId?: string;
}

export interface TeamChatSendCapability {
  send(input: TeamChatMessage): Promise<{ externalId: string }>;
}

export interface EmbeddingRequest {
  model: string;
  inputs: readonly string[];
  inputType?: "document" | "query";
}

export interface EmbeddingResponse {
  model: string;
  dimensions: number;
  vectors: readonly (readonly number[])[];
}

export interface EmbeddingCapability {
  embed(input: EmbeddingRequest): Promise<EmbeddingResponse>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface ChatCompleteCapability {
  complete(input: {
    model: string;
    messages: readonly ChatMessage[];
    responseSchema?: Record<string, unknown>;
  }): Promise<{ content: string; model: string }>;
}

export interface PluginCapabilityImplementations {
  "source.pull": SourcePullCapability;
  "event.receive": EventReceiveCapability;
  "email.send": EmailSendCapability;
  "team_chat.send": TeamChatSendCapability;
  "embedding.embed": EmbeddingCapability;
  "chat.complete": ChatCompleteCapability;
}

export type PluginImplementations = Partial<PluginCapabilityImplementations>;

export interface PluginManifest {
  protocolVersion: typeof PLUGIN_PROTOCOL_VERSION;
  id: string;
  name: string;
  version: string;
  capabilities: readonly PluginCapabilityName[];
  permissions: {
    network: readonly string[];
  };
  configurationSchema?: Readonly<Record<string, unknown>>;
  secretSchema?: Readonly<Record<string, unknown>>;
}

export interface BrainoPlugin {
  readonly manifest: Readonly<PluginManifest>;
  readonly capabilities: Readonly<PluginImplementations>;
}

const PLUGIN_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const SEMANTIC_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const NETWORK_HOST = /^(?:\*\.)?(?:localhost|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::\d{1,5})?$/;
const KNOWN_CAPABILITIES = new Set<string>(PLUGIN_CAPABILITIES);

function validateManifest(manifest: PluginManifest): void {
  if (manifest.protocolVersion !== PLUGIN_PROTOCOL_VERSION) {
    throw new Error(`Unsupported plugin protocol version: ${manifest.protocolVersion}.`);
  }
  if (!PLUGIN_ID.test(manifest.id)) {
    throw new Error("Plugin identifier must be lowercase and dot- or dash-separated.");
  }
  if (!manifest.name.trim()) throw new Error("Plugin name is required.");
  if (!SEMANTIC_VERSION.test(manifest.version)) {
    throw new Error("Plugin version must be a semantic version.");
  }
  if (manifest.capabilities.length === 0) {
    throw new Error("A plugin must declare at least one capability.");
  }
  const seen = new Set<string>();
  for (const capability of manifest.capabilities) {
    if (!KNOWN_CAPABILITIES.has(capability)) {
      throw new Error(`Unknown plugin capability: ${capability}.`);
    }
    if (seen.has(capability)) {
      throw new Error(`Plugin manifest contains duplicate capability: ${capability}.`);
    }
    seen.add(capability);
  }
  for (const host of manifest.permissions.network) {
    if (!NETWORK_HOST.test(host) || host === "*") {
      throw new Error(`Invalid plugin network host: ${host}.`);
    }
  }
}

function immutableManifest(manifest: PluginManifest): Readonly<PluginManifest> {
  return Object.freeze({
    ...manifest,
    capabilities: Object.freeze([...manifest.capabilities]),
    permissions: Object.freeze({
      network: Object.freeze([...manifest.permissions.network]),
    }),
  });
}

export function definePlugin(input: {
  manifest: PluginManifest;
  capabilities: PluginImplementations;
}): BrainoPlugin {
  validateManifest(input.manifest);
  const declared = new Set<string>(input.manifest.capabilities);
  const implemented = Object.keys(input.capabilities);
  for (const capability of declared) {
    if (!input.capabilities[capability as PluginCapabilityName]) {
      throw new Error(`Plugin does not implement declared capability: ${capability}.`);
    }
  }
  for (const capability of implemented) {
    if (!declared.has(capability)) {
      throw new Error(`Plugin implements undeclared capability: ${capability}.`);
    }
  }
  return Object.freeze({
    manifest: immutableManifest(input.manifest),
    capabilities: Object.freeze({ ...input.capabilities }),
  });
}

export function pluginCapability<K extends PluginCapabilityName>(
  plugin: BrainoPlugin,
  capability: K,
): PluginCapabilityImplementations[K] {
  const implementation = plugin.capabilities[capability];
  if (!implementation) {
    throw new Error(`Plugin ${plugin.manifest.id} does not provide ${capability}.`);
  }
  return implementation as PluginCapabilityImplementations[K];
}
