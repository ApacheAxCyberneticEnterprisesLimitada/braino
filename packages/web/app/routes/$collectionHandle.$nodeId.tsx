import { withClient } from "@doco/db";
import { Link, redirect, useLoaderData } from "react-router";
import { Card, CardContent } from "~/components/card";
import { PageHeader } from "~/components/page-header";
import { PageMain } from "~/components/page-main";
import { getCollectionForUser } from "~/lib/collection-access.server";
import { getCurrentUser } from "~/lib/current-user.server";

interface RecordView {
  id: string;
  node_type: string;
  lifecycle: string;
  prose: string;
  locator: string | null;
  extra: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export async function loader({
  request,
  params,
}: { request: Request; params: { collectionHandle?: string; nodeId?: string } }) {
  const user = await getCurrentUser(request);
  if (!user) throw redirect("/");
  const collection = await getCollectionForUser(params.collectionHandle ?? "", user.id);
  if (!collection) throw new Response("Collection not found", { status: 404 });
  const found = await withClient((client) =>
    client.query<RecordView>(
      `SELECT id, node_type, lifecycle, prose, locator, extra,
              created_at::text, updated_at::text
         FROM nodes
        WHERE collection_id = $1 AND id = $2`,
      [collection.id, params.nodeId ?? ""],
    ),
  );
  const record = found.rows[0];
  if (!record) throw new Response("Record not found", { status: 404 });
  return { collection, record };
}

export function meta({ data }: { data?: Awaited<ReturnType<typeof loader>> }) {
  const title = data?.record.prose.split("\n", 1)[0]?.trim();
  return [{ title: title ? `${title} · Doco` : "Record · Doco" }];
}

export default function RecordPage() {
  const data = useLoaderData() as Awaited<ReturnType<typeof loader>>;
  const title =
    String(data.record.extra.title ?? data.record.extra.name ?? "").trim() ||
    data.record.prose.split("\n", 1)[0]?.trim() ||
    data.record.id;
  return (
    <PageMain className="space-y-6 py-6">
      <PageHeader
        breadcrumb={
          <nav className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            <Link to="/" className="hover:underline">
              Doco
            </Link>
            <span aria-hidden>›</span>
            <Link to={`/${data.collection.handle}`} className="hover:underline">
              {data.collection.handle}
            </Link>
            <span aria-hidden>›</span>
            <span>{data.record.node_type}</span>
          </nav>
        }
        title={title}
      >
        <p className="font-mono text-[11px] text-muted-foreground">{data.record.id}</p>
      </PageHeader>
      <Card>
        <CardContent className="space-y-4 pt-4">
          <div className="flex flex-wrap gap-2 font-mono text-[11px] text-muted-foreground">
            <span>{data.record.node_type}</span>
            <span>·</span>
            <span>{data.record.lifecycle}</span>
          </div>
          <div className="whitespace-pre-wrap text-sm leading-7">{data.record.prose}</div>
          {data.record.locator ? (
            <p className="break-all font-mono text-xs text-muted-foreground">
              {data.record.locator}
            </p>
          ) : null}
          {Object.keys(data.record.extra).length ? (
            <pre className="neu-well overflow-x-auto rounded-md p-3 text-xs">
              {JSON.stringify(data.record.extra, null, 2)}
            </pre>
          ) : null}
        </CardContent>
      </Card>
    </PageMain>
  );
}
