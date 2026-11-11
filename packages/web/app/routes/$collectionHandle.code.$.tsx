import { withClient } from "@doco/db";
import { ExternalLink } from "lucide-react";
import { Link, redirect, useLoaderData } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { PageHeader } from "~/components/page-header";
import { PageMain } from "~/components/page-main";
import { getCollectionForUser } from "~/lib/collection-access.server";
import { getCurrentUser } from "~/lib/current-user.server";

interface CodeFileRow {
  repo: string;
  path: string;
  size: number;
  content: string;
  omitted: "binary" | "too_large" | "unavailable" | null;
  synced_at: string;
}

interface CodeRelationRow {
  id: string;
  source: string;
  target: string;
  relation_type: string;
  confidence: number | string;
}

function selectedCodeFile(value: string): { repo: string; path: string } | null {
  const parts = value.split("/").filter(Boolean);
  if (parts.length < 3) return null;
  return { repo: `${parts[0]}/${parts[1]}`, path: parts.slice(2).join("/") };
}

function codeHref(handle: string, repo: string, path: string): string {
  return `/${handle}/code/${[...repo.split("/"), ...path.split("/")]
    .map(encodeURIComponent)
    .join("/")}`;
}

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { collectionHandle?: string; "*"?: string };
}) {
  const user = await getCurrentUser(request);
  if (!user) throw redirect("/");
  const collection = await getCollectionForUser(params.collectionHandle ?? "", user.id);
  if (!collection || collection.template_handle !== "codebase") {
    throw new Response("Codebase not found", { status: 404 });
  }
  const selected = selectedCodeFile(params["*"] ?? "");
  return withClient(async (client) => {
    const files = await client.query<CodeFileRow>(
      `SELECT repo, path, size,
              CASE WHEN $2::text IS NULL THEN '' ELSE content END AS content,
              omitted, synced_at::text
         FROM code_files
        WHERE collection_id = $1
          AND ($2::text IS NULL OR (repo = $2 AND path = $3))
        ORDER BY repo, path
        LIMIT 1000`,
      [collection.id, selected?.repo ?? null, selected?.path ?? null],
    );
    if (selected && !files.rows[0]) throw new Response("Code file not found", { status: 404 });
    const focusedName = selected ? `${selected.repo}/${selected.path}` : null;
    const relationships = await client.query<CodeRelationRow>(
      `SELECT r.id, source.name AS source, target.name AS target,
              r.relation_type, r.confidence
         FROM retrieval_relations r
         JOIN retrieval_entities source ON source.id = r.from_entity_id
         JOIN retrieval_entities target ON target.id = r.to_entity_id
        WHERE r.collection_id = $1
          AND ($2::text IS NULL OR source.name = $2 OR target.name = $2)
        ORDER BY r.confidence DESC, source.name, target.name, r.id
        LIMIT 1000`,
      [collection.id, focusedName],
    );
    return { collection, selected, files: files.rows, relationships: relationships.rows };
  });
}

export function meta({ data }: { data?: Awaited<ReturnType<typeof loader>> }) {
  const title = data?.selected?.path ?? "Codebase";
  return [{ title: `${title} · Braino` }];
}

export default function CodebasePage() {
  const data = useLoaderData() as Awaited<ReturnType<typeof loader>>;
  const file = data.selected ? data.files[0] : null;
  return (
    <PageMain className="space-y-6 py-6">
      <PageHeader
        breadcrumb={
          <nav className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            <Link to="/" className="hover:underline">
              Braino
            </Link>
            <span aria-hidden>›</span>
            <Link to={`/${data.collection.handle}/code`} className="hover:underline">
              {data.collection.handle}
            </Link>
            {file ? (
              <>
                <span aria-hidden>›</span>
                <span>{file.path}</span>
              </>
            ) : null}
          </nav>
        }
        title={file?.path ?? "Codebase"}
      >
        <p className="text-sm text-muted-foreground">
          {file ? file.repo : "Repository files and deterministic CodeLinker relationships."}
        </p>
      </PageHeader>

      {file ? (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle>{file.path}</CardTitle>
              <a
                href={`https://github.com/${file.repo}/blob/HEAD/${file.path}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs hover:underline"
              >
                GitHub <ExternalLink className="size-3" />
              </a>
            </div>
          </CardHeader>
          <CardContent>
            {file.omitted ? (
              <p className="text-sm text-muted-foreground">
                Content omitted: {file.omitted.replaceAll("_", " ")}.
              </p>
            ) : (
              <pre className="neu-well max-h-[70vh] overflow-auto rounded-md p-4 text-xs leading-5">
                <code>{file.content}</code>
              </pre>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Repository files</CardTitle>
          </CardHeader>
          <CardContent>
            {data.files.length ? (
              <ul className="divide-y divide-border">
                {data.files.map((item) => (
                  <li key={`${item.repo}/${item.path}`} className="py-2 first:pt-0 last:pb-0">
                    <Link
                      to={codeHref(data.collection.handle, item.repo, item.path)}
                      className="font-mono text-xs hover:underline"
                    >
                      {item.repo}/{item.path}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                Sync GitHub to import repository code.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Code relationships</CardTitle>
        </CardHeader>
        <CardContent>
          {data.relationships.length ? (
            <ul className="space-y-2">
              {data.relationships.map((relationship) => (
                <li key={relationship.id} className="font-mono text-xs">
                  {relationship.source} <strong>{relationship.relation_type}</strong>{" "}
                  {relationship.target}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              No relationships were found for this selection.
            </p>
          )}
        </CardContent>
      </Card>
    </PageMain>
  );
}
