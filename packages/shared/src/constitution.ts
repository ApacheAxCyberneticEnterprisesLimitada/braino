// The Org "constitution" — a free-form, organization-level governing text
// that is shared with every agent granted access to the org when it
// bootstraps. It is the standing charter for how work is done across all
// of the organization's Docos.
//
// This is the SINGLE SOURCE OF TRUTH for the default text. New orgs are
// seeded with it by `addOrganizationByHandle` (packages/host/src/host.ts).
// The schema seed is kept byte-for-byte in sync with this constant by
// packages/db/src/__tests__/constitution-default.test.ts.

export const DEFAULT_ORG_CONSTITUTION = `This is a spec-driven development project. Capture the intent, decision, and specification behind a change before writing the code that implements it, and let the documented spec lead the work.

Follow the policies of every Doco in this organization. They are binding, not advisory: when two policies appear to conflict, surface the conflict rather than silently choosing one.

Document anything a future collaborator, whether a person or an agent, would need to gain context later: the reasoning behind decisions, the constraints that ruled out alternatives, and the rules that emerged along the way. If it would be hard to reconstruct later, write it down now.`;
