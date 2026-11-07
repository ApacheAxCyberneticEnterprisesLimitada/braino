import { withClient } from "@doco/db";
import { getSingleWorkspaceState } from "@doco/host";

const headers = { "Cache-Control": "no-store" };

export async function loader(): Promise<Response> {
  try {
    const state = await withClient(getSingleWorkspaceState);
    return Response.json({ ok: true, initialized: state.initialized }, { headers });
  } catch (error) {
    console.error("[healthz] PostgreSQL unavailable", error);
    return Response.json({ ok: false }, { status: 503, headers });
  }
}
