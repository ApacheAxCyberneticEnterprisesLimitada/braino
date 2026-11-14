import type { PoolClient } from "@doco/db";
import type { EmbeddingInputType, EmbeddingProvider } from "@doco/index";
import { parsePluginManifest } from "@doco/plugin-runtime";
import {
  type PluginHostConnection,
  PluginInvocationError,
  invokePlugin,
} from "./plugin-invocation.js";

type Fetcher = typeof fetch;

interface InstallationRow {
  id: string;
  manifest: unknown;
  configuration: unknown;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PluginInvocationError(
      "Embedding plugin configuration is invalid.",
      "configuration_invalid",
    );
  }
  const entries = Object.entries(value);
  if (entries.some(([, item]) => typeof item !== "string")) {
    throw new PluginInvocationError(
      "Embedding plugin configuration is invalid.",
      "configuration_invalid",
    );
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function positiveInteger(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new PluginInvocationError(`${label} is invalid.`, "configuration_invalid");
  }
  return parsed;
}

function embeddingVectors(
  value: unknown,
  expectedCount: number,
  expectedDimensions: number,
): Float32Array[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PluginInvocationError("Plugin returned invalid embedding vectors.", "output_invalid");
  }
  const output = value as Record<string, unknown>;
  if (
    typeof output.model !== "string" ||
    output.model.trim().length === 0 ||
    output.dimensions !== expectedDimensions ||
    !Array.isArray(output.vectors) ||
    output.vectors.length !== expectedCount
  ) {
    throw new PluginInvocationError("Plugin returned invalid embedding vectors.", "output_invalid");
  }
  const vectors: Float32Array[] = [];
  for (const vector of output.vectors) {
    if (
      !Array.isArray(vector) ||
      vector.length !== expectedDimensions ||
      vector.some((item) => typeof item !== "number" || !Number.isFinite(item))
    ) {
      throw new PluginInvocationError(
        "Plugin returned invalid embedding vectors.",
        "output_invalid",
      );
    }
    vectors.push(new Float32Array(vector as number[]));
  }
  return vectors;
}

export class PluginEmbeddingProvider implements EmbeddingProvider {
  readonly modelId: string;
  readonly dimensions: number;

  constructor(
    private readonly client: PoolClient,
    private readonly installation: {
      workspaceId: string;
      installationId: string;
      pluginId: string;
      model: string;
      dimensions: number;
    },
    private readonly connection: {
      encryptionKey: string;
      host: PluginHostConnection;
      fetcher?: Fetcher;
    },
  ) {
    this.modelId = `plugin:${installation.pluginId}:${installation.model}`;
    this.dimensions = installation.dimensions;
  }

  async embed(
    texts: string[],
    inputType?: EmbeddingInputType,
    _signal?: AbortSignal,
  ): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const output = await invokePlugin(this.client, {
      workspaceId: this.installation.workspaceId,
      installationId: this.installation.installationId,
      capability: "embedding.embed",
      input: {
        model: this.installation.model,
        inputs: texts,
        ...(inputType ? { inputType } : {}),
      },
      encryptionKey: this.connection.encryptionKey,
      host: this.connection.host,
      ...(this.connection.fetcher ? { fetcher: this.connection.fetcher } : {}),
    });
    return embeddingVectors(output, texts.length, this.dimensions);
  }
}

export async function resolveWorkspaceEmbeddingProvider(
  client: PoolClient,
  input: {
    workspaceId: string;
    encryptionKey: string;
    host: PluginHostConnection;
    fetcher?: Fetcher;
  },
): Promise<PluginEmbeddingProvider | null> {
  const found = await client.query<InstallationRow>(
    `SELECT id, manifest, configuration
       FROM plugin_installations
      WHERE workspace_id = $1 AND enabled
        AND manifest->'capabilities' ? 'embedding.embed'
      ORDER BY updated_at DESC, id
      LIMIT 2`,
    [input.workspaceId],
  );
  if (found.rows.length === 0) return null;
  if (found.rows.length > 1) {
    throw new PluginInvocationError(
      "Only one embedding plugin can be enabled per workspace.",
      "embedding_plugin_ambiguous",
      409,
    );
  }
  const row = found.rows[0];
  const manifest = parsePluginManifest(row.manifest);
  const configuration = stringRecord(row.configuration);
  const model = configuration.model?.trim();
  if (!model) {
    throw new PluginInvocationError("Embedding plugin model is invalid.", "configuration_invalid");
  }
  return new PluginEmbeddingProvider(
    client,
    {
      workspaceId: input.workspaceId,
      installationId: row.id,
      pluginId: manifest.id,
      model,
      dimensions: positiveInteger(configuration.dimensions, "Embedding plugin dimensions"),
    },
    {
      encryptionKey: input.encryptionKey,
      host: input.host,
      ...(input.fetcher ? { fetcher: input.fetcher } : {}),
    },
  );
}
