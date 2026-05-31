-- 069_org_constitution.sql
-- ============================================================
-- The constitution moves from Docos to Organizations.
--
-- 1. Drop docos.constitution. Migration 068 added it (and any prod that
--    deployed #671 ran 068), but the per-Doco constitution was reverted:
--    the charter belongs to the org, not each Doco. Forward-only, so we
--    drop here rather than editing 068.
-- 2. Add organizations.constitution — a free-form governing charter shared
--    with every agent granted access to the org at bootstrap, and shown on
--    the org home page. Editable by org owners.
--
-- Column default is '' to mirror docos.goal. Unlike a Doco's goal, an org
-- ships with real default text so an org "has a constitution" out of the
-- box. New orgs are seeded with it by addOrganizationByHandle; existing
-- rows are backfilled below.
--
-- The dollar-quoted text MUST stay byte-for-byte identical to
-- DEFAULT_ORG_CONSTITUTION in packages/shared/src/constitution.ts — a guard
-- test (packages/db/src/__tests__/constitution-default.test.ts) enforces
-- it. Edit both together.
-- ============================================================

ALTER TABLE docos DROP COLUMN IF EXISTS constitution;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS constitution text NOT NULL DEFAULT '';

-- Backfill pre-existing orgs (added with the '' default above) to the
-- standing default. Only touches rows still on the empty default, so an
-- owner who has already authored a constitution is never clobbered.
UPDATE organizations
   SET constitution = $constitution$This is a spec-driven development project. Capture the intent, decision, and specification behind a change before writing the code that implements it, and let the documented spec lead the work.

Follow the policies of every Doco in this organization. They are binding, not advisory: when two policies appear to conflict, surface the conflict rather than silently choosing one.

Document anything a future collaborator, whether a person or an agent, would need to gain context later: the reasoning behind decisions, the constraints that ruled out alternatives, and the rules that emerged along the way. If it would be hard to reconstruct later, write it down now.$constitution$
 WHERE constitution = '';
