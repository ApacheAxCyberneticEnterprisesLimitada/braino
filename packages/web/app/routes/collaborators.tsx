import type { CollectionRole } from "@doco/db";
import { withClient } from "@doco/db";
import {
  WorkspaceAccessError,
  addWorkspaceCollaborator,
  getSingleWorkspaceState,
  listWorkspaceCollaborators,
  removeWorkspaceCollaborator,
  updateWorkspaceCollaborator,
} from "@doco/host";
import { WRITABLE_TYPES } from "@doco/shared";
import { Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { PageHeader } from "~/components/page-header";
import { PageMain } from "~/components/page-main";
import { getCurrentUser } from "~/lib/current-user.server";
import { hashPassword, passwordError } from "~/lib/password.server";

interface LoaderData {
  workspace: { id: string; handle: string };
  currentUserId: string;
  canManage: boolean;
  collaborators: Awaited<ReturnType<typeof listWorkspaceCollaborators>>;
}

interface ActionData {
  error?: string;
}

export function meta() {
  return [{ title: "Collaborators · Braino" }];
}

export async function loader({ request }: { request: Request }): Promise<LoaderData | Response> {
  const user = await getCurrentUser(request);
  if (!user) return redirect("/");
  const state = await withClient(getSingleWorkspaceState);
  if (!state.initialized) return redirect("/");
  return withClient(async (client) => {
    const membership = await client.query<{ role: string }>(
      "SELECT role FROM workspace_users WHERE workspace_id = $1 AND user_id = $2",
      [state.workspace.id, user.id],
    );
    if (!membership.rows[0]) return redirect("/");
    return {
      workspace: state.workspace,
      currentUserId: user.id,
      canManage: membership.rows[0].role === "owner",
      collaborators: await listWorkspaceCollaborators(client, state.workspace.id),
    };
  });
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function role(form: FormData): CollectionRole {
  return text(form, "role") as CollectionRole;
}

function writeTypes(form: FormData): string[] {
  return form.getAll("write_types").filter((value): value is string => typeof value === "string");
}

export async function action({ request }: { request: Request }): Promise<Response | ActionData> {
  const user = await getCurrentUser(request);
  if (!user) return Response.json({ error: "Sign in to manage collaborators." }, { status: 401 });
  const state = await withClient(getSingleWorkspaceState);
  if (!state.initialized) return Response.json({ error: "Finish setup first." }, { status: 409 });
  const form = await request.formData();
  const intent = text(form, "intent");
  try {
    if (intent === "add") {
      const password = text(form, "password");
      const invalidPassword = passwordError(password);
      if (invalidPassword) return { error: invalidPassword };
      const passwordHash = await hashPassword(password);
      await withClient((client) =>
        addWorkspaceCollaborator(client, {
          workspaceId: state.workspace.id,
          actorId: user.id,
          email: text(form, "email"),
          username: text(form, "username"),
          name: text(form, "name"),
          passwordHash,
          role: role(form),
          writeTypes: writeTypes(form),
        }),
      );
    } else if (intent === "update") {
      await withClient((client) =>
        updateWorkspaceCollaborator(client, {
          workspaceId: state.workspace.id,
          actorId: user.id,
          userId: text(form, "user_id"),
          role: role(form),
          writeTypes: writeTypes(form),
        }),
      );
    } else if (intent === "remove") {
      await withClient((client) =>
        removeWorkspaceCollaborator(client, {
          workspaceId: state.workspace.id,
          actorId: user.id,
          userId: text(form, "user_id"),
        }),
      );
    } else {
      return { error: "Unknown collaborator action." };
    }
    return redirect("/collaborators");
  } catch (error) {
    if (error instanceof WorkspaceAccessError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    const pgError = error as { code?: string; constraint?: string };
    if (pgError.code === "23505") {
      return Response.json({ error: "That email or username is already in use." }, { status: 409 });
    }
    throw error;
  }
}

function Breadcrumb({ handle }: { handle: string }) {
  return (
    <nav className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
      <Link to="/" className="hover:underline">
        Braino
      </Link>
      <span aria-hidden>›</span>
      <Link to="/" className="hover:underline">
        {handle}
      </Link>
      <span aria-hidden>›</span>
      <span>Collaborators</span>
    </nav>
  );
}

function WriteTypeSelect({ selected }: { selected?: string[] }) {
  return (
    <label className="block text-xs">
      <span className="mb-1 block text-muted-foreground">Per-type writes for readers</span>
      <select
        name="write_types"
        multiple
        defaultValue={selected?.includes("*") ? [] : selected}
        className="min-h-28 w-full rounded-md px-3 py-2 text-sm"
      >
        {WRITABLE_TYPES.map((type) => (
          <option value={type} key={type}>
            {type}
          </option>
        ))}
      </select>
    </label>
  );
}

function RoleSelect({ value }: { value?: CollectionRole }) {
  return (
    <label className="block text-xs">
      <span className="mb-1 block text-muted-foreground">Role</span>
      <select
        name="role"
        defaultValue={value ?? "writer"}
        className="w-full rounded-md px-3 py-2 text-sm"
      >
        <option value="owner">Owner</option>
        <option value="writer">Writer</option>
        <option value="reader">Reader</option>
      </select>
    </label>
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

export default function Collaborators() {
  const data = useLoaderData() as LoaderData;
  const actionData = useActionData() as ActionData | undefined;
  return (
    <PageMain className="space-y-6 py-6">
      <PageHeader breadcrumb={<Breadcrumb handle={data.workspace.handle} />} title="Collaborators">
        <p className="text-xs text-muted-foreground">
          People who can sign in to this workspace and the records they may author.
        </p>
      </PageHeader>

      {actionData?.error ? (
        <p role="alert" className="text-sm text-destructive">
          {actionData.error}
        </p>
      ) : null}

      <section className="space-y-3">
        {data.collaborators.map((person) => {
          const self = person.id === data.currentUserId;
          return (
            <Card key={person.id}>
              <CardContent className="pt-4">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <h2 className="text-sm font-semibold">{person.name}</h2>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    @{person.username} · {person.email}
                  </span>
                  <span className="ml-auto text-xs capitalize text-muted-foreground">
                    {person.role}
                  </span>
                </div>
                {data.canManage && !self ? (
                  <Form method="post" className="mt-4 grid gap-3 sm:grid-cols-2">
                    <input type="hidden" name="user_id" value={person.id} />
                    <RoleSelect value={person.role} />
                    <WriteTypeSelect selected={person.write_types} />
                    <div className="flex items-end gap-2 sm:col-span-2 sm:justify-end">
                      <button
                        type="submit"
                        name="intent"
                        value="remove"
                        className="neu-button rounded-md px-3 py-2 text-xs font-semibold text-destructive"
                      >
                        Remove access
                      </button>
                      <button
                        type="submit"
                        name="intent"
                        value="update"
                        className="neu-button rounded-md bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground"
                      >
                        Save access
                      </button>
                    </div>
                  </Form>
                ) : null}
              </CardContent>
            </Card>
          );
        })}
      </section>

      {data.canManage ? (
        <Card>
          <CardHeader>
            <CardTitle>Add collaborator</CardTitle>
            <CardDescription>
              Create their sign-in account and grant access to this deployment&apos;s workspace.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Form method="post" className="grid gap-3 sm:grid-cols-2">
              <input type="hidden" name="intent" value="add" />
              <Field label="Name" name="name" required />
              <Field label="Username" name="username" pattern="[a-z0-9][a-z0-9_-]*" required />
              <Field label="Email" name="email" type="email" required />
              <Field
                label="Password"
                name="password"
                type="password"
                minLength={12}
                autoComplete="new-password"
                required
              />
              <RoleSelect />
              <WriteTypeSelect />
              <div className="sm:col-span-2 sm:text-right">
                <button
                  type="submit"
                  className="neu-button rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
                >
                  Add collaborator
                </button>
              </div>
            </Form>
          </CardContent>
        </Card>
      ) : null}
    </PageMain>
  );
}
