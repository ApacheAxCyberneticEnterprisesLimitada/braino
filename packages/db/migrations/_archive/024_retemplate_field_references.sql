-- 024_retemplate_field_references.sql
-- ============================================================
-- After the type-named rename (migrations 022 + 023), the templates in
-- packages/host/src/doco-templates.ts were updated so their primitive
-- prose references the new field names (`intent`, `action`, `state`,
-- `decision`, `eval`, `reference`) instead of the legacy `summary` /
-- `body_md` / `name` / `description` / `title`.
--
-- This migration applies the same text rewrites to the primitives
-- already seeded into existing Docos in prod, so the prose users see
-- (and the LLM judge reads) matches the new shape.
--
-- Pattern (copied from 018): UPDATE matches by `template_handle` +
-- a unique substring of the OLD prose, sets the new top-level
-- `summary` column, the `data.summary` jsonb mirror, and where
-- applicable `data.predicate.spec` or `data.predicate.fields`. The
-- marker substring uniquely identifies the row in the old wording so
-- the migration is naturally idempotent — re-running finds nothing
-- because the new wording no longer contains the marker.
-- ============================================================

-- ── state-machines ─────────────────────────────────────────────────

-- Guidance: "State `summary` is unique within a state-machine doco"

-- Guard: skip when the legacy `neuron_authoring_primitives` /
-- `guidance_primitives` tables no longer exist (post-028 rename).
DO $migration_guard$ BEGIN
IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name IN ('neuron_authoring_primitives', 'guidance_primitives')) THEN
UPDATE guidance_primitives
   SET data = jsonb_set(data, '{summary}', to_jsonb('State `state` is unique within a state-machine doco — duplicate State names ambiguate transitions and break referential semantics.'::text)),
       summary = 'State `state` is unique within a state-machine doco — duplicate State names ambiguate transitions and break referential semantics.',
       updated_at = now()
 WHERE data->>'template_handle' = 'state-machines'
   AND summary LIKE '%State `summary` is unique within a state-machine doco%';

-- P1: State summary-style → state-style. Both summary and spec change.
UPDATE neuron_authoring_primitives
   SET data = jsonb_set(
                jsonb_set(data,
                  '{summary}',
                  to_jsonb('State `state` reads as a noun or past-participle, not an imperative verb. Acceptable: `paid`, `cart`, `cancelled`. Not: `Pay`, `Cancel`, `Process the order`.'::text)
                ),
                '{predicate,spec}',
                to_jsonb('Check ONLY the State''s `state` field. It must read as a noun or past-participle naming the position the modeled entity occupies (`cart`, `paid`, `cancelled`, `awaiting-review`). It must NOT be an imperative verb naming an action (`Pay`, `Cancel`, `Process the order`). A single-word past-participle adjective is acceptable.'::text)
              ),
       summary = 'State `state` reads as a noun or past-participle, not an imperative verb. Acceptable: `paid`, `cart`, `cancelled`. Not: `Pay`, `Cancel`, `Process the order`.',
       updated_at = now()
 WHERE data->>'template_handle' = 'state-machines'
   AND summary LIKE '%State `summary` reads as a noun or past-participle%';

-- P3: only spec changes ("Do NOT judge the State's `summary` or `body_md`" → `state` field).
UPDATE neuron_authoring_primitives
   SET data = jsonb_set(data, '{predicate,spec}',
              to_jsonb('Check ONLY the State''s `invariants` array. If `invariants` is empty, missing, or absent from the entity, this rule PASSES (vacuously true). When invariants are present, each entry must read as an observable predicate a reader can check programmatically (e.g., `order.payment.captured = false`), not a subjective quality (e.g., `the order is happy`). Do NOT judge the State''s `state` field — only the invariants array matters here.'::text)),
       updated_at = now()
 WHERE data->>'template_handle' = 'state-machines'
   AND data->'predicate'->>'spec' LIKE '%Do NOT judge the State''s `summary` or `body_md`%';

-- P5: only spec changes ("Look at the Action's `verb` and `summary`" → `action`).
UPDATE neuron_authoring_primitives
   SET data = jsonb_set(data, '{predicate,spec}',
              to_jsonb('STEP 1 — decide whether this Action represents a compensating, cancellation, rollback, refund, undo, abort, abandon, or otherwise-undoing transition between States. Look at the Action''s `verb` and `action` for words like ''cancel'', ''refund'', ''rollback'', ''undo'', ''revert'', ''abort'', ''abandon'', ''compensate'', ''reverse''. If the Action is a normal happy-path transition (e.g., ''checkout submitted'', ''payment captured'', ''order shipped''), this rule PASSES — return ok. STEP 2 — only if the Action IS a compensating/cancellation transition, check that `decision_ids` is non-empty. If empty, FAIL with a reason explaining the Action looks like a compensating path but doesn''t cite a Decision.'::text)),
       updated_at = now()
 WHERE data->>'template_handle' = 'state-machines'
   AND data->'predicate'->>'spec' LIKE '%Look at the Action''s `verb` and `summary`%';

-- ── test ───────────────────────────────────────────────────────────

-- D2: name → eval in both the summary and the predicate.fields array.
UPDATE neuron_authoring_primitives
   SET data = jsonb_set(
                jsonb_set(data,
                  '{summary}',
                  to_jsonb('Every Eval declares what it is and how it''s graded — `eval` and `criterion` are required from creation.'::text)
                ),
                '{predicate,fields}',
                '["eval","criterion"]'::jsonb
              ),
       summary = 'Every Eval declares what it is and how it''s graded — `eval` and `criterion` are required from creation.',
       updated_at = now()
 WHERE data->>'template_handle' = 'test'
   AND data->'predicate'->>'kind' = 'requires_field'
   AND data->'predicate'->'fields' @> '["name"]'::jsonb;

-- P1: Eval name-style → eval-style.
UPDATE neuron_authoring_primitives
   SET data = jsonb_set(
                jsonb_set(data,
                  '{summary}',
                  to_jsonb('Eval `eval` reads as a checkable property of the system (e.g. `user-email-validation accepts .+@.+ form`), not a serial label (`test 1`, `eval A`, `it works`).'::text)
                ),
                '{predicate,spec}',
                to_jsonb('Check ONLY the Eval''s `eval` field. It must read as a checkable property of the system — a phrase describing what should be true (e.g. `user-email-validation accepts .+@.+ form`, `merge button disabled until reviewers approve`). It must NOT be a serial or meaningless label (`test 1`, `eval A`, `it works`, `tbd`).'::text)
              ),
       summary = 'Eval `eval` reads as a checkable property of the system (e.g. `user-email-validation accepts .+@.+ form`), not a serial label (`test 1`, `eval A`, `it works`).',
       updated_at = now()
 WHERE data->>'template_handle' = 'test'
   AND summary LIKE '%Eval `name` reads as a checkable property%';

-- P2: description → eval in both summary and spec.
UPDATE neuron_authoring_primitives
   SET data = jsonb_set(
                jsonb_set(data,
                  '{summary}',
                  to_jsonb('An Eval tests one property. If `eval` or `criterion.spec` joins multiple independent claims with ''and'', it''s a split candidate.'::text)
                ),
                '{predicate,spec}',
                to_jsonb('Check the Eval''s `eval` field and `criterion.spec`. The Eval should test ONE checkable property. If either field describes multiple independent properties joined by ''and'' (e.g. ''the form validates emails AND rejects empty submissions AND shows a toast''), it''s a split candidate — FAIL with a reason naming the split.'::text)
              ),
       summary = 'An Eval tests one property. If `eval` or `criterion.spec` joins multiple independent claims with ''and'', it''s a split candidate.',
       updated_at = now()
 WHERE data->>'template_handle' = 'test'
   AND summary LIKE '%An Eval tests one property. If `description` or `criterion.spec`%';

-- ── business-processes ─────────────────────────────────────────────

-- Intent purpose: summary "from the Intent's summary and body" + spec "Check the Intent's summary and body".
UPDATE neuron_authoring_primitives
   SET data = jsonb_set(
                jsonb_set(data,
                  '{summary}',
                  to_jsonb('The purpose Intent of a business process names the trigger that starts the process, the terminal business outcome that ends it, and what is explicitly out of scope. Readers should be able to discern all three from the Intent''s `intent` field.'::text)
                ),
                '{predicate,spec}',
                to_jsonb('Check the Intent''s `intent` field. The purpose Intent of a business process must name (1) the trigger that starts the process, (2) the terminal business outcome that ends it, and (3) what is explicitly out of scope. PASS if all three are discernible; FAIL with which is missing if one or more is absent.'::text)
              ),
       summary = 'The purpose Intent of a business process names the trigger that starts the process, the terminal business outcome that ends it, and what is explicitly out of scope. Readers should be able to discern all three from the Intent''s `intent` field.',
       updated_at = now()
 WHERE data->>'template_handle' = 'business-processes'
   AND summary LIKE '%discern all three from the Intent''s summary and body%';

-- Action atomic activity: Action `summary` → `action` in both summary and spec.
UPDATE neuron_authoring_primitives
   SET data = jsonb_set(
                jsonb_set(data,
                  '{summary}',
                  to_jsonb('Action `action` reads as an atomic business activity — a single unit of work an actor performs. Reject vague umbrella phases (`handle request`, `do the thing`) and reject implementation chores divorced from business meaning (`call API`, `update row`).'::text)
                ),
                '{predicate,spec}',
                to_jsonb('Check the Action''s `action` and `verb`. PASS when the text names an atomic business activity — a single unit of work the named actor performs. FAIL with reason if the text is a vague umbrella phase (e.g. `handle request`, `do the thing`, `process order`) or an implementation chore divorced from business meaning (e.g. `call API`, `update row`, `write to DB`).'::text)
              ),
       summary = 'Action `action` reads as an atomic business activity — a single unit of work an actor performs. Reject vague umbrella phases (`handle request`, `do the thing`) and reject implementation chores divorced from business meaning (`call API`, `update row`).',
       updated_at = now()
 WHERE data->>'template_handle' = 'business-processes'
   AND summary LIKE '%Action `summary` reads as an atomic business activity%';

-- Side-effecting Actions: only spec changes ("verb, summary, and outputs" → "verb, action, and outputs").
UPDATE neuron_authoring_primitives
   SET data = jsonb_set(data, '{predicate,spec}',
              to_jsonb('STEP 1 — decide whether this Action has a physical-world or financial side effect (money moved, goods shipped, a contract signed, an email sent to a counterparty). Look at the `verb`, `action`, and `outputs` for words like `ship`, `pay`, `charge`, `sign`, `send`, `dispatch`, `disburse`, `commit`. If the Action has no such side effect, this rule PASSES. STEP 2 — only if the Action IS side-effecting, check that EITHER `decision_ids` is non-empty (citing a Decision that branches to a compensating Action) OR `gated_by` is non-empty (citing a reversal Rule). FAIL with reason if both are empty.'::text)),
       updated_at = now()
 WHERE data->>'template_handle' = 'business-processes'
   AND data->'predicate'->>'spec' LIKE '%Look at the `verb`, `summary`, and `outputs`%';

-- Exception/cancellation Actions: spec only ("verb and summary" → "verb and action").
UPDATE neuron_authoring_primitives
   SET data = jsonb_set(data, '{predicate,spec}',
              to_jsonb('STEP 1 — decide whether this Action is a cancellation, refund, reject, escalate, abort, or otherwise-exceptional path. Look at the `verb` and `action` for words like `cancel`, `refund`, `reject`, `escalate`, `abort`, `void`, `dispute`, `deny`. If the Action is a normal happy-path activity, this rule PASSES. STEP 2 — only if the Action IS an exception/cancellation path, check that EITHER `decision_ids` OR `gated_by` is non-empty. FAIL with reason if both are empty.'::text)),
       updated_at = now()
 WHERE data->>'template_handle' = 'business-processes'
   AND data->'predicate'->>'spec' LIKE '%Look at the `verb` and `summary` for words like `cancel`%';

-- Sub-process invocation: spec only ("body_md cites a Reference" → "action field cites").
UPDATE neuron_authoring_primitives
   SET data = jsonb_set(data, '{predicate,spec}',
              to_jsonb('STEP 1 — decide whether this Action delegates to another business process (a sub-process invocation). Look for phrases like `run X process`, `kick off X`, `invoke the X workflow`, `escalate to the X process`. If the Action does not delegate, this rule PASSES. STEP 2 — only if it does delegate, check that EITHER `intent_ids` references the sub-process''s purpose Intent OR the `action` field cites a Reference pointing at the sub-process. FAIL with reason if the sub-process''s steps appear inlined in the body instead.'::text)),
       updated_at = now()
 WHERE data->>'template_handle' = 'business-processes'
   AND data->'predicate'->>'spec' LIKE '%OR the `body_md` cites a Reference pointing at the sub-process%';

-- Bounded loops: both summary and spec change.
UPDATE neuron_authoring_primitives
   SET data = jsonb_set(
                jsonb_set(data,
                  '{summary}',
                  to_jsonb('Actions whose verb or action implies retry or iteration must show how the loop terminates — either `decision_ids` cites a Decision with an exit branch, or `gated_by` cites a Rule that bounds iteration (max attempts, deadline, idempotency key).'::text)
                ),
                '{predicate,spec}',
                to_jsonb('STEP 1 — decide whether this Action''s `verb` or `action` implies a retry or loop (words like `retry`, `poll`, `keep checking`, `until`, `each time`, `recur`). If not, this rule PASSES. STEP 2 — only if the Action loops, check that EITHER `decision_ids` includes a Decision with an exit/give-up branch OR `gated_by` includes a Rule that bounds the iteration. Both shapes are legitimate. FAIL with reason if neither shape is present.'::text)
              ),
       summary = 'Actions whose verb or action implies retry or iteration must show how the loop terminates — either `decision_ids` cites a Decision with an exit branch, or `gated_by` cites a Rule that bounds iteration (max attempts, deadline, idempotency key).',
       updated_at = now()
 WHERE data->>'template_handle' = 'business-processes'
   AND summary LIKE '%Actions whose verb or summary implies retry or iteration%';

-- Timer-driven Actions: summary "in the summary or body" + spec "the summary or body_md names BOTH".
UPDATE neuron_authoring_primitives
   SET data = jsonb_set(
                jsonb_set(data,
                  '{summary}',
                  to_jsonb('Scheduled or timer-driven Actions must name both an anchor (a State''s `entered_at`, an absolute timestamp, or a prior Action''s completion) AND an ISO 8601 offset (`PT24H`, `P3D`, `PT15M`) in the `action` field. `nightly` and `every so often` are not anchors.'::text)
                ),
                '{predicate,spec}',
                to_jsonb('STEP 1 — decide whether this Action is scheduled or timer-driven (words like `after`, `every`, `nightly`, `daily`, `wait`, `on the Xth`, `following N days`). If not, this rule PASSES. STEP 2 — only if it is, check that the `action` names BOTH (a) a concrete anchor — a named State''s `entered_at`, an absolute timestamp, or a prior Action''s completion — and (b) an ISO 8601 duration offset (e.g. `PT24H`, `P3D`, `PT15M`). FAIL with reason if either is missing.'::text)
              ),
       summary = 'Scheduled or timer-driven Actions must name both an anchor (a State''s `entered_at`, an absolute timestamp, or a prior Action''s completion) AND an ISO 8601 offset (`PT24H`, `P3D`, `PT15M`) in the `action` field. `nightly` and `every so often` are not anchors.',
       updated_at = now()
 WHERE data->>'template_handle' = 'business-processes'
   AND summary LIKE '%PT24H`, `P3D`, `PT15M`) in the summary or body%';

-- Trust boundary: summary "crossing in the summary or body" + spec "the summary or body_md explicitly names".
UPDATE neuron_authoring_primitives
   SET data = jsonb_set(
                jsonb_set(data,
                  '{summary}',
                  to_jsonb('Actions whose counterparty is across an organizational, tenant, or external-system boundary must call out the crossing in the `action` field. Internal-only Actions are exempt.'::text)
                ),
                '{predicate,spec}',
                to_jsonb('STEP 1 — decide whether the Action crosses a trust boundary: the counterparty is in a different organization, a different tenant, an external vendor, a regulator, or any system outside the actor''s own administrative domain. If everything stays inside one boundary, this rule PASSES. STEP 2 — only if there is a crossing, check that the `action` explicitly names the boundary being crossed (e.g. `sent to the customer`, `posted to Stripe`, `submitted to HMRC`). FAIL with reason if the crossing is implicit.'::text)
              ),
       summary = 'Actions whose counterparty is across an organizational, tenant, or external-system boundary must call out the crossing in the `action` field. Internal-only Actions are exempt.',
       updated_at = now()
 WHERE data->>'template_handle' = 'business-processes'
   AND summary LIKE '%call out the crossing in the summary or body%';

-- Mutually exclusive Decision branches: spec only ("question / body_md" → "question or decision").
UPDATE neuron_authoring_primitives
   SET data = jsonb_set(data, '{predicate,spec}',
              to_jsonb('Check the Decision''s `alternatives`. PASS when the branches are visibly mutually exclusive OR the `question` or `decision` explicitly marks the gateway as inclusive (e.g. `select all that apply`, `inclusive gateway`). FAIL with reason if conditions on multiple branches could plausibly be true at once and inclusivity isn''t declared.'::text)),
       updated_at = now()
 WHERE data->>'template_handle' = 'business-processes'
   AND data->'predicate'->>'spec' LIKE '%the question / body_md explicitly marks the gateway%';

-- State guidance unique: "State `summary` is unique within a business process".
UPDATE guidance_primitives
   SET data = jsonb_set(data, '{summary}',
              to_jsonb('State `state` is unique within a business process — duplicate milestone names ambiguate references and hide wiring mistakes.'::text)),
       summary = 'State `state` is unique within a business process — duplicate milestone names ambiguate references and hide wiring mistakes.',
       updated_at = now()
 WHERE data->>'template_handle' = 'business-processes'
   AND summary LIKE '%State `summary` is unique within a business process%';

-- State milestone: summary "State `summary` reads as a milestone" + spec "Check ONLY the State's `summary`".
UPDATE neuron_authoring_primitives
   SET data = jsonb_set(
                jsonb_set(data,
                  '{summary}',
                  to_jsonb('State `state` reads as a milestone or entry/exit condition — a noun or past-participle (`invoice approved`, `payment captured`, `cart`), not an imperative verb naming an Action (`Approve invoice`).'::text)
                ),
                '{predicate,spec}',
                to_jsonb('Check ONLY the State''s `state`. PASS when the text reads as a milestone or entry/exit condition — a noun or past-participle (`invoice approved`, `payment captured`, `cart`, `awaiting-review`). FAIL with reason if it reads as an imperative verb naming an Action (`Approve invoice`, `Process the order`).'::text)
              ),
       summary = 'State `state` reads as a milestone or entry/exit condition — a noun or past-participle (`invoice approved`, `payment captured`, `cart`), not an imperative verb naming an Action (`Approve invoice`).',
       updated_at = now()
 WHERE data->>'template_handle' = 'business-processes'
   AND summary LIKE '%State `summary` reads as a milestone or entry/exit condition%';

-- Milestone vs steady: summary "from a State's `summary`, `kind`, and `invariants`" + spec "Read the State's `summary`, `kind`, and `invariants`".
UPDATE neuron_authoring_primitives
   SET data = jsonb_set(
                jsonb_set(data,
                  '{summary}',
                  to_jsonb('The reader can tell from a State''s `state`, `kind`, and `invariants` together whether it is a transient milestone (the process passes through it) or a steady condition (the process holds it for a span of time).'::text)
                ),
                '{predicate,spec}',
                to_jsonb('Read the State''s `state`, `kind`, and `invariants` together. PASS when a reader can tell whether the State is a transient milestone the process passes through, or a steady condition the process holds for some span of time. FAIL with reason if the three together are ambiguous.'::text)
              ),
       summary = 'The reader can tell from a State''s `state`, `kind`, and `invariants` together whether it is a transient milestone (the process passes through it) or a steady condition (the process holds it for a span of time).',
       updated_at = now()
 WHERE data->>'template_handle' = 'business-processes'
   AND summary LIKE '%from a State''s `summary`, `kind`, and `invariants` together%';

-- Convergence: summary "its `summary` or body names" + spec "the `summary` or `body_md` names the join predicate".
UPDATE neuron_authoring_primitives
   SET data = jsonb_set(
                jsonb_set(data,
                  '{summary}',
                  to_jsonb('When a State is the convergence of two or more parallel branches, its `state` names the join predicate (AND-join, OR-join, first-completes, threshold) so the reader knows what triggers entry.'::text)
                ),
                '{predicate,spec}',
                to_jsonb('STEP 1 — decide whether this State is a convergence of two or more parallel branches (incoming Actions from concurrent branches). If not, this rule PASSES. STEP 2 — only if it IS a convergence, check that the `state` names the join predicate (AND-join — wait for all; OR-join — first to arrive; threshold — N of M; etc.). FAIL with reason if the join semantics are not stated.'::text)
              ),
       summary = 'When a State is the convergence of two or more parallel branches, its `state` names the join predicate (AND-join, OR-join, first-completes, threshold) so the reader knows what triggers entry.',
       updated_at = now()
 WHERE data->>'template_handle' = 'business-processes'
   AND summary LIKE '%its `summary` or body names the join predicate%';

-- Eval pin: spec only ("Check the Eval's `summary`, `criterion`, and `expected`" → "`eval`, `criterion`, and `expected`").
UPDATE neuron_authoring_primitives
   SET data = jsonb_set(data, '{predicate,spec}',
              to_jsonb('Check the Eval''s `eval`, `criterion`, and `expected`. PASS when the Eval pins a process-critical claim: a completeness check (all required Actions exist), a handoff invariant (producer''s output matches consumer''s input), an SLA bound (process completes within X), a branch coverage (every Decision branch is exercised), or a policy compliance (a Rule''s predicate holds). FAIL with reason if the claim is vague (`it should work`, `looks good`).'::text)),
       updated_at = now()
 WHERE data->>'template_handle' = 'business-processes'
   AND data->'predicate'->>'spec' LIKE '%Check the Eval''s `summary`, `criterion`, and `expected`%';

-- Reference authoritative: spec only ("Reference's `ref_type`, `locator`, `summary`, and `body_md`" → "and `reference`").
UPDATE neuron_authoring_primitives
   SET data = jsonb_set(data, '{predicate,spec}',
              to_jsonb('Check the Reference''s `ref_type`, `locator`, and `reference`. PASS when the Reference points at an authoritative source: a policy document, a regulatory citation, a vendor specification, an API contract, or a sibling Doco that records process *instances* (Logs of runs). FAIL with reason if the Reference is decorative or unrelated (a marketing blog post, an unrelated tweet, a generic explainer).'::text)),
       updated_at = now()
 WHERE data->>'template_handle' = 'business-processes'
   AND data->'predicate'->>'spec' LIKE '%Check the Reference''s `ref_type`, `locator`, `summary`, and `body_md`%';

-- ── user-flows ─────────────────────────────────────────────────────

-- Action style: "summary style check" → "prose style check" (summary + spec are identical).
UPDATE neuron_authoring_primitives
   SET data = jsonb_set(
                jsonb_set(data,
                  '{summary}',
                  to_jsonb('Action nodes in user-flows pass the prose style check when their readable text begins with the responsible principal, such as "User", "Human", "Doco host", or "GitHub", as part of a journey-step sentence. Literal label headings such as "Designed step:" or "Flow step:" fail.'::text)
                ),
                '{predicate,spec}',
                to_jsonb('Action nodes in user-flows pass the prose style check when their readable text begins with the responsible principal, such as "User", "Human", "Doco host", or "GitHub", as part of a journey-step sentence. Literal label headings such as "Designed step:" or "Flow step:" fail.'::text)
              ),
       summary = 'Action nodes in user-flows pass the prose style check when their readable text begins with the responsible principal, such as "User", "Human", "Doco host", or "GitHub", as part of a journey-step sentence. Literal label headings such as "Designed step:" or "Flow step:" fail.',
       updated_at = now()
 WHERE data->>'template_handle' = 'user-flows'
   AND summary LIKE '%pass the summary style check%';

END IF;
END $migration_guard$;
