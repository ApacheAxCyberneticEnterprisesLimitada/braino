import { withClient } from "@doco/db";
import { ChangesetError, applyChangeset } from "@doco/host";
import { getCurrentUser } from "~/lib/current-user.server.js";
import {
  MAX_JSON_BODY_BYTES,
  RequestBodyError,
  readBoundedJson,
} from "~/lib/request-body.server.js";

export function loader() {
  return Response.json(
    {
      error:
        "Use POST with { operations: [...] }. See /<collection-handle>/api/authoring-contract.json for the supported operations.",
    },
    { status: 405, headers: { Allow: "POST" } },
  );
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { collectionHandle?: string };
}) {
  if (request.method !== "POST") {
    return Response.json({ error: "Use POST." }, { status: 405, headers: { Allow: "POST" } });
  }
  const user = await getCurrentUser(request);
  if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });
  let body: { operations?: unknown; reason?: unknown };
  try {
    body = (await readBoundedJson(request, MAX_JSON_BODY_BYTES)) as {
      operations?: unknown;
      reason?: unknown;
    };
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
  try {
    const result = await withClient((client) =>
      applyChangeset(client, {
        collectionHandle: params.collectionHandle ?? "",
        actorId: user.id,
        operations: body.operations,
        source: "api",
        reason: typeof body.reason === "string" ? body.reason.trim() || null : null,
        metadata: { route: "changesets" },
      }),
    );
    return Response.json(result);
  } catch (error) {
    if (error instanceof ChangesetError) {
      return Response.json(
        {
          ok: false,
          error: error.message,
          code: error.code,
          ...(error.operationIndex === undefined ? {} : { op_index: error.operationIndex }),
        },
        { status: error.status },
      );
    }
    throw error;
  }
}
