/**
 * Ten real-life decision-record scenarios, run through the *real* authoring
 * evaluator.
 *
 * These are not shape assertions on the template literal — they seed each
 * template's policies through the same `templatePolicyToSeededPolicy` bridge
 * the host uses at Doco-creation time, then drive `evaluatePolicies` (the
 * production engine) against realistic candidate Decisions across the four
 * decision-record domains and every lifecycle stage.
 *
 * What this proves about the post-`queued` architecture:
 *   - `drafting` is an unjudged scratchpad (sketch freely, `chosen` may be
 *     blank);
 *   - the completeness / uniqueness / quality / membership gates begin the
 *     moment a record is *proposed* (`queued`) and keep holding once it is
 *     *accepted* (`active`), so review happens before acceptance;
 *   - `retired` winds a record down without re-tripping shape gates;
 *   - the node-type allowlist is a structural invariant that fires at every
 *     stage.
 *
 * The two LLM-judged gates (domain membership + ADR-style quality) cannot run
 * a real model in CI, so the engine emits them as `pending` probabilistic
 * violations carrying the `agent_instruction` an LLM judge would resolve.
 * Each scenario asserts that the right judge *fires* (or stays silent) for the
 * candidate's type and stage; the verdict a real judge would return is noted
 * inline and exercised against production in the PR's verification report.
 */
import {
  type CandidateFields,
  type LoadedPolicy,
  type Violation,
  evaluatePolicies,
} from "@doco/shared";
import { describe, expect, it } from "vitest";
import { findDocoTemplateByName, templatePolicyToPolicyRow } from "../doco-templates.js";

type DecisionHandle =
  | "architectural-decisions"
  | "product-decisions"
  | "design-decisions"
  | "data-decisions";

const DECISION_HANDLES: DecisionHandle[] = [
  "architectural-decisions",
  "product-decisions",
  "design-decisions",
  "data-decisions",
];

/** Seed a template's policies into the evaluator's `LoadedPolicy` shape, using
 *  the exact translation the host runs at install time. */
function loadedFor(handle: DecisionHandle): LoadedPolicy[] {
  const template = findDocoTemplateByName(handle);
  if (!template) throw new Error(`${handle} not registered`);
  return template.policies.map((p, i) => {
    const row = templatePolicyToPolicyRow(p);
    return {
      policy_id: `policy_${handle}_${i}`,
      kind: row.kind,
      predicate: row.predicate,
      on_violation: row.on_violation,
      fires_when_node_lifecycle: row.fires_when_node_lifecycle,
    } as LoadedPolicy;
  });
}

function evaluate(
  handle: DecisionHandle,
  candidate: CandidateFields,
  population: CandidateFields[] = [],
): Violation[] {
  return evaluatePolicies({
    candidate,
    policies: loadedFor(handle),
    candidateEdges: [],
    edges: [],
    principals: new Set(),
    population,
  });
}

const blockers = (vs: Violation[]) => vs.filter((v) => v.on_violation === "block");
const deterministic = (vs: Violation[]) => vs.filter((v) => v.kind === "deterministic");
const probabilistic = (vs: Violation[]) => vs.filter((v) => v.kind === "probabilistic");
const judgeSpecs = (vs: Violation[]) => probabilistic(vs).map((v) => v.pending_spec ?? "");

describe("decision-record templates — real-life scenarios", () => {
  it("1. architectural · accepted ADR · complete → no blocks; both judges run", () => {
    const v = evaluate("architectural-decisions", {
      id: "decision_01ADRPOSTGRES000000000001",
      node_type: "decision",
      lifecycle: "active",
      decision:
        "Adopt PostgreSQL (managed RDS) as the billing service's primary OLTP store. " +
        "Context: billing needs multi-row ACID transactions, partial indexes, and JSONB. " +
        "Drivers: transactional integrity and operational maturity over raw write scale. " +
        "Consequences: vertical-scaling ceiling until we shard; revisit above 50k write tps.",
      question: "Which datastore backs the billing service?",
      chosen: "PostgreSQL on managed RDS",
      alternatives: [
        { name: "MySQL", rejected_because: "weaker JSONB + partial-index support at the time" },
        { name: "DynamoDB", rejected_because: "no multi-row ACID transactions" },
      ],
    });
    expect(blockers(v)).toEqual([]);
    // Type gate passes, spine complete, no duplicate → no deterministic firing.
    expect(deterministic(v)).toEqual([]);
    // Both LLM gates run on an in-force record and are advisory (warn).
    expect(probabilistic(v)).toHaveLength(2);
    expect(probabilistic(v).every((p) => p.on_violation === "warn")).toBe(true);
    expect(judgeSpecs(v).join("\n")).toMatch(/ADR|quality attributes/i);
  });

  it("2. architectural · drafting sketch · incomplete → completely unjudged", () => {
    const v = evaluate("architectural-decisions", {
      id: "decision_01ADRDRAFT0000000000000001",
      node_type: "decision",
      lifecycle: "drafting",
      decision: "Maybe move the event pipeline to event sourcing? Rough thought, not decided.",
      question: "Should the event pipeline adopt event sourcing?",
      chosen: null, // still thinking — allowed while drafting
      // no alternatives yet
    });
    // A draft is a scratchpad: no spine block, no membership/quality judging.
    // Only the structural type gate runs, and a Decision is allowed.
    expect(v).toEqual([]);
  });

  it("3. architectural · proposed for review (queued) · complete → judged at the proposal stage", () => {
    const v = evaluate("architectural-decisions", {
      id: "decision_01ADRGRPC00000000000000001",
      node_type: "decision",
      lifecycle: "queued",
      decision:
        "Propose gRPC for internal service-to-service APIs. Context: chatty JSON/REST calls " +
        "dominate p99 latency. Drivers: schema-first contracts, streaming, codegen. " +
        "Consequences: new infra for proxies and a browser-edge REST gateway; migration is incremental.",
      question: "What protocol do internal services use to talk to each other?",
      chosen: "gRPC with a REST edge gateway",
      alternatives: [
        { name: "Stay on REST/JSON", rejected_because: "no streaming, weaker contracts" },
        { name: "GraphQL federation", rejected_because: "overkill for east-west traffic" },
      ],
    });
    // Proposing it (queued) holds it to the full bar even before acceptance.
    expect(blockers(v)).toEqual([]);
    expect(deterministic(v)).toEqual([]);
    expect(probabilistic(v)).toHaveLength(2);
  });

  it("4. architectural · proposed (queued) but missing alternatives → spine blocks the proposal", () => {
    const v = evaluate("architectural-decisions", {
      id: "decision_01ADRNOALTS000000000000001",
      node_type: "decision",
      lifecycle: "queued",
      decision: "Propose moving CI from CircleCI to GitHub Actions.",
      question: "Which CI provider do we standardize on?",
      chosen: "GitHub Actions",
      // alternatives intentionally omitted — you can't *propose* a decision
      // record without stating the options you weighed.
    });
    const det = deterministic(v);
    expect(det).toHaveLength(1);
    expect(det[0]?.sub_kind).toBe("requires_field");
    expect(det[0]?.on_violation).toBe("block");
    expect(det[0]?.reason).toMatch(/alternatives/);
    // The judges still fire — incompleteness and quality are orthogonal.
    expect(probabilistic(v)).toHaveLength(2);
  });

  it("5. architectural · wrong node type (an Action) → structural type gate blocks at any stage", () => {
    const v = evaluate("architectural-decisions", {
      id: "action_01DEPLOYGATEWAY00000000001",
      node_type: "action",
      lifecycle: "active",
      action: "Deployed the new API gateway to production",
      verb: "deploy",
    });
    const det = deterministic(v);
    expect(det).toHaveLength(1);
    expect(det[0]?.sub_kind).toBe("requires_node_type");
    expect(det[0]?.on_violation).toBe("block");
    expect(det[0]?.reason).toMatch(/action/);
    // Decision-scoped judges do not fire on a non-Decision candidate.
    expect(probabilistic(v)).toEqual([]);
  });

  it("6. product · a deliberate 'we will not' (sunset free tier) · accepted → clean, judged", () => {
    const v = evaluate("product-decisions", {
      id: "decision_01PRODSUNSET00000000000001",
      node_type: "decision",
      lifecycle: "active",
      decision:
        "We will sunset the free tier for new signups. Problem: free accounts drive 80% of " +
        "support load at ~0% conversion in the SMB segment. Evidence: 6-month cohort + support " +
        "ticket analysis. Trade-off: slower top-of-funnel for higher-quality pipeline. " +
        "Success metric: paid-trial starts flat or up within two quarters; revisit if down >15%.",
      question: "Do we keep a free tier for new signups?",
      chosen: "No — replace it with a 14-day trial",
      alternatives: [
        {
          name: "Keep the free tier",
          rejected_because: "unsustainable support cost, ~0% conversion",
        },
        {
          name: "Usage-capped free tier",
          rejected_because: "still negative-margin in the SMB segment",
        },
      ],
    });
    expect(blockers(v)).toEqual([]);
    expect(deterministic(v)).toEqual([]);
    expect(probabilistic(v)).toHaveLength(2);
    expect(judgeSpecs(v).join("\n")).toMatch(/user\/customer|success\/failure metric/i);
  });

  it("7. product · proposed successor duplicates an in-force question → warns, never blocks", () => {
    const population: CandidateFields[] = [
      {
        id: "decision_01PRICEV1000000000000001",
        node_type: "decision",
        lifecycle: "active",
        question: "What is our pricing model?",
        chosen: "Per-seat subscription",
      },
    ];
    const v = evaluate(
      "product-decisions",
      {
        id: "decision_01PRICEV2000000000000001",
        node_type: "decision",
        lifecycle: "queued",
        decision:
          "Propose replacing per-seat pricing with usage-based metering plus a seat floor. " +
          "Evidence: win/loss notes show seat pricing penalizes low-usage teams. " +
          "This supersedes the original pricing decision rather than rewriting it.",
        question: "what is OUR pricing model?", // same question, different case
        chosen: "Usage-based metering with a seat floor",
        alternatives: [
          {
            name: "Keep per-seat",
            rejected_because: "penalizes low-usage teams; blocks expansion",
          },
        ],
      },
      population,
    );
    const dup = deterministic(v).find((x) => x.sub_kind === "unique_field");
    expect(dup).toBeDefined();
    expect(dup?.on_violation).toBe("warn"); // a successor is nudged to supersede, not blocked
    expect(dup?.reason).toMatch(/decision_01PRICEV1000000000000001/);
    expect(blockers(v)).toEqual([]);
    // Spine is satisfied; both judges still run on the proposal.
    expect(probabilistic(v)).toHaveLength(2);
  });

  it("8. design · accepted decision + a Figma Reference support node → decision judged, support node free", () => {
    const decisionViolations = evaluate("design-decisions", {
      id: "decision_01DSGNBOTTOMSHEET00000001",
      node_type: "decision",
      lifecycle: "active",
      decision:
        "Use a bottom sheet (not a full-screen modal) for mobile filters. Journey: catalog → " +
        "refine filters → results. Evidence: usability sessions showed modal dismissals lost the " +
        "result context. States: empty, applied, loading, and error covered. Accessibility: focus " +
        "trap + screen-reader announce on open. Validation: re-run the filter task in next round.",
      question: "How do mobile users adjust catalog filters?",
      chosen: "Bottom sheet anchored to the results",
      alternatives: [
        { name: "Full-screen modal", rejected_because: "lost result context on dismiss" },
        { name: "Inline accordion", rejected_because: "pushed results below the fold" },
      ],
    });
    expect(blockers(decisionViolations)).toEqual([]);
    expect(deterministic(decisionViolations)).toEqual([]);
    expect(probabilistic(decisionViolations)).toHaveLength(2);
    expect(judgeSpecs(decisionViolations).join("\n")).toMatch(/accessibility|user journey/i);

    // The supporting Figma Reference is an allowed type and is NOT subjected to
    // the Decision-scoped completeness/quality/membership gates.
    const referenceViolations = evaluate("design-decisions", {
      id: "reference_01FIGMACHECKOUT0000000001",
      node_type: "reference",
      lifecycle: "active",
      reference: "Mobile filters — Figma exploration board",
      ref_type: "url",
      locator: "https://figma.com/file/checkout-filters",
    });
    expect(referenceViolations).toEqual([]);
  });

  it("9. design · an off-domain (backend infra) decision · accepted → structurally valid, membership judge flags it", () => {
    const v = evaluate("design-decisions", {
      id: "decision_01DSGNOFFDOMAIN0000000001",
      node_type: "decision",
      lifecycle: "active",
      decision:
        "Run the orders message broker on Kafka rather than RabbitMQ. Partitioning + replay beat " +
        "RabbitMQ's routing for our throughput. (This is really an infrastructure choice.)",
      question: "Which message broker backs the orders pipeline?",
      chosen: "Kafka",
      alternatives: [
        { name: "RabbitMQ", rejected_because: "weaker replay and partitioning at our volume" },
      ],
    });
    // It's a well-formed Decision, so nothing structural blocks it…
    expect(blockers(v)).toEqual([]);
    expect(deterministic(v)).toEqual([]);
    // …but the design membership judge fires and gets the chance to warn that a
    // broker choice belongs in architectural-decisions. (Real judge verdict:
    // FAIL membership — verified against production in the PR report.)
    const membershipFires = judgeSpecs(v).some((s) => /design Decision/i.test(s));
    expect(membershipFires).toBe(true);
    expect(probabilistic(v)).toHaveLength(2);
  });

  it("10. data · source-of-truth decision + a freshness Eval support node → decision judged, Eval free", () => {
    const decisionViolations = evaluate("data-decisions", {
      id: "decision_01DATALTV00000000000000001",
      node_type: "decision",
      lifecycle: "active",
      decision:
        "The warehouse mart `marts.customer_ltv` is the single source of truth for customer LTV. " +
        "Owner: Data Platform. Producers: billing + usage pipelines; consumers: finance dashboards " +
        "and the pricing model. Semantics: trailing-24-month gross margin per account, USD, " +
        "excluding trials. Freshness: refreshed within 24h. Lineage and a backfill plan attached.",
      question: "What is the canonical source of truth for customer LTV?",
      chosen: "marts.customer_ltv (Data Platform owns it)",
      alternatives: [
        {
          name: "Per-team SQL snippets",
          rejected_because: "definitions drifted across dashboards",
        },
        { name: "Billing system live query", rejected_because: "no trial exclusion; load risk" },
      ],
    });
    expect(blockers(decisionViolations)).toEqual([]);
    expect(deterministic(decisionViolations)).toEqual([]);
    expect(probabilistic(decisionViolations)).toHaveLength(2);
    expect(judgeSpecs(decisionViolations).join("\n")).toMatch(/source of truth|privacy|lineage/i);

    // A freshness Eval supporting the metric is an allowed type and is not
    // subjected to the Decision-scoped gates.
    const evalViolations = evaluate("data-decisions", {
      id: "eval_01LTVFRESHNESS0000000000001",
      node_type: "eval",
      lifecycle: "active",
      eval: "LTV freshness: marts.customer_ltv updated within 24h",
      how_to_run: "SELECT now() - max(updated_at) FROM marts.customer_ltv;",
      criterion: { kind: "exact" },
    });
    expect(evalViolations).toEqual([]);
  });
});

describe("decision-record templates — lifecycle gating matrix", () => {
  const completeAt = (lifecycle: CandidateFields["lifecycle"]): CandidateFields => ({
    id: "decision_01MATRIX0000000000000001",
    node_type: "decision",
    lifecycle,
    decision:
      "Context, drivers, the chosen path, consequences, and a revisit trigger — a complete record.",
    question: "Which option do we take for the matrix case?",
    chosen: "Option A",
    alternatives: [{ name: "Option B", rejected_because: "higher long-run cost" }],
  });

  for (const handle of DECISION_HANDLES) {
    it(`${handle}: drafting is unjudged, queued+active are held to the bar, retired winds down`, () => {
      // drafting: scratchpad — no gates fire (type gate allows a Decision).
      expect(evaluate(handle, completeAt("drafting"))).toEqual([]);

      // queued (proposed) and active (accepted): full bar, both judges run,
      // nothing blocks a complete record.
      for (const stage of ["queued", "active"] as const) {
        const v = evaluate(handle, completeAt(stage));
        expect(blockers(v)).toEqual([]);
        expect(deterministic(v)).toEqual([]);
        expect(probabilistic(v)).toHaveLength(2);
      }

      // retired: winding down — completeness/quality/membership all skip; only
      // the structural type gate runs, and a Decision is allowed.
      expect(evaluate(handle, completeAt("retired"))).toEqual([]);
    });
  }

  it("the same incomplete record is silent while drafting but blocks the moment it is proposed", () => {
    const incompleteAt = (lifecycle: CandidateFields["lifecycle"]): CandidateFields => ({
      id: "decision_01TRANSITION00000000000001",
      node_type: "decision",
      lifecycle,
      decision: "Switch CI from CircleCI to GitHub Actions — rough notes, options not yet weighed.",
      question: "Which CI provider?",
      // chosen + alternatives intentionally absent
    });

    expect(evaluate("architectural-decisions", incompleteAt("drafting"))).toEqual([]);

    const proposed = deterministic(evaluate("architectural-decisions", incompleteAt("queued")));
    expect(proposed).toHaveLength(1);
    expect(proposed[0]?.sub_kind).toBe("requires_field");
    expect(proposed[0]?.reason).toMatch(/chosen/);
    expect(proposed[0]?.reason).toMatch(/alternatives/);
  });
});
