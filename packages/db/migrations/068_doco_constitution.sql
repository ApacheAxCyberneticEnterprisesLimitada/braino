-- 068_doco_constitution.sql
-- ============================================================
-- Docos get a `constitution` text column — a free-form governing charter
-- the project owner writes to tell agents (and humans) how work is done
-- in this project. Read by every agent at bootstrap, alongside `goal` and
-- the policy set, and editable from /<handle>/settings.
--
-- Column default is '' to mirror `goal`. Unlike `goal`, a constitution
-- ships with real default text so a Doco "has a constitution" out of the
-- box. New Docos are seeded with it by createDocoInOrg; existing rows are
-- backfilled here.
--
-- The dollar-quoted text below MUST stay byte-for-byte identical to
-- DEFAULT_DOCO_CONSTITUTION in packages/shared/src/constitution.ts — a
-- guard test (packages/db/src/__tests__/constitution-default.test.ts)
-- enforces it. Edit both together.
-- ============================================================

ALTER TABLE docos
  ADD COLUMN IF NOT EXISTS constitution text NOT NULL DEFAULT '';

-- Backfill pre-existing rows (added with the '' default above) to the
-- standing default. Only touches rows still on the empty default, so an
-- owner who has already authored a constitution is never clobbered.
UPDATE docos
   SET constitution = $constitution$This is a spec-driven development project. Capture the intent, decision, and specification behind a change before writing the code that implements it, and let the documented spec lead the work.

Follow the policies of every Doco in this organization. They are binding, not advisory: when two policies appear to conflict, surface the conflict rather than silently choosing one.

Document anything a future collaborator, whether a person or an agent, would need to gain context later: the reasoning behind decisions, the constraints that ruled out alternatives, and the rules that emerged along the way. If it would be hard to reconstruct later, write it down now.$constitution$
 WHERE constitution = '';
