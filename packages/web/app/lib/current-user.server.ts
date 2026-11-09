import { withClient } from "@doco/db";
import { readSessionIdentity } from "./session.server.js";

export interface CurrentUser {
  id: string;
  email: string;
  username: string;
  name: string;
}

export async function getCurrentUser(request: Request): Promise<CurrentUser | null> {
  const identity = readSessionIdentity(request);
  if (!identity) return null;
  return withClient(async (client) => {
    const result = await client.query<CurrentUser>(
      `SELECT id, email, username, coalesce(name, username) AS name
         FROM users
        WHERE id = $1 AND stamp = $2 AND deactivated_at IS NULL`,
      [identity.userId, identity.stamp],
    );
    return result.rows[0] ?? null;
  });
}
