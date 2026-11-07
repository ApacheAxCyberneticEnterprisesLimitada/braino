import { withClient } from "@doco/db";
import { getSingleWorkspaceState, initializeSingleWorkspace } from "@doco/host";
import { Form, redirect, useActionData, useLoaderData } from "react-router";
import { getCurrentUser } from "~/lib/current-user.server.js";
import { hashPassword, passwordError, verifyPassword } from "~/lib/password.server.js";
import { clearSessionCookie, createSessionCookie } from "~/lib/session.server.js";

interface DashboardCollection {
  id: string;
  handle: string;
  goal: string;
  template_handle: string;
}

type LoaderData =
  | { screen: "setup" }
  | { screen: "signin"; workspaceName: string }
  | {
      screen: "dashboard";
      workspace: { id: string; handle: string; name: string };
      user: { id: string; email: string; username: string; name: string };
      collections: DashboardCollection[];
    };

export function meta() {
  return [{ title: "Doco" }, { name: "description", content: "Decisions that stay aligned." }];
}

export async function loader({ request }: { request: Request }): Promise<LoaderData> {
  const state = await withClient(getSingleWorkspaceState);
  if (!state.initialized) return { screen: "setup" };
  const user = await getCurrentUser(request);
  if (!user) return { screen: "signin", workspaceName: state.workspace.name };
  const collections = await withClient(async (client) => {
    const result = await client.query<DashboardCollection>(
      `SELECT c.id, c.handle, c.goal, coalesce(c.data->>'template_handle', '') AS template_handle
         FROM collections c
         JOIN workspace_users wu ON wu.workspace_id = c.workspace_id
        WHERE c.workspace_id = $1 AND wu.user_id = $2 AND c.deleted_at IS NULL
        ORDER BY c.handle`,
      [state.workspace.id, user.id],
    );
    return result.rows;
  });
  return { screen: "dashboard", workspace: state.workspace, user, collections };
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

export async function action({ request }: { request: Request }) {
  const form = await request.formData();
  const intent = text(form, "intent");
  if (intent === "signout") {
    return redirect("/", { headers: { "Set-Cookie": clearSessionCookie() } });
  }

  const state = await withClient(getSingleWorkspaceState);
  if (intent === "setup") {
    if (state.initialized)
      return Response.json({ error: "Doco is already initialized." }, { status: 409 });
    const password = text(form, "password");
    const error = passwordError(password);
    if (error) return Response.json({ error }, { status: 400 });
    if (password !== text(form, "password_confirmation")) {
      return Response.json({ error: "The passwords do not match." }, { status: 400 });
    }
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
        headers: { "Set-Cookie": createSessionCookie(initialized.owner.id) },
      });
    } catch (caught) {
      return Response.json(
        { error: caught instanceof Error ? caught.message : "Setup failed." },
        { status: 400 },
      );
    }
  }

  if (intent === "signin") {
    if (!state.initialized) return Response.json({ error: "Finish setup first." }, { status: 409 });
    const email = text(form, "email").toLowerCase();
    const password = text(form, "password");
    const account = await withClient(async (client) => {
      const result = await client.query<{ id: string; password_hash: string | null }>(
        `SELECT u.id, u.password_hash
           FROM users u
           JOIN workspace_users wu ON wu.user_id = u.id
          WHERE lower(u.email) = $1 AND wu.workspace_id = $2 AND u.deactivated_at IS NULL
          LIMIT 1`,
        [email, state.workspace.id],
      );
      return result.rows[0] ?? null;
    });
    if (!(await verifyPassword(password, account?.password_hash ?? null)) || !account) {
      return Response.json({ error: "Email or password is incorrect." }, { status: 400 });
    }
    return redirect("/", { headers: { "Set-Cookie": createSessionCookie(account.id) } });
  }

  return Response.json({ error: "Unknown action." }, { status: 400 });
}

export default function Home() {
  const data = useLoaderData() as LoaderData;
  const actionData = useActionData() as { error?: string } | undefined;

  if (data.screen === "setup") {
    return (
      <main className="shell narrow">
        <p className="eyebrow">First run</p>
        <h1>Make this Doco yours.</h1>
        <p className="lede">Create the owner and the one workspace served by this deployment.</p>
        <section className="panel">
          <Form method="post">
            <input type="hidden" name="intent" value="setup" />
            {actionData?.error ? <p className="error">{actionData.error}</p> : null}
            <div className="fields">
              <label>
                Workspace name
                <input name="workspace_name" required />
              </label>
              <label>
                Workspace handle
                <input name="workspace_handle" required pattern="[a-z0-9][a-z0-9_-]*" />
              </label>
              <label>
                Your name
                <input name="owner_name" required />
              </label>
              <label>
                Username
                <input name="owner_username" required pattern="[a-z0-9][a-z0-9_-]*" />
              </label>
              <label>
                Email
                <input name="owner_email" type="email" required />
              </label>
              <span />
              <label>
                Password
                <input name="password" type="password" minLength={12} required />
              </label>
              <label>
                Confirm password
                <input name="password_confirmation" type="password" minLength={12} required />
              </label>
            </div>
            <button type="submit">Create Doco</button>
          </Form>
        </section>
      </main>
    );
  }

  if (data.screen === "signin") {
    return (
      <main className="shell narrow">
        <p className="eyebrow">{data.workspaceName}</p>
        <h1>Welcome back.</h1>
        <section className="panel">
          <Form method="post">
            <input type="hidden" name="intent" value="signin" />
            {actionData?.error ? <p className="error">{actionData.error}</p> : null}
            <label>
              Email
              <input name="email" type="email" required />
            </label>
            <label>
              Password
              <input name="password" type="password" required />
            </label>
            <button type="submit">Sign in</button>
          </Form>
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <header className="header">
        <div>
          <p className="eyebrow">Doco · {data.workspace.handle}</p>
          <h1>{data.workspace.name}</h1>
          <p className="lede">The decisions, rules, and evidence your team keeps aligned.</p>
          <div className="stats">
            <span>{data.collections.length} collections</span>
            <span>Signed in as {data.user.name}</span>
          </div>
        </div>
        <Form method="post">
          <input type="hidden" name="intent" value="signout" />
          <button className="secondary" type="submit">
            Sign out
          </button>
        </Form>
      </header>
      <section className="grid">
        {data.collections.map((collection) => (
          <a className="card" href={`/${collection.handle}`} key={collection.id}>
            <strong>{collection.handle}</strong>
            <span>{collection.goal || collection.template_handle || "Collection"}</span>
          </a>
        ))}
      </section>
    </main>
  );
}
