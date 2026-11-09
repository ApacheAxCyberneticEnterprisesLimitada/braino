// The Workspace "constitution" — a free-form, workspace-level governing text
// that is shared with every agent granted access to the workspace when it
// bootstraps. It is the standing charter for how work is done across all
// of the workspace's collections.
//
// It says what to record and where, naming the collections a new workspace
// starts with, because Braino's agent instructions name none: a workspace may
// not have them, and its owner words its own (Alexander, 2026-10-21: "the
// instructions shouldn't make reference to it. The Constitutions should.").
// A decision goes where what was chosen belongs, not where the work happened
// (after an agent filed a change to what Pros are paid in Architectural
// decisions because it shipped as code).
//
// This is the SINGLE SOURCE OF TRUTH for the default text. New workspaces are
// seeded with it by `addWorkspaceByHandle` (packages/host/src/host.ts). The
// Security decisions line reached the existing workspaces through a one-off
// production backfill, not schema.sql: a schema.sql change re-applies the
// whole file on the next request.

export const DEFAULT_WORKSPACE_CONSTITUTION = `Follow the policies of every collection in this workspace. They bind: when two seem to conflict, say so rather than picking one.

Document what a future collaborator, person or agent, would need for context: the reasoning behind decisions, the constraints that ruled out alternatives, and the rules that emerged. If it would be hard to reconstruct later, write it down now.

Record each chat as a Log in Agents chats, in one short line: who asked for what and what came of it.

Record each decision as it is made, as a Decision with the question, the choice, and the alternatives that lost and why. Put it in:

- Product decisions when it sets what users or the business get (what to build, fix, charge or pay), even when it ships as code;
- Design decisions when it sets how something looks or behaves for the people using it;
- Architectural decisions when it sets how the system does it: structure, technology, data;
- Security decisions when it sets how the system and its data are protected: who gets access, secrets, threats, and the risks accepted.

A choice with both sides is two Decisions, each citing the other's id.

When a decision changes a business process, change that process in Processes too, citing the decision's id.`;
