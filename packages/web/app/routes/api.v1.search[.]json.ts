import { withClient } from "@doco/db";
import { getSingleWorkspaceState, searchWorkspaceRecords } from "@doco/host";
import { getCurrentUser } from "~/lib/current-user.server";

export async function loader({ request }: { request: Request }) {
  const user = await getCurrentUser(request);
  if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });
  const state = await withClient(getSingleWorkspaceState);
  if (!state.initialized) return Response.json({ error: "Finish setup first." }, { status: 409 });
  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim().slice(0, 500) ?? "";
  if (!query) return Response.json({ error: "Query parameter q is required." }, { status: 400 });
  const requestedLimit = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : undefined;
  const results = await withClient((client) =>
    searchWorkspaceRecords(client, {
      workspaceId: state.workspace.id,
      userId: user.id,
      query,
      ...(limit === undefined ? {} : { limit }),
    }),
  );
  return Response.json({ query, results });
}
