import { withClient } from "@doco/db";
import { getSingleWorkspaceState, latestTimesEditionDay, loadTimesEdition } from "@doco/host";
import { Link, redirect, useLoaderData } from "react-router";
import { PageHeader } from "~/components/page-header";
import { PageMain } from "~/components/page-main";
import { getCurrentUser } from "~/lib/current-user.server";

export function meta() {
  return [{ title: "Braino Times" }];
}

export async function loader({ request }: { request: Request }) {
  const state = await withClient(getSingleWorkspaceState);
  if (!state.initialized) throw redirect("/");
  const user = await getCurrentUser(request);
  const day = await withClient((client) => latestTimesEditionDay(client, state.workspace.id));
  if (day) {
    const edition = await withClient((client) =>
      loadTimesEdition(client, {
        workspaceId: state.workspace.id,
        day,
        userId: user?.id ?? null,
      }),
    );
    if (edition.kind === "hidden") throw new Response("Edition not found.", { status: 404 });
    if (edition.kind === "edition") throw redirect(`/times/${day}`);
  }
  return { workspaceName: state.workspace.name };
}

export default function EmptyTimesPage() {
  const { workspaceName } = useLoaderData() as Awaited<ReturnType<typeof loader>>;
  return (
    <PageMain className="space-y-6 py-8">
      <PageHeader
        breadcrumb={
          <Link to="/" className="font-mono text-[11px] text-muted-foreground hover:underline">
            Braino
          </Link>
        }
        title={`The ${workspaceName} Times`}
      >
        <p className="text-sm text-muted-foreground">
          The first edition will appear after the scheduler publishes today’s activity.
        </p>
      </PageHeader>
    </PageMain>
  );
}
