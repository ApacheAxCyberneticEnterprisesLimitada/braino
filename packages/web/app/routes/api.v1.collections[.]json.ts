import { withClient } from "@doco/db";
import { getCurrentUser } from "~/lib/current-user.server.js";

export async function loader({ request }: { request: Request }) {
  const user = await getCurrentUser(request);
  if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });
  const collections = await withClient(async (client) => {
    const result = await client.query<{
      id: string;
      handle: string;
      workspace_id: string;
      workspace_handle: string;
    }>(
      `SELECT c.id, c.handle, c.workspace_id, w.handle AS workspace_handle
         FROM collections c
         JOIN workspaces w ON w.id = c.workspace_id
         JOIN workspace_users wu ON wu.workspace_id = w.id
        WHERE wu.user_id = $1 AND c.deleted_at IS NULL
        ORDER BY c.handle`,
      [user.id],
    );
    return result.rows;
  });
  return Response.json({
    collections: collections.map((collection) => ({
      ...collection,
      qualified_handle: `${collection.workspace_handle}/${collection.handle}`,
    })),
  });
}
