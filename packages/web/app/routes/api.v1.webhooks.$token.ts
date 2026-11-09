import { withClient } from "@doco/db";
import { ChangesetError, IncomingWebhookError, deliverIncomingWebhook } from "@doco/host";
import { MAX_JSON_BODY_BYTES, RequestBodyError, readBoundedJson } from "~/lib/request-body.server";

export function loader() {
  return Response.json(
    { error: "Use POST with an Idempotency-Key header and a changeset JSON body." },
    { status: 405, headers: { Allow: "POST" } },
  );
}

export async function action({
  request,
  params,
}: { request: Request; params: { token?: string } }) {
  if (request.method !== "POST") {
    return Response.json({ error: "Use POST." }, { status: 405, headers: { Allow: "POST" } });
  }
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
      deliverIncomingWebhook(client, {
        accessToken: params.token ?? "",
        idempotencyKey: request.headers.get("idempotency-key") ?? "",
        operations: body.operations,
        reason: typeof body.reason === "string" ? body.reason : null,
      }),
    );
    return Response.json(result);
  } catch (error) {
    if (error instanceof IncomingWebhookError || error instanceof ChangesetError) {
      return Response.json(
        {
          ok: false,
          error: error.message,
          code: error.code,
          ...(error instanceof ChangesetError && error.operationIndex !== undefined
            ? { op_index: error.operationIndex }
            : {}),
        },
        { status: error.status },
      );
    }
    throw error;
  }
}
