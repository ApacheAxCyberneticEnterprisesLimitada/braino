import { withClient } from "@doco/db";

export interface AccessibleCollection {
  id: string;
  handle: string;
  goal: string;
  workspace_id: string;
  default_node_lifecycle: string | null;
  template_handle: string;
}

export async function getCollectionForUser(
  handle: string,
  userId: string,
): Promise<AccessibleCollection | null> {
  return withClient(async (client) => {
    const result = await client.query<AccessibleCollection>(
      `SELECT c.id, c.handle, c.goal, c.workspace_id, c.default_node_lifecycle,
              coalesce(c.data->>'template_handle', '') AS template_handle
         FROM collections c
        WHERE c.handle = $1
          AND c.deleted_at IS NULL
          AND (
            EXISTS (
              SELECT 1 FROM workspace_users wu
               WHERE wu.workspace_id = c.workspace_id AND wu.user_id = $2
            )
            OR EXISTS (
              SELECT 1 FROM collection_users cu
               WHERE cu.collection_id = c.id AND cu.user_id = $2
            )
          )`,
      [handle, userId],
    );
    return result.rows[0] ?? null;
  });
}
