import { withClient } from "@doco/db";
import { Link, redirect, useLoaderData } from "react-router";
import { Card, CardContent } from "~/components/card";
import { PageHeader } from "~/components/page-header";
import { PageMain } from "~/components/page-main";
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
      `SELECT id, node_type,
              coalesce(nullif(extra->>'title', ''), nullif(extra->>'name', ''), nullif(prose, ''), id) AS title,
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
    <PageMain className="space-y-6 py-6">
      <PageHeader
        breadcrumb={
          <nav className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            <Link to="/" className="hover:underline">
              Doco
            </Link>
            <span aria-hidden>›</span>
            <span>Collection</span>
          </nav>
        }
        title={data.collection.handle}
      >
        <p className="max-w-3xl text-sm text-muted-foreground">{data.collection.goal}</p>
      </PageHeader>
      <Card>
        <CardContent className="pt-4">
          <h2 className="text-sm font-semibold">Recent records</h2>
          {data.nodes.length ? (
            <ul className="mt-3 divide-y divide-border">
              {data.nodes.map((node) => (
                <li className="py-3 first:pt-0 last:pb-0" key={node.id}>
                  <strong className="text-sm">{node.title}</strong>
                  <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                    {node.node_type} · {node.lifecycle}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-xs italic text-muted-foreground">
              This collection has no records yet.
            </p>
          )}
        </CardContent>
      </Card>
    </PageMain>
  );
}
