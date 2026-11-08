import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "@doco/db";
import { type ApplyChangesetResult, applyChangeset } from "./changesets.js";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class IncomingWebhookError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "IncomingWebhookError";
  }
}

export interface IncomingWebhookSummary {
  tokenId: string;
  label: string;
  collectionId: string;
  collectionHandle: string;
  revoked: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export async function createIncomingWebhook(
  client: PoolClient,
  input: { workspaceId: string; collectionId: string; userId: string; label: string },
): Promise<{ accessToken: string; tokenId: string }> {
  const allowed = await client.query(
    `SELECT 1
       FROM collections c
       JOIN workspace_users wu ON wu.workspace_id = c.workspace_id
      WHERE c.id = $1 AND c.workspace_id = $2 AND c.deleted_at IS NULL
        AND wu.user_id = $3 AND wu.role = 'owner'`,
    [input.collectionId, input.workspaceId, input.userId],
  );
  if (!allowed.rows[0]) {
    throw new IncomingWebhookError(
      "Only workspace owners can create incoming webhooks.",
      "owner_required",
      403,
    );
  }
  const label = input.label.trim().slice(0, 100);
  if (!label) throw new IncomingWebhookError("Webhook name is required.", "label_required");
  const accessToken = `doco_wh_${randomBytes(32).toString("base64url")}`;
  const tokenId = digest(accessToken);
  await client.query(
    `INSERT INTO incoming_webhooks (token, collection_id, created_by_user_id, label)
     VALUES ($1, $2, $3, $4)`,
    [tokenId, input.collectionId, input.userId, label],
  );
  return { accessToken, tokenId };
}

export async function listIncomingWebhooks(
  client: PoolClient,
  input: { workspaceId: string; userId: string },
): Promise<IncomingWebhookSummary[]> {
  const found = await client.query<{
    token: string;
    label: string;
    collection_id: string;
    collection_handle: string;
    revoked: boolean;
    created_at: Date | string;
    last_used_at: Date | string | null;
  }>(
    `SELECT h.token, h.label, h.collection_id, c.handle AS collection_handle,
            h.revoked, h.created_at, h.last_used_at
       FROM incoming_webhooks h
       JOIN collections c ON c.id = h.collection_id AND c.deleted_at IS NULL
       JOIN workspace_users wu ON wu.workspace_id = c.workspace_id
      WHERE c.workspace_id = $1 AND wu.user_id = $2 AND wu.role = 'owner'
      ORDER BY h.created_at DESC`,
    [input.workspaceId, input.userId],
  );
  const iso = (value: Date | string) =>
    value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  return found.rows.map((row) => ({
    tokenId: row.token,
    label: row.label,
    collectionId: row.collection_id,
    collectionHandle: row.collection_handle,
    revoked: row.revoked,
    createdAt: iso(row.created_at),
    lastUsedAt: row.last_used_at ? iso(row.last_used_at) : null,
  }));
}

export async function revokeIncomingWebhook(
  client: PoolClient,
  input: { tokenId: string; userId: string },
): Promise<void> {
  await client.query(
    `UPDATE incoming_webhooks h
        SET revoked = true
       FROM collections c, workspace_users wu
      WHERE h.token = $1 AND h.created_by_user_id = $2
        AND c.id = h.collection_id
        AND wu.workspace_id = c.workspace_id AND wu.user_id = $2 AND wu.role = 'owner'`,
    [input.tokenId, input.userId],
  );
}

export async function deliverIncomingWebhook(
  client: PoolClient,
  input: {
    accessToken: string;
    idempotencyKey: string;
    operations: unknown;
    reason?: string | null;
  },
): Promise<ApplyChangesetResult & { replayed: boolean }> {
  if (!input.accessToken.startsWith("doco_wh_")) {
    throw new IncomingWebhookError("Webhook token is invalid.", "webhook_unauthorized", 401);
  }
  const tokenId = digest(input.accessToken);
  const webhook = await client.query<{
    collection_handle: string;
    actor_id: string;
    label: string;
  }>(
    `SELECT c.handle AS collection_handle, h.created_by_user_id AS actor_id, h.label
       FROM incoming_webhooks h
       JOIN collections c ON c.id = h.collection_id AND c.deleted_at IS NULL
       JOIN workspace_users wu
         ON wu.workspace_id = c.workspace_id AND wu.user_id = h.created_by_user_id
      WHERE h.token = $1 AND NOT h.revoked`,
    [tokenId],
  );
  const target = webhook.rows[0];
  if (!target) {
    throw new IncomingWebhookError("Webhook token is invalid.", "webhook_unauthorized", 401);
  }
  const idempotencyKey = input.idempotencyKey.trim().slice(0, 200);
  if (!idempotencyKey) {
    throw new IncomingWebhookError("Idempotency-Key is required.", "idempotency_key_required", 400);
  }
  const reserved = await client.query(
    `INSERT INTO incoming_webhook_deliveries (webhook_token, idempotency_key, status)
     VALUES ($1, $2, 'processing')
     ON CONFLICT DO NOTHING
     RETURNING idempotency_key`,
    [tokenId, idempotencyKey],
  );
  if (!reserved.rows[0]) {
    const prior = await client.query<{ status: string; response: ApplyChangesetResult | null }>(
      `SELECT status, response FROM incoming_webhook_deliveries
        WHERE webhook_token = $1 AND idempotency_key = $2`,
      [tokenId, idempotencyKey],
    );
    if (prior.rows[0]?.status === "completed" && prior.rows[0].response) {
      return { ...prior.rows[0].response, replayed: true };
    }
    throw new IncomingWebhookError(
      "A delivery with this Idempotency-Key is already processing.",
      "delivery_in_progress",
      409,
    );
  }
  try {
    const result = await applyChangeset(client, {
      collectionHandle: target.collection_handle,
      actorId: target.actor_id,
      operations: input.operations,
      source: "import",
      reason: input.reason?.trim() || `Incoming webhook: ${target.label}`,
      metadata: { integration: "webhook", idempotency_key: idempotencyKey },
    });
    await client.query(
      `UPDATE incoming_webhook_deliveries
          SET status = 'completed', response = $3::jsonb, completed_at = now()
        WHERE webhook_token = $1 AND idempotency_key = $2`,
      [tokenId, idempotencyKey, JSON.stringify(result)],
    );
    await client.query("UPDATE incoming_webhooks SET last_used_at = now() WHERE token = $1", [
      tokenId,
    ]);
    return { ...result, replayed: false };
  } catch (error) {
    await client.query(
      `DELETE FROM incoming_webhook_deliveries
        WHERE webhook_token = $1 AND idempotency_key = $2 AND status = 'processing'`,
      [tokenId, idempotencyKey],
    );
    throw error;
  }
}
