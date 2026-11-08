import { withClient } from "@doco/db";
import { getSingleWorkspaceState } from "@doco/host";
import {
  Form,
  Link,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useLoaderData,
  useRouteError,
} from "react-router";
import { DocoMark } from "~/components/doco-mark";
import { PageMain } from "~/components/page-main";
import { type CurrentUser, getCurrentUser } from "~/lib/current-user.server";
import "./app.css";

interface RootData {
  initialized: boolean;
  user: CurrentUser | null;
}

export async function loader({ request }: { request: Request }): Promise<RootData> {
  const state = await withClient(getSingleWorkspaceState);
  return {
    initialized: state.initialized,
    user: state.initialized ? await getCurrentUser(request) : null,
  };
}

export function links() {
  return [{ rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }];
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body className="min-h-screen antialiased">
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  const data = useLoaderData() as RootData;
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <SiteHeader data={data} />
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}

function SiteHeader({ data }: { data: RootData }) {
  return (
    <header className="h-14 border-b border-border bg-card">
      <div className="flex h-full w-full items-center gap-6 px-6">
        <Link to="/" className="inline-flex items-center hover:opacity-80" aria-label="Doco home">
          <DocoMark height={28} />
        </Link>
        <div className="ml-auto flex shrink-0 items-center gap-2 text-xs">
          {data.user ? (
            <>
              <Link
                to="/"
                className="neu-button neu-pressed rounded-md px-2.5 py-1.5 font-semibold"
              >
                Workspace
              </Link>
              <span className="font-mono text-muted-foreground">@{data.user.username}</span>
              <Form method="post" action="/">
                <input type="hidden" name="intent" value="signout" />
                <button type="submit" className="neu-button rounded-md px-2.5 py-1.5 font-semibold">
                  Sign out
                </button>
              </Form>
            </>
          ) : data.initialized ? (
            <Link to="/" className="neu-button neu-pressed rounded-md px-3 py-1.5 font-semibold">
              Sign in
            </Link>
          ) : null}
        </div>
      </div>
    </header>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = isRouteErrorResponse(error) ? error.status : 500;
  const message = isRouteErrorResponse(error)
    ? error.statusText
    : error instanceof Error
      ? error.message
      : "Unexpected error";
  return (
    <PageMain className="space-y-4 py-10">
      <p className="font-mono text-xs text-muted-foreground">Doco</p>
      <div className="neu-surface rounded-lg bg-card p-5">
        <h1 className="text-2xl font-semibold text-destructive">{status}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{message}</p>
        <Link
          className="neu-button mt-4 inline-flex rounded-md px-4 py-2 text-sm font-semibold"
          to="/"
        >
          Return home
        </Link>
      </div>
    </PageMain>
  );
}
