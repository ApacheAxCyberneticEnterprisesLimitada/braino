import { withClient } from "@doco/db";
import {
  clearPasswordSignInAttempts,
  getSingleWorkspaceState,
  initializeSingleWorkspace,
  reservePasswordSignInAttempt,
  revokeUserSessions,
} from "@doco/host";
import { Form, Link, data, redirect, useActionData, useLoaderData } from "react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { CollectionTypeIcon } from "~/components/collection-type-icon";
import { PageHeader } from "~/components/page-header";
import { NarrowPageMain, PageMain } from "~/components/page-main";
import { getCurrentUser } from "~/lib/current-user.server";
import { hashPassword, passwordError, verifyPassword } from "~/lib/password.server";
import {
  MAX_FORM_BODY_BYTES,
  RequestBodyError,
  readBoundedUrlEncodedForm,
} from "~/lib/request-body.server";
import { safeReturnPath } from "~/lib/safe-return-path";
import { clearSessionCookie, createSessionCookie } from "~/lib/session.server";
import { setupTokenError } from "~/lib/setup-token.server";
import { passwordAttemptBuckets } from "~/lib/sign-in.server";

interface DashboardCollection {
  id: string;
  handle: string;
  goal: string;
  template_handle: string;
  items: number;
  last_updated_at: string | null;
}

interface WorkspaceView {
  id: string;
  handle: string;
  name: string;
  constitution: string;
}

type LoaderData =
  | { screen: "setup" }
  | { screen: "signin"; workspaceName: string; next: string }
  | {
      screen: "dashboard";
      workspace: WorkspaceView;
      user: { id: string; email: string; username: string; name: string };
      collections: DashboardCollection[];
    };

export function meta() {
  return [{ title: "Braino" }, { name: "description", content: "Decisions that stay aligned." }];
}

export async function loader({ request }: { request: Request }): Promise<LoaderData> {
  const state = await withClient(getSingleWorkspaceState);
  if (!state.initialized) return { screen: "setup" };
  const user = await getCurrentUser(request);
  if (!user) {
    return {
      screen: "signin",
      workspaceName: state.workspace.name,
      next: safeReturnPath(new URL(request.url).searchParams.get("next")),
    };
  }
  return withClient(async (client) => {
    const workspaceResult = await client.query<WorkspaceView>(
      "SELECT id, handle, name, constitution FROM workspaces WHERE id = $1",
      [state.workspace.id],
    );
    const workspace = workspaceResult.rows[0];
    if (!workspace) throw new Error("The Braino workspace is missing.");
    const result = await client.query<DashboardCollection>(
      `SELECT c.id, c.handle, c.goal,
              coalesce(c.data->>'template_handle', '') AS template_handle,
              count(n.id)::int AS items,
              max(n.updated_at)::text AS last_updated_at
         FROM collections c
         JOIN workspace_users wu ON wu.workspace_id = c.workspace_id
         LEFT JOIN nodes n ON n.collection_id = c.id
        WHERE c.workspace_id = $1 AND wu.user_id = $2 AND c.deleted_at IS NULL
        GROUP BY c.id, c.handle, c.goal, c.data
        ORDER BY c.handle`,
      [workspace.id, user.id],
    );
    return { screen: "dashboard", workspace, user, collections: result.rows };
  });
}

function rawText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

function text(form: FormData, name: string): string {
  return rawText(form, name).trim();
}

export async function action({ request }: { request: Request }) {
  let form: FormData;
  try {
    form = await readBoundedUrlEncodedForm(request, MAX_FORM_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return data({ error: error.message }, { status: error.status });
    }
    throw error;
  }
  const intent = text(form, "intent");
  if (intent === "signout") {
    const user = await getCurrentUser(request);
    if (user) await withClient((client) => revokeUserSessions(client, user.id));
    return redirect("/", { headers: { "Set-Cookie": clearSessionCookie() } });
  }

  const state = await withClient(getSingleWorkspaceState);
  if (intent === "setup") {
    if (state.initialized)
      return data({ error: "Braino is already initialized." }, { status: 409 });
    const invalidSetupToken = setupTokenError(text(form, "setup_token"));
    if (invalidSetupToken) return data({ error: invalidSetupToken }, { status: 403 });
    const password = rawText(form, "password");
    const error = passwordError(password);
    if (error) return data({ error }, { status: 400 });
    try {
      const ownerPasswordHash = await hashPassword(password);
      const initialized = await withClient((client) =>
        initializeSingleWorkspace(client, {
          workspaceHandle: text(form, "workspace_handle"),
          workspaceName: text(form, "workspace_name"),
          ownerEmail: text(form, "owner_email"),
          ownerUsername: text(form, "owner_username"),
          ownerName: text(form, "owner_name"),
          ownerPasswordHash,
        }),
      );
      return redirect("/", {
        headers: {
          "Set-Cookie": createSessionCookie({
            userId: initialized.owner.id,
            stamp: initialized.owner.stamp,
          }),
        },
      });
    } catch (caught) {
      return data(
        { error: caught instanceof Error ? caught.message : "Setup failed." },
        { status: 400 },
      );
    }
  }

  if (intent === "signin") {
    if (!state.initialized) return data({ error: "Finish setup first." }, { status: 409 });
    const email = text(form, "email").toLowerCase();
    const password = rawText(form, "password");
    const attemptBuckets = passwordAttemptBuckets(request, email);
    const signIn = await withClient(async (client) => {
      const result = await client.query<{
        id: string;
        password_hash: string | null;
        stamp: string;
      }>(
        `SELECT u.id, u.password_hash, u.stamp
           FROM users u
           JOIN workspace_users wu ON wu.user_id = u.id
          WHERE lower(u.email) = $1 AND wu.workspace_id = $2 AND u.deactivated_at IS NULL
          LIMIT 1`,
        [email, state.workspace.id],
      );
      return {
        account: result.rows[0] ?? null,
        reservation: await reservePasswordSignInAttempt(client, attemptBuckets),
      };
    });
    if (!signIn.reservation.allowed) {
      return data(
        { error: "Too many sign-in attempts. Try again later." },
        {
          status: 429,
          headers: { "Retry-After": String(signIn.reservation.retryAfterSeconds) },
        },
      );
    }
    if (
      !(await verifyPassword(password, signIn.account?.password_hash ?? null)) ||
      !signIn.account
    ) {
      return data({ error: "Email or password is incorrect." }, { status: 400 });
    }
    await withClient((client) => clearPasswordSignInAttempts(client, attemptBuckets));
    return redirect(safeReturnPath(text(form, "next")), {
      headers: {
        "Set-Cookie": createSessionCookie({
          userId: signIn.account.id,
          stamp: signIn.account.stamp,
        }),
      },
    });
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

export default function Home() {
  const data = useLoaderData() as LoaderData;
  const actionData = useActionData() as { error?: string } | undefined;

  if (data.screen === "setup") return <Setup error={actionData?.error} />;
  if (data.screen === "signin") {
    return <SignIn workspaceName={data.workspaceName} next={data.next} error={actionData?.error} />;
  }
  return <WorkspaceHome data={data} />;
}

function Breadcrumb({ children }: { children: React.ReactNode }) {
  return (
    <nav className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
      <Link to="/" className="hover:underline">
        Braino
      </Link>
      <span aria-hidden>›</span>
      <span>{children}</span>
    </nav>
  );
}

function Field({
  label,
  ...input
}: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block text-xs">
      <span className="mb-1 block text-muted-foreground">{label}</span>
      <input
        {...input}
        className="w-full rounded-md px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
      />
    </label>
  );
}

function ErrorMessage({ error }: { error?: string }) {
  return error ? (
    <p className="text-xs text-destructive" role="alert">
      {error}
    </p>
  ) : null;
}

function Setup({ error }: { error?: string }) {
  return (
    <PageMain className="space-y-4 py-6">
      <PageHeader breadcrumb={<Breadcrumb>First run</Breadcrumb>} title="Set up Braino">
        <p className="text-xs text-muted-foreground">
          Create the owner and the one workspace served by this deployment.
        </p>
      </PageHeader>
      <Card>
        <CardContent className="pt-4">
          <Form method="post" className="space-y-4">
            <input type="hidden" name="intent" value="setup" />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Workspace name" name="workspace_name" required />
              <Field
                label="Workspace handle"
                name="workspace_handle"
                required
                pattern="[a-z0-9][a-z0-9_-]*"
                placeholder="my-workspace"
              />
              <Field label="Your name" name="owner_name" required />
              <Field
                label="Username"
                name="owner_username"
                required
                pattern="[a-z0-9][a-z0-9_-]*"
              />
              <Field label="Email" name="owner_email" type="email" required />
              <Field
                label="Setup token"
                name="setup_token"
                type="password"
                autoComplete="off"
                required
              />
              <Field
                label="Password"
                name="password"
                type="password"
                minLength={12}
                maxLength={200}
                autoComplete="new-password"
                required
              />
            </div>
            <ErrorMessage error={error} />
            <button
              type="submit"
              className="neu-button rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
            >
              Create workspace
            </button>
          </Form>
        </CardContent>
      </Card>
    </PageMain>
  );
}

function SignIn({
  workspaceName,
  next,
  error,
}: {
  workspaceName: string;
  next: string;
  error?: string;
}) {
  return (
    <NarrowPageMain className="space-y-4 py-10">
      <Breadcrumb>Sign in</Breadcrumb>
      <Card>
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>Type the email and password of your Braino account.</CardDescription>
        </CardHeader>
        <CardContent>
          <Form method="post" className="space-y-3">
            <input type="hidden" name="intent" value="signin" />
            <input type="hidden" name="next" value={next} />
            <Field label="Email" name="email" type="email" autoComplete="username" required />
            <Field
              label="Password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
            <button
              type="submit"
              className="neu-button flex w-full items-center justify-center rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90"
            >
              Sign in
            </button>
            <ErrorMessage error={error} />
          </Form>
          <p className="mt-4 font-mono text-[11px] text-muted-foreground">{workspaceName}</p>
        </CardContent>
      </Card>
    </NarrowPageMain>
  );
}

function WorkspaceHome({ data }: { data: Extract<LoaderData, { screen: "dashboard" }> }) {
  const paragraphs = data.workspace.constitution
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  return (
    <PageMain className="space-y-6 py-6">
      <PageHeader
        breadcrumb={<Breadcrumb>Workspaces › {data.workspace.handle}</Breadcrumb>}
        title={data.workspace.handle}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-mono text-xs text-muted-foreground">{data.workspace.id}</p>
          <div className="flex items-center gap-2">
            <Link
              to="/mcp-tokens"
              className="neu-button rounded-md px-3 py-1.5 text-xs font-semibold"
            >
              MCP
            </Link>
            <Link
              to="/collaborators"
              className="neu-button rounded-md px-3 py-1.5 text-xs font-semibold"
            >
              Collaborators
            </Link>
          </div>
        </div>
      </PageHeader>

      <Card>
        <CardContent className="space-y-3 pt-4">
          <div className="flex flex-wrap items-center gap-1.5">
            {data.collections.map((collection) => (
              <Link
                to={`/${collection.handle}`}
                title={collection.handle}
                aria-label={collection.handle}
                className="neu-button neu-small flex h-7 w-7 items-center justify-center rounded-md"
                key={collection.id}
              >
                <CollectionTypeIcon template={collection.template_handle} />
              </Link>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {data.collections.length} collections · Signed in as {data.user.name}
          </p>
        </CardContent>
      </Card>

      <section className="neu-surface rounded-lg bg-card px-4 py-3">
        <h2 className="text-sm font-semibold">Collections in this workspace</h2>
        <ul className="mt-3 space-y-1.5">
          {data.collections.map((collection) => (
            <li className="flex min-w-0 items-baseline gap-2" key={collection.id}>
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-muted-foreground" />
              <Link
                to={`/${collection.handle}`}
                className="min-w-0 truncate text-sm font-semibold text-primary hover:underline"
              >
                {collection.handle}
              </Link>
              <span className="text-[11px] text-muted-foreground">
                ({collection.items} {collection.items === 1 ? "record" : "records"})
              </span>
              <span className="ml-auto hidden text-[11px] text-muted-foreground sm:block">
                {collection.last_updated_at ? "has activity" : "no activity yet"}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <Card>
        <CardContent className="px-6 py-7 sm:px-10 sm:py-9">
          <article>
            <h2 className="text-center text-lg font-semibold uppercase tracking-[0.2em] sm:text-2xl sm:tracking-[0.25em]">
              Constitution
            </h2>
            <p className="mt-1 text-center font-mono text-[11px] uppercase tracking-[0.3em] text-muted-foreground">
              of {data.workspace.handle}
            </p>
            <div className="mx-auto mt-4 h-px w-24 bg-border" />
            {paragraphs.length ? (
              <div className="mt-6 space-y-4 hyphens-auto text-sm leading-7">
                {paragraphs.map((paragraph, index) => (
                  <p
                    key={paragraph}
                    className={
                      index === 0
                        ? "flow-root first-letter:float-left first-letter:mr-2 first-letter:mt-1 first-letter:text-5xl first-letter:font-semibold first-letter:leading-none"
                        : undefined
                    }
                  >
                    {paragraph}
                  </p>
                ))}
              </div>
            ) : (
              <p className="mt-6 text-center text-sm italic text-muted-foreground">
                No constitution has been written yet.
              </p>
            )}
          </article>
        </CardContent>
      </Card>
    </PageMain>
  );
}
