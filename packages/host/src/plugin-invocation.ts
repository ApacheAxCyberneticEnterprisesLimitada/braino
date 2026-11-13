import type { PoolClient } from "@doco/db";
import {
  type PluginCapabilityName,
  type PluginManifest,
  parsePluginManifest,
} from "@doco/plugin-runtime";
import { PluginInstallationError } from "./plugin-installations.js";
import { openSecret } from "./secret-box.js";

const MAX_HOST_RESPONSE_BYTES = 9 * 1024 * 1024;
const HOST_TIMEOUT_MS = 35_000;

type Fetcher = typeof fetch;

interface InvocationRow {
  id: string;
  workspace_id: string;
  manifest: unknown;
  artifact_digest: string;
  configuration: unknown;
  component: Uint8Array;
  sealed_secrets: unknown;
}

export interface PluginHostConnection {
  url: string;
  apiToken: string;
}

export class PluginInvocationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status = 500,
  ) {
    super(message);
    this.name = "PluginInvocationError";
  }
}

function stringRecord(value: unknown, label: string): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PluginInvocationError(`${label} is invalid.`, "installation_invalid");
  }
  const entries = Object.entries(value);
  if (entries.some(([, item]) => typeof item !== "string")) {
    throw new PluginInvocationError(`${label} is invalid.`, "installation_invalid");
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function invocationUrl(host: PluginHostConnection): string {
  if (host.apiToken.trim().length < 32) {
    throw new PluginInvocationError("The plugin host is not configured.", "host_unconfigured");
  }
  let base: URL;
  try {
    base = new URL(host.url);
  } catch {
    throw new PluginInvocationError("The plugin host is not configured.", "host_unconfigured");
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new PluginInvocationError("The plugin host is not configured.", "host_unconfigured");
  }
  return new URL("/v1/invocations", base).toString();
}

function serializedInput(input: unknown): string {
  try {
    const serialized = JSON.stringify(input);
    if (serialized === undefined) throw new Error("not JSON");
    return serialized;
  } catch {
    throw new PluginInvocationError("Plugin input must be JSON.", "input_invalid", 400);
  }
}

async function responseText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_HOST_RESPONSE_BYTES) {
      await reader.cancel();
      throw new PluginInvocationError(
        "The plugin host response is too large.",
        "host_response_too_large",
        502,
      );
    }
    chunks.push(value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function manifestForCapability(
  value: unknown,
  capability: PluginCapabilityName,
): Readonly<PluginManifest> {
  const manifest = parsePluginManifest(value);
  if (!manifest.capabilities.includes(capability)) {
    throw new PluginInstallationError(
      `Plugin installation is not approved for ${capability}.`,
      "capability_not_approved",
      403,
    );
  }
  return manifest;
}

export async function invokePlugin(
  client: PoolClient,
  input: {
    workspaceId: string;
    installationId: string;
    capability: PluginCapabilityName;
    input: unknown;
    encryptionKey: string;
    host: PluginHostConnection;
    fetcher?: Fetcher;
  },
): Promise<unknown> {
  const found = await client.query<InvocationRow>(
    `SELECT i.id, i.workspace_id, i.manifest, i.artifact_digest,
            i.configuration, a.component,
            COALESCE(
              (SELECT jsonb_object_agg(s.name, s.value_sealed)
                 FROM plugin_installation_secrets s
                WHERE s.installation_id = i.id),
              '{}'::jsonb
            ) AS sealed_secrets
       FROM plugin_installations i
       JOIN plugin_artifacts a ON a.digest = i.artifact_digest
      WHERE i.workspace_id = $1 AND i.id = $2 AND i.enabled`,
    [input.workspaceId, input.installationId],
  );
  const row = found.rows[0];
  if (!row) {
    throw new PluginInstallationError(
      "Plugin installation is unavailable.",
      "installation_unavailable",
      404,
    );
  }

  const manifest = manifestForCapability(row.manifest, input.capability);
  const configuration = stringRecord(row.configuration, "Plugin configuration");
  const sealedSecrets = stringRecord(row.sealed_secrets, "Plugin secrets");
  const secrets = Object.fromEntries(
    Object.entries(sealedSecrets).map(([name, sealed]) => [
      name,
      openSecret(sealed, input.encryptionKey),
    ]),
  );
  const fetcher = input.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(invocationUrl(input.host), {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.host.apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workspaceId: row.workspace_id,
        installationId: row.id,
        pluginId: manifest.id,
        pluginVersion: manifest.version,
        artifactDigest: row.artifact_digest,
        componentBase64: Buffer.from(row.component).toString("base64"),
        capability: input.capability,
        inputJson: serializedInput(input.input),
        configuration,
        secrets,
        networkHosts: manifest.permissions.network,
      }),
      signal: AbortSignal.timeout(HOST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof PluginInvocationError) throw error;
    throw new PluginInvocationError("The plugin host is unavailable.", "host_unavailable", 502);
  }

  const text = await responseText(response);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new PluginInvocationError(
      "The plugin host returned an invalid response.",
      "host_response_invalid",
      502,
    );
  }
  if (!response.ok) {
    const hostCode =
      body &&
      typeof body === "object" &&
      "error" in body &&
      body.error &&
      typeof body.error === "object" &&
      "code" in body.error &&
      typeof body.error.code === "string"
        ? body.error.code
        : "execution_failed";
    throw new PluginInvocationError("Plugin execution failed.", hostCode, response.status);
  }
  if (
    !body ||
    typeof body !== "object" ||
    !("outputJson" in body) ||
    typeof body.outputJson !== "string"
  ) {
    throw new PluginInvocationError(
      "The plugin host returned an invalid response.",
      "host_response_invalid",
      502,
    );
  }
  try {
    return JSON.parse(body.outputJson);
  } catch {
    throw new PluginInvocationError(
      "The plugin host returned invalid plugin output.",
      "plugin_output_invalid",
      502,
    );
  }
}
