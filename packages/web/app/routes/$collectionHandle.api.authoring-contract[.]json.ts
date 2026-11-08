import { CAPTURE_SCHEMAS } from "@doco/shared";
import { getCollectionForUser } from "~/lib/collection-access.server.js";
import { getCurrentUser } from "~/lib/current-user.server.js";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { collectionHandle?: string };
}) {
  const user = await getCurrentUser(request);
  if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });
  const collection = await getCollectionForUser(params.collectionHandle ?? "", user.id);
  if (!collection) return Response.json({ error: "Collection not found." }, { status: 404 });
  return Response.json({
    ok: true,
    collection_id: collection.id,
    node_types: Object.values(CAPTURE_SCHEMAS).map((schema) => ({
      node_type: schema.nodeType,
      collection: schema.collection,
      label: schema.label,
      default_lifecycle: collection.default_node_lifecycle ?? schema.defaultLifecycle,
      fields: schema.fields,
    })),
    changeset_endpoint: `/${collection.handle}/api/changesets.json`,
    operations: {
      create: {
        shape: {
          op: "create",
          node_type: "decision",
          alias: "optional_name",
          body: {
            prose: "The record's canonical text",
            lifecycle: "optional: drafting | queued | active | retired",
            extra: { question: "Optional per-type fields" },
          },
        },
        note: "Creates a node with immutable version history and an audit event. Aliases are returned for use by clients.",
      },
    },
  });
}
