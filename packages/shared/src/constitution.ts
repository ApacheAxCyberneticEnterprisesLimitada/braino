// The Doco "constitution" — a free-form, project-level governing text
// that every agent reads when it bootstraps against a Doco. Where the
// `goal` is a one-liner about what the Doco is for, the constitution is
// the standing charter: how work is expected to be done here.
//
// This is the SINGLE SOURCE OF TRUTH for the default text. New Docos are
// seeded with it by `createDocoInOrg` (packages/host/src/host.ts), and
// existing rows are backfilled to it by migration
// `068_doco_constitution.sql`. Those two SQL copies are kept byte-for-byte
// in sync with this constant by a guard test
// (packages/db/src/__tests__/constitution-default.test.ts), so edit all
// three together.

export const DEFAULT_DOCO_CONSTITUTION = `This is a spec-driven development project. Capture the intent, decision, and specification behind a change before writing the code that implements it, and let the documented spec lead the work.

Follow the policies of every Doco in this organization. They are binding, not advisory: when two policies appear to conflict, surface the conflict rather than silently choosing one.

Document anything a future collaborator, whether a person or an agent, would need to gain context later: the reasoning behind decisions, the constraints that ruled out alternatives, and the rules that emerged along the way. If it would be hard to reconstruct later, write it down now.`;
