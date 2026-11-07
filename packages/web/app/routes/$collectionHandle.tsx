import { withClient } from "@doco/db";
import { redirect, useLoaderData } from "react-router";
import { getCurrentUser } from "~/lib/current-user.server.js";

interface CollectionNode {
  id: string;
  node_type: string;
  title: string;
  lifecycle: string;
  updated_at: string;
}

export async function loader({
  request,
  params,
}: { request: Request; params: { collectionHandle?: string } }) {
  const user = await getCurrentUser(request);
  if (!user) throw redirect("/");
  const data = await withClient(async (client) => {
    const collection = await client.query<{ id: string; handle: string; goal: string }>(
      `SELECT c.id, c.handle, c.goal
         FROM collections c
         JOIN workspace_users wu ON wu.workspace_id = c.workspace_id
        WHERE c.handle = $1 AND wu.user_id = $2 AND c.deleted_at IS NULL`,
      [params.collectionHandle ?? "", user.id],
    );
    const found = collection.rows[0];
    if (!found) return null;
    const nodes = await client.query<CollectionNode>(
      `SELECT id, node_type, coalesce(data->>'title', data->>'name', id) AS title,
              lifecycle, updated_at::text
         FROM nodes
        WHERE collection_id = $1
        ORDER BY updated_at DESC
        LIMIT 100`,
      [found.id],
    );
    return { collection: found, nodes: nodes.rows };
  });
  if (!data) throw new Response("Collection not found", { status: 404 });
  return data;
}

export default function CollectionPage() {
  const data = useLoaderData() as Awaited<ReturnType<typeof loader>>;
  return (
    <main className="shell narrow">
      <p className="eyebrow">
        <a href="/">Doco</a> · Collection
      </p>
      <h1>{data.collection.handle}</h1>
      <p className="lede">{data.collection.goal}</p>
      <section className="panel">
        <h2>Recent records</h2>
        {data.nodes.length ? (
          <ul className="node-list">
            {data.nodes.map((node) => (
              <li key={node.id}>
                <strong>{node.title}</strong>
                <br />
                <span className="muted">
                  {node.node_type} · {node.lifecycle}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">This collection has no records yet.</p>
        )}
      </section>
    </main>
  );
}
