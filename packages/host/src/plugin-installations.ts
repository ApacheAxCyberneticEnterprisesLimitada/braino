import type { PoolClient } from "@doco/db";
import {
  type PluginCapabilityName,
  type PluginManifest,
  parsePluginManifest,
} from "@doco/plugin-runtime";
import { generateUlid } from "@doco/shared";
import { openSecret, sealSecret } from "./secret-box.js";

const ARTIFACT_DIGEST = /^sha256:[0-9a-f]{64}$/;
const SECRET_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const INSTALLATION_COLUMNS =
  "id, workspace_id, manifest, artifact_digest, configuration, enabled, created_at, updated_at";

export class PluginInstallationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "PluginInstallationError";
  }
}

interface InstallationRow {
  id: string;
  workspace_id: string;
  manifest: unknown;
  artifact_digest: string;
  configuration: unknown;
  enabled: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface PluginInstallation {
  id: string;
  workspaceId: string;
  manifest: Readonly<PluginManifest>;
  artifactDigest: string;
  configuration: Readonly<Record<string, unknown>>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PluginInvocationIdentity {
  workspaceId: string;
  installationId: string;
  pluginId: string;
  pluginVersion: string;
  artifactDigest: string;
  capability: PluginCapabilityName;
  networkHosts: readonly string[];
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function jsonObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PluginInstallationError(`${label} must be an object.`, "configuration_invalid");
  }
  return value as Record<string, unknown>;
}

function serializedConfiguration(value: unknown): {
  configuration: Readonly<Record<string, unknown>>;
  serialized: string;
} {
  const configuration = jsonObject(value, "Plugin configuration");
  try {
    return { configuration, serialized: JSON.stringify(configuration) };
  } catch {
    throw new PluginInstallationError(
      "Plugin configuration must contain JSON values.",
      "configuration_invalid",
    );
  }
}

function schemaKeys(schema: Readonly<Record<string, unknown>> | undefined): {
  keys: ReadonlySet<string>;
  additional: boolean;
} {
  if (!schema) return { keys: new Set(), additional: false };
  const properties = schema.properties;
  return {
    keys:
      properties && typeof properties === "object" && !Array.isArray(properties)
        ? new Set(Object.keys(properties))
        : new Set(),
    additional: schema.additionalProperties === true,
  };
}

function requireDeclaredKeys(
  values: Readonly<Record<string, unknown>>,
  schema: Readonly<Record<string, unknown>> | undefined,
  kind: "configuration" | "secret",
): void {
  const allowed = schemaKeys(schema);
  for (const key of Object.keys(values)) {
    if (!allowed.additional && !allowed.keys.has(key)) {
      throw new PluginInstallationError(
        `Plugin ${kind} ${key} is not declared by the manifest.`,
        `${kind}_not_declared`,
      );
    }
  }
}

function installation(row: InstallationRow): PluginInstallation {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    manifest: parsePluginManifest(row.manifest),
    artifactDigest: row.artifact_digest,
    configuration: Object.freeze({ ...jsonObject(row.configuration, "Stored configuration") }),
    enabled: row.enabled,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

async function requireOwner(
  client: PoolClient,
  workspaceId: string,
  userId: string,
): Promise<void> {
  const found = await client.query(
    `SELECT 1 FROM workspace_users
      WHERE workspace_id = $1 AND user_id = $2 AND role = 'owner'`,
    [workspaceId, userId],
  );
  if (!found.rows[0]) {
    throw new PluginInstallationError(
      "Only workspace owners can manage plugins.",
      "owner_required",
      403,
    );
  }
}

export async function installPlugin(
  client: PoolClient,
  input: {
    workspaceId: string;
    userId: string;
    manifest: unknown;
    artifactDigest: string;
  },
): Promise<PluginInstallation> {
  await requireOwner(client, input.workspaceId, input.userId);
  const manifest = parsePluginManifest(input.manifest);
  if (!ARTIFACT_DIGEST.test(input.artifactDigest)) {
    throw new PluginInstallationError(
      "Plugin artifacts must be pinned by a lowercase SHA-256 digest.",
      "artifact_digest_invalid",
    );
  }
  const id = `plugin_installation_${generateUlid()}`;
  const result = await client.query<InstallationRow>(
    `INSERT INTO plugin_installations
       (id, workspace_id, manifest, artifact_digest, enabled,
        created_by_user_id, updated_by_user_id)
     VALUES ($1, $2, $3::jsonb, $4, true, $5, $5)
     ON CONFLICT (workspace_id, (manifest->>'id')) DO UPDATE
       SET manifest = EXCLUDED.manifest,
           artifact_digest = EXCLUDED.artifact_digest,
           enabled = true,
           updated_by_user_id = EXCLUDED.updated_by_user_id,
           updated_at = now()
     RETURNING ${INSTALLATION_COLUMNS}`,
    [id, input.workspaceId, JSON.stringify(manifest), input.artifactDigest, input.userId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new PluginInstallationError("Plugin installation failed.", "installation_failed", 500);
  }
  return installation(row);
}

export async function listPluginInstallations(
  client: PoolClient,
  input: { workspaceId: string; userId: string },
): Promise<PluginInstallation[]> {
  await requireOwner(client, input.workspaceId, input.userId);
  const result = await client.query<InstallationRow>(
    `SELECT ${INSTALLATION_COLUMNS}
       FROM plugin_installations
      WHERE workspace_id = $1
      ORDER BY manifest->>'name', id`,
    [input.workspaceId],
  );
  return result.rows.map(installation);
}

export async function setPluginInstallationEnabled(
  client: PoolClient,
  input: {
    workspaceId: string;
    userId: string;
    installationId: string;
    enabled: boolean;
  },
): Promise<PluginInstallation> {
  await requireOwner(client, input.workspaceId, input.userId);
  const result = await client.query<InstallationRow>(
    `UPDATE plugin_installations
        SET enabled = $4, updated_by_user_id = $3, updated_at = now()
      WHERE workspace_id = $1 AND id = $2
      RETURNING ${INSTALLATION_COLUMNS}`,
    [input.workspaceId, input.installationId, input.userId, input.enabled],
  );
  const row = result.rows[0];
  if (!row) {
    throw new PluginInstallationError(
      "Plugin installation is unavailable.",
      "installation_unavailable",
      404,
    );
  }
  return installation(row);
}

export async function resolvePluginInvocation(
  client: PoolClient,
  input: {
    workspaceId: string;
    installationId: string;
    capability: PluginCapabilityName;
  },
): Promise<PluginInvocationIdentity> {
  const result = await client.query<InstallationRow>(
    `SELECT ${INSTALLATION_COLUMNS}
       FROM plugin_installations
      WHERE workspace_id = $1 AND id = $2 AND enabled`,
    [input.workspaceId, input.installationId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new PluginInstallationError(
      "Plugin installation is unavailable.",
      "installation_unavailable",
      404,
    );
  }
  const manifest = parsePluginManifest(row.manifest);
  if (!manifest.capabilities.includes(input.capability)) {
    throw new PluginInstallationError(
      `Plugin installation is not approved for ${input.capability}.`,
      "capability_not_approved",
      403,
    );
  }
  return Object.freeze({
    workspaceId: row.workspace_id,
    installationId: row.id,
    pluginId: manifest.id,
    pluginVersion: manifest.version,
    artifactDigest: row.artifact_digest,
    capability: input.capability,
    networkHosts: Object.freeze([...manifest.permissions.network]),
  });
}

export async function configurePluginInstallation(
  client: PoolClient,
  input: {
    workspaceId: string;
    userId: string;
    installationId: string;
    configuration: unknown;
    secrets: Readonly<Record<string, string | null>>;
    encryptionKey: string;
  },
): Promise<{ installation: PluginInstallation; secretNames: string[] }> {
  const configured = serializedConfiguration(input.configuration);
  const secrets = jsonObject(input.secrets, "Plugin secrets") as Record<string, string | null>;
  await client.query("BEGIN");
  try {
    await requireOwner(client, input.workspaceId, input.userId);
    const found = await client.query<InstallationRow>(
      `SELECT ${INSTALLATION_COLUMNS}
         FROM plugin_installations
        WHERE workspace_id = $1 AND id = $2
        FOR UPDATE`,
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
    const manifest = parsePluginManifest(row.manifest);
    requireDeclaredKeys(configured.configuration, manifest.configurationSchema, "configuration");
    requireDeclaredKeys(secrets, manifest.secretSchema, "secret");
    for (const [name, value] of Object.entries(secrets)) {
      if (!SECRET_NAME.test(name)) {
        throw new PluginInstallationError("Plugin secret name is invalid.", "secret_name_invalid");
      }
      if (value !== null && (typeof value !== "string" || value.length === 0)) {
        throw new PluginInstallationError(
          "Plugin secrets cannot be empty.",
          "secret_value_invalid",
        );
      }
    }
    const updated = await client.query<InstallationRow>(
      `UPDATE plugin_installations
          SET configuration = $3::jsonb, updated_by_user_id = $4, updated_at = now()
        WHERE workspace_id = $1 AND id = $2
        RETURNING ${INSTALLATION_COLUMNS}`,
      [input.workspaceId, input.installationId, configured.serialized, input.userId],
    );
    for (const [name, value] of Object.entries(secrets)) {
      if (value === null) {
        await client.query(
          "DELETE FROM plugin_installation_secrets WHERE installation_id = $1 AND name = $2",
          [input.installationId, name],
        );
      } else {
        await client.query(
          `INSERT INTO plugin_installation_secrets
             (installation_id, name, value_sealed, updated_by_user_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (installation_id, name) DO UPDATE
             SET value_sealed = EXCLUDED.value_sealed,
                 updated_by_user_id = EXCLUDED.updated_by_user_id,
                 updated_at = now()`,
          [input.installationId, name, sealSecret(value, input.encryptionKey), input.userId],
        );
      }
    }
    const names = await client.query<{ name: string }>(
      "SELECT name FROM plugin_installation_secrets WHERE installation_id = $1 ORDER BY name",
      [input.installationId],
    );
    const installationRow = updated.rows[0];
    if (!installationRow) {
      throw new PluginInstallationError(
        "Plugin configuration failed.",
        "configuration_failed",
        500,
      );
    }
    const response = {
      installation: installation(installationRow),
      secretNames: names.rows.map((secret) => secret.name),
    };
    await client.query("COMMIT");
    return response;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function listPluginSecretNames(
  client: PoolClient,
  input: { workspaceId: string; userId: string; installationId: string },
): Promise<string[]> {
  await requireOwner(client, input.workspaceId, input.userId);
  const found = await client.query<{ name: string }>(
    `SELECT s.name
       FROM plugin_installation_secrets s
       JOIN plugin_installations i ON i.id = s.installation_id
      WHERE i.workspace_id = $1 AND i.id = $2
      ORDER BY s.name`,
    [input.workspaceId, input.installationId],
  );
  return found.rows.map((row) => row.name);
}

export async function resolvePluginSecret(
  client: PoolClient,
  input: {
    workspaceId: string;
    installationId: string;
    name: string;
    encryptionKey: string;
  },
): Promise<string> {
  const found = await client.query<{ value_sealed: string }>(
    `SELECT s.value_sealed
       FROM plugin_installation_secrets s
       JOIN plugin_installations i ON i.id = s.installation_id
      WHERE i.workspace_id = $1 AND i.id = $2 AND i.enabled AND s.name = $3`,
    [input.workspaceId, input.installationId, input.name],
  );
  const row = found.rows[0];
  if (!row) {
    throw new PluginInstallationError("Plugin secret is unavailable.", "secret_unavailable", 404);
  }
  return openSecret(row.value_sealed, input.encryptionKey);
}
