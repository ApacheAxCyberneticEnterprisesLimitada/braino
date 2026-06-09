import {
  type CandidateFields,
  type EngineEdge,
  type LoadedPolicy,
  type Violation,
  evaluateEdgePolicies,
  evaluatePolicies,
} from "@doco/shared";
import { describe, expect, it } from "vitest";
import { findDocoTemplateByName, templatePolicyToPolicyRow } from "../doco-templates.js";

interface Scenario {
  q: string; // the decision question
  chosen: string | null;
  edges: { to: string; type: string }[]; // outgoing edges from the decision
  lifecycle?: "drafting" | "queued" | "active";
  wellFormed: boolean; // expect zero blocking deterministic violations
}

function loaded(handle: string): LoadedPolicy[] {
  const t = findDocoTemplateByName(handle);
  if (!t) throw new Error(`template ${handle} missing`);
  return t.policies.map((p, i) => {
    const row = templatePolicyToPolicyRow(p);
    return {
      policy_id: `policy_${i}`,
      kind: row.kind,
      predicate: row.predicate as unknown as LoadedPolicy["predicate"],
      ...(row.on_violation ? { on_violation: row.on_violation } : {}),
      ...(row.fires_when_node_lifecycle
        ? { fires_when_node_lifecycle: row.fires_when_node_lifecycle }
        : {}),
    } satisfies LoadedPolicy;
  });
}

function blockingOf(vs: Violation[]): Violation[] {
  return vs.filter((v) => (v.on_violation ?? "block") === "block");
}

function runScenario(handle: string, s: Scenario) {
  const policies = loaded(handle);
  const candidate: CandidateFields = {
    id: "decision_01ABC",
    node_type: "decision",
    lifecycle: s.lifecycle ?? "active",
    question: s.q,
    chosen: s.chosen,
    decision: `Context and rationale for: ${s.q}`,
  };
  const candidateEdges: EngineEdge[] = s.edges.map((e) => ({
    from_id: candidate.id,
    to_id: e.to,
    edge_type: e.type,
  }));
  const nodeViolations = evaluatePolicies({
    candidate,
    policies,
    candidateEdges,
    edges: candidateEdges,
    principals: new Set(),
    population: [],
  });
  // Edge-type allowlist, per edge.
  const edgeViolations = s.edges.flatMap((e) =>
    evaluateEdgePolicies({ edge: { edge_type: e.type }, policies }),
  );
  return { nodeViolations, edgeViolations };
}

// ── 10 realistic scenarios per template (all well-formed) ────────────────────
const DECIDER = { to: "principal_01TEAM", type: "attributed_to" };
const SECOND_DECIDER = { to: "principal_02OWNER", type: "attributed_to" };
const DRIVER = { to: "rule_01DRV", type: "constrained_by" };
const EVIDENCE = { to: "eval_01EV", type: "supports" };

const SCENARIOS: Record<string, Scenario[]> = {
  "architectural-decisions": [
    "Which datastore backs the event log?",
    "Adopt event sourcing for the orders service?",
    "Service comms: synchronous REST or asynchronous events?",
    "Multi-tenancy isolation: shared schema vs schema-per-tenant?",
    "Service-to-service auth: mTLS + short-lived JWTs?",
    "Caching layer for the product catalog?",
    "Deployment topology: modular monolith vs microservices for v1?",
    "API versioning strategy?",
    "Idempotency strategy for payment webhooks?",
    "Search backend: Postgres FTS or Elasticsearch?",
  ].map((q) => ({ q, chosen: "the chosen option", edges: [DECIDER, DRIVER], wellFormed: true })),

  "product-decisions": [
    "Gate new signups behind invite codes during beta?",
    "Sunset the legacy free tier?",
    "Build native mobile apps or ship a PWA first?",
    "Add usage-based pricing alongside per-seat?",
    "Onboarding: guided checklist or seeded sample data?",
    "Prioritize SAML SSO for enterprise this quarter?",
    "Offer a 14-day trial or a freemium tier?",
    "Localize the product for LATAM Spanish next?",
    "Deprecate the public API v1 with a 6-month sunset?",
    "Bundle analytics into Pro or sell as an add-on?",
  ].map((q) => ({ q, chosen: "the chosen option", edges: [DECIDER, EVIDENCE], wellFormed: true })),

  "design-decisions": [
    "Mobile filters: bottom sheet or full-screen modal?",
    "Adopt WCAG 2.2 AA as the accessibility baseline?",
    "Primary navigation: collapsible left rail or top tabs?",
    "Dashboard empty state: illustration + CTA or blank?",
    "Form validation: inline, on-submit, or both?",
    "Dark mode: system default with manual override?",
    "Date picker: native on mobile, custom on desktop?",
    "Destructive actions: confirm modal or undo toast?",
    "Icon set: outline by default, filled for active?",
    "Onboarding voice: friendly and concise or formal?",
  ].map((q) => ({ q, chosen: "the chosen option", edges: [DECIDER, EVIDENCE], wellFormed: true })),

  "data-decisions": [
    "Partition the events table by month?",
    "Source of truth for user identity across services?",
    "PII retention: anonymize inactive accounts after 24 months?",
    "Warehouse ingestion: batch ETL or CDC via Debezium?",
    "Grain of the orders fact table?",
    "Warehouse layering: raw / staging / marts?",
    "Customer records: soft delete with a purge job?",
    "Primary key strategy: UUIDv7 or bigint identity?",
    "Events topic data contract: who owns the schema?",
    "Money storage: integer minor units or decimal?",
  ].map((q) => ({
    q,
    chosen: "the chosen option",
    edges: [DECIDER, DRIVER, EVIDENCE],
    wellFormed: true,
  })),
};

describe("decision-record templates — 40 realistic scenarios produce no false blocks", () => {
  for (const [handle, scenarios] of Object.entries(SCENARIOS)) {
    describe(handle, () => {
      scenarios.forEach((s, i) => {
        it(`#${i + 1} "${s.q}" passes all blocking gates`, () => {
          const { nodeViolations, edgeViolations } = runScenario(handle, s);
          const blocking = [...blockingOf(nodeViolations), ...blockingOf(edgeViolations)];
          if (blocking.length > 0) {
            // Surface exactly what blocked, to diagnose template friction.
            throw new Error(
              `unexpected block: ${blocking.map((b) => `${b.sub_kind ?? b.kind}: ${b.reason}`).join(" | ")}`,
            );
          }
          expect(blocking).toEqual([]);
        });
      });
    });
  }
});

// ── Negative controls: the blocking gates DO fire on genuine problems ────────
describe("decision-record gates catch genuinely malformed records", () => {
  const H = "architectural-decisions";

  it("active decision with no `chosen` is blocked", () => {
    const { nodeViolations } = runScenario(H, {
      q: "Which queue?",
      chosen: null,
      edges: [DECIDER],
      wellFormed: false,
    });
    expect(blockingOf(nodeViolations).some((v) => v.sub_kind === "requires_field")).toBe(true);
  });

  it("active decision with no decider Principal is blocked", () => {
    const { nodeViolations } = runScenario(H, {
      q: "Which queue?",
      chosen: "RabbitMQ",
      edges: [],
      wellFormed: false,
    });
    expect(blockingOf(nodeViolations).some((v) => v.sub_kind === "requires_edge")).toBe(true);
  });

  it("active decision attributed to two principals is blocked (attribution ceiling)", () => {
    // A decision record names ONE accountable Principal — the decider/owner. Two
    // `attributed_to` edges is the ambiguous case the ceiling catches, mirroring
    // the process template's gateway-decider cap.
    const { nodeViolations } = runScenario(H, {
      q: "Which queue?",
      chosen: "RabbitMQ",
      edges: [DECIDER, SECOND_DECIDER],
      wellFormed: false,
    });
    expect(blockingOf(nodeViolations).some((v) => v.sub_kind === "limits_edge")).toBe(true);
  });

  it("a drafting decision may name two principals — the ceiling is committed-only", () => {
    const { nodeViolations } = runScenario(H, {
      q: "Which queue?",
      chosen: null,
      edges: [DECIDER, SECOND_DECIDER],
      lifecycle: "drafting",
      wellFormed: true,
    });
    expect(blockingOf(nodeViolations).some((v) => v.sub_kind === "limits_edge")).toBe(false);
  });

  it("a `flows_to` edge is barred by the edge allowlist", () => {
    const policies = loaded(H);
    const v = evaluateEdgePolicies({ edge: { edge_type: "flows_to" }, policies });
    expect(blockingOf(v).some((x) => x.sub_kind === "requires_edge_type")).toBe(true);
  });

  it("an Action node is barred by the node allowlist", () => {
    const policies = loaded(H);
    const v = evaluatePolicies({
      candidate: { id: "action_01", node_type: "action", lifecycle: "active" },
      policies,
      candidateEdges: [],
      edges: [],
      principals: new Set(),
      population: [],
    });
    expect(blockingOf(v).some((x) => x.sub_kind === "requires_node_type")).toBe(true);
  });

  it("a drafting decision may be incomplete — no blocking gate fires", () => {
    const { nodeViolations } = runScenario(H, {
      q: "Which queue?",
      chosen: null,
      edges: [],
      lifecycle: "drafting",
      wellFormed: true,
    });
    expect(blockingOf(nodeViolations)).toEqual([]);
  });
});

// ── Probabilistic nudges: quality gates are committed-only, fit is all-stages ─
// A drafting sketch is a work in progress; nagging it about incomplete rationale
// or unlisted alternatives is premature noise. The quality nudges (question,
// rationale, considered options) should fire only once a record is committed
// (queued/active), mirroring the deterministic completeness gates and the
// process template's pattern. The domain-fit nudge, by contrast, fires on every
// stage so an author is steered to the right log early.
describe("probabilistic nudges fire at the right lifecycle stage", () => {
  const H = "data-decisions";

  function pendingSpecs(lifecycle: "drafting" | "queued" | "active"): string[] {
    const { nodeViolations } = runScenario(H, {
      q: "Which warehouse format?",
      chosen: lifecycle === "drafting" ? null : "Parquet",
      edges: lifecycle === "drafting" ? [] : [DECIDER],
      lifecycle,
      wellFormed: true,
    });
    return nodeViolations.filter((v) => v.kind === "probabilistic").map((v) => v.reason);
  }

  const QUESTION = /poses a genuine decision/i;
  const RATIONALE = /context that made the decision necessary/i;
  const OPTIONS = /real options that were weighed/i;
  const FIT = /PASS when it records/i;

  it("a drafting decision is NOT nagged about question/rationale/options quality", () => {
    const specs = pendingSpecs("drafting").join("\n");
    expect(QUESTION.test(specs)).toBe(false);
    expect(RATIONALE.test(specs)).toBe(false);
    expect(OPTIONS.test(specs)).toBe(false);
  });

  it("the domain-fit nudge still fires while drafting (steer to the right log early)", () => {
    expect(FIT.test(pendingSpecs("drafting").join("\n"))).toBe(true);
  });

  it("a committed decision IS held to the quality nudges", () => {
    const specs = pendingSpecs("active").join("\n");
    expect(QUESTION.test(specs)).toBe(true);
    expect(RATIONALE.test(specs)).toBe(true);
    expect(OPTIONS.test(specs)).toBe(true);
  });
});
