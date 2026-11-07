import { listWorkspacesForUser } from "@doco/db";
import { getCurrentUser } from "~/lib/current-user.server.js";

export async function loader({ request }: { request: Request }) {
  const user = await getCurrentUser(request);
  if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });
  const workspaces = await listWorkspacesForUser(user.id);
  if (workspaces.length > 1) {
    return Response.json({ error: "Single-workspace invariant violated." }, { status: 500 });
  }
  return Response.json({
    workspaces: workspaces.map(({ id, handle, name, member_count }) => ({
      id,
      handle,
      name,
      member_count,
    })),
  });
}

export function action() {
  return Response.json(
    { error: "This deployment already owns its sole workspace." },
    { status: 405, headers: { Allow: "GET" } },
  );
}
