import type { PoolClient } from "@doco/db";
import {
  type PluginCapabilityName,
  type PluginManifest,
  parsePluginManifest,
} from "@doco/plugin-runtime";
import { generateUlid } from "@doco/shared";

const ARTIFACT_DIGEST = /^sha256:[0-9a-f]{64}$/;

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
  enabled: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface PluginInstallation {
  id: string;
  workspaceId: string;
  manifest: Readonly<PluginManifest>;
  artifactDigest: string;
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

function installation(row: InstallationRow): PluginInstallation {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    manifest: parsePluginManifest(row.manifest),
    artifactDigest: row.artifact_digest,
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
     RETURNING id, workspace_id, manifest, artifact_digest, enabled, created_at, updated_at`,
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
    `SELECT id, workspace_id, manifest, artifact_digest, enabled, created_at, updated_at
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
      RETURNING id, workspace_id, manifest, artifact_digest, enabled, created_at, updated_at`,
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
    `SELECT id, workspace_id, manifest, artifact_digest, enabled, created_at, updated_at
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
