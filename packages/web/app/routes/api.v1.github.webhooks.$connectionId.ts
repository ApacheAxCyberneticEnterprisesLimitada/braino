import { withClient } from "@doco/db";
import { GithubConnectionError, deliverGithubWebhook } from "@doco/host";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function encryptionKey(): string {
  const value = process.env.DOCO_ENCRYPTION_KEY?.trim();
  if (!value || value.length < 32) {
    throw new Error("DOCO_ENCRYPTION_KEY must contain at least 32 characters.");
  }
  return value;
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { connectionId?: string };
}) {
  const connectionId = params.connectionId?.trim();
  if (!connectionId) {
    return Response.json({ error: "GitHub connection is required." }, { status: 404 });
  }
  const length = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    return Response.json({ error: "GitHub webhook payload is too large." }, { status: 413 });
  }
  const body = await request.text();
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    return Response.json({ error: "GitHub webhook payload is too large." }, { status: 413 });
  }
  try {
    const result = await withClient((client) =>
      deliverGithubWebhook(client, {
        connectionId,
        deliveryId: request.headers.get("x-github-delivery") ?? "",
        event: request.headers.get("x-github-event") ?? "",
        signature: request.headers.get("x-hub-signature-256") ?? "",
        body,
        encryptionKey: encryptionKey(),
      }),
    );
    return Response.json(result);
  } catch (error) {
    if (error instanceof GithubConnectionError) {
      return Response.json({ error: error.message, code: error.code }, { status: error.status });
    }
    return Response.json({ error: "GitHub webhook failed." }, { status: 500 });
  }
}
