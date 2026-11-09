import { createHash } from "node:crypto";
import type { PoolClient } from "@doco/db";

const WINDOW_MS = 15 * 60 * 1000;
const BLOCK_MS = 15 * 60 * 1000;

export interface PasswordAttemptBucket {
  scope: "account" | "client";
  identifier: string;
  maxAttempts: number;
}

export interface PasswordAttemptReservation {
  allowed: boolean;
  retryAfterSeconds: number;
}

function bucketKey(bucket: PasswordAttemptBucket): string {
  return createHash("sha256")
    .update(`${bucket.scope}:${bucket.identifier.trim().toLowerCase()}`)
    .digest("hex");
}

function normalized(buckets: PasswordAttemptBucket[]) {
  const unique = new Map<string, PasswordAttemptBucket & { key: string; maxAttempts: number }>();
  for (const bucket of buckets) {
    const identifier = bucket.identifier.trim().toLowerCase();
    const maxAttempts = Math.trunc(bucket.maxAttempts);
    if (!identifier || maxAttempts < 1 || maxAttempts > 100) {
      throw new Error("Password attempt buckets require an identifier and a limit from 1 to 100.");
    }
    const key = bucketKey({ ...bucket, identifier });
    unique.set(key, { ...bucket, identifier, maxAttempts, key });
  }
  return [...unique.values()].sort((left, right) => {
    const leftOrder = left.scope === "client" ? 0 : 1;
    const rightOrder = right.scope === "client" ? 0 : 1;
    return leftOrder - rightOrder || left.key.localeCompare(right.key);
  });
}

export async function reservePasswordSignInAttempt(
  client: PoolClient,
  buckets: PasswordAttemptBucket[],
  now = new Date(),
): Promise<PasswordAttemptReservation> {
  const requested = normalized(buckets);
  if (requested.length === 0) throw new Error("At least one password attempt bucket is required.");
  const nowIso = now.toISOString();
  await client.query("BEGIN");
  try {
    await client.query(
      "DELETE FROM password_sign_in_attempts WHERE updated_at < $1::timestamptz - interval '1 day'",
      [nowIso],
    );
    const rows: Array<{
      key: string;
      maxAttempts: number;
      attemptCount: number;
      windowStartedAt: Date;
    }> = [];
    for (const bucket of requested) {
      await client.query(
        `INSERT INTO password_sign_in_attempts
           (key_hash, scope, attempt_count, window_started_at, updated_at)
         VALUES ($1, $2, 0, $3, $3)
         ON CONFLICT (key_hash) DO NOTHING`,
        [bucket.key, bucket.scope, nowIso],
      );
      const found = await client.query<{
        attempt_count: number;
        window_started_at: Date | string;
        blocked_until: Date | string | null;
      }>(
        `SELECT attempt_count, window_started_at, blocked_until
           FROM password_sign_in_attempts
          WHERE key_hash = $1
          FOR UPDATE`,
        [bucket.key],
      );
      const row = found.rows[0];
      if (!row) throw new Error("Password attempt bucket disappeared while it was locked.");
      const blockedUntil = row.blocked_until ? new Date(row.blocked_until) : null;
      if (blockedUntil && blockedUntil.getTime() > now.getTime()) {
        await client.query("COMMIT");
        return {
          allowed: false,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((blockedUntil.getTime() - now.getTime()) / 1000),
          ),
        };
      }
      let attemptCount = row.attempt_count;
      let windowStartedAt = new Date(row.window_started_at);
      if (windowStartedAt.getTime() <= now.getTime() - WINDOW_MS) {
        attemptCount = 0;
        windowStartedAt = now;
        await client.query(
          `UPDATE password_sign_in_attempts
              SET attempt_count = 0, window_started_at = $2, blocked_until = NULL,
                  updated_at = $2
            WHERE key_hash = $1`,
          [bucket.key, nowIso],
        );
      }
      if (attemptCount >= bucket.maxAttempts) {
        const blockedUntil = new Date(now.getTime() + BLOCK_MS);
        await client.query(
          `UPDATE password_sign_in_attempts
              SET blocked_until = $2, updated_at = $3
            WHERE key_hash = $1`,
          [bucket.key, blockedUntil.toISOString(), nowIso],
        );
        await client.query("COMMIT");
        return { allowed: false, retryAfterSeconds: Math.ceil(BLOCK_MS / 1000) };
      }
      rows.push({
        key: bucket.key,
        maxAttempts: bucket.maxAttempts,
        attemptCount,
        windowStartedAt,
      });
    }
    for (const row of rows) {
      await client.query(
        `UPDATE password_sign_in_attempts
            SET attempt_count = $2, updated_at = $3
          WHERE key_hash = $1`,
        [row.key, row.attemptCount + 1, nowIso],
      );
    }
    await client.query("COMMIT");
    return { allowed: true, retryAfterSeconds: 0 };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function clearPasswordSignInAttempts(
  client: PoolClient,
  buckets: PasswordAttemptBucket[],
): Promise<void> {
  const keys = normalized(buckets).map((bucket) => bucket.key);
  if (keys.length === 0) return;
  await client.query("DELETE FROM password_sign_in_attempts WHERE key_hash = ANY($1::text[])", [
    keys,
  ]);
}

export async function revokeUserSessions(client: PoolClient, userId: string): Promise<void> {
  await client.query(
    "UPDATE users SET stamp = gen_random_uuid()::text, updated_at = now() WHERE id = $1",
    [userId],
  );
}
