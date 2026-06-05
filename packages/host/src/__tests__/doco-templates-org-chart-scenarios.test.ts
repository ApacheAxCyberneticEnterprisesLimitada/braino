// Ten real-life org-chart scenarios, run against the *real* seeded
// org-chart policies through the actual authoring evaluator.
//
// Why this exists: the unit test (doco-templates-org-chart.test.ts) pins the
// template's shape; this file pins its BEHAVIOR. We translate the org-chart
// `TemplatePolicy[]` into the exact policy rows host.ts seeds at Doco-creation
// time (via the shared `templatePolicyToPolicyRow`), then push ten varied,
// realistic org charts — plus a set of malformed nodes — through
// `evaluatePolicies`. The template "passes" when it accepts every node of a
// legitimate chart and flags the malformed ones.
//
// Probabilistic policies can't be resolved here (the LLM judge needs
// ANTHROPIC_API_KEY, absent in the sandbox — see AGENTS.md). The engine emits
// them as *pending* violations carrying the agent instruction; we resolve each
// with a stand-in judge derived directly from the policy's own spec text
// (PASS/FAIL examples). The scenarios are written the way the template's
// guidance asks an author to write them: a FILLED seat sets the structured
// `kind` field ("human" | "agent"); a VACANT seat sets no `kind` and states its
// vacancy in prose; plus a root explanation or a reporting edge. So a faithful
// judge — stand-in or live — reaches the same verdict.

import {
  type CandidateFields,
  type EngineEdge,
  type Lifecycle,
  type LoadedPolicy,
  type Violation,
  evaluatePolicies,
} from "@doco/shared";
import { describe, expect, it } from "vitest";
import { findDocoTemplateByName, templatePolicyToPolicyRow } from "../doco-templates.js";

const template = findDocoTemplateByName("org-chart");
if (!template) throw new Error("org-chart template not registered");

// The org-chart Doco's enforced policy set — built exactly as host.ts seeds it.
const POLICIES: LoadedPolicy[] = template.policies.map((p, i) => {
  const row = templatePolicyToPolicyRow(p);
  return {
    policy_id: `policy_${i}`,
    kind: row.kind,
    predicate: row.predicate,
    on_violation: row.on_violation,
    fires_when_node_lifecycle: row.fires_when_node_lifecycle,
  } as LoadedPolicy;
});

// ── Node + edge builders ─────────────────────────────────────────────────
// A FILLED seat declares its occupant kind in the structured `kind` field
// ("human" | "agent"); a VACANT seat sets no `kind` and states its vacancy in
// its `prose` (a principal's one text home — there is no separate body).
// `kind` defaults to "human" so the common filled-person case reads cleanly;
// pass `null` for a vacant (or otherwise kind-less) seat.
function principal(
  slug: string,
  prose: string,
  lifecycle: Lifecycle = "active",
  kind: "human" | "agent" | null = "human",
): CandidateFields {
  return {
    id: `principal_${slug}`,
    node_type: "principal",
    name: slug,
    prose,
    ...(kind ? { kind } : {}),
    lifecycle,
  };
}
function intent(
  slug: string,
  intentText: string,
  lifecycle: Lifecycle = "active",
): CandidateFields {
  return { id: `intent_${slug}`, node_type: "intent", intent: intentText, lifecycle };
}
function decision(
  slug: string,
  fields: { decision: string; question: string; chosen?: string | null },
  lifecycle: Lifecycle = "active",
): CandidateFields {
  return { id: `decision_${slug}`, node_type: "decision", lifecycle, ...fields };
}
// With `role` gone, a reporting line is just a `has_parent` edge between two
// principals — its meaning comes from the edge type plus the principal→principal
// endpoints, not from a role tag. Dotted-line/matrix reporting and one-person-
// multiple-seats (`same_occupant_as`) are no longer modeled.
function reportsTo(fromSlug: string, toSlug: string): EngineEdge {
  return {
    from_id: `principal_${fromSlug}`,
    to_id: `principal_${toSlug}`,
    edge_type: "has_parent",
  };
}
// A team Intent's `attributed_to` edge to a Principal IS a membership link
// (the source node type — intent — carries that meaning, no role needed).
function memberOf(intentSlug: string, principalSlug: string): EngineEdge {
  return {
    from_id: `intent_${intentSlug}`,
    to_id: `principal_${principalSlug}`,
    edge_type: "attributed_to",
  };
}

// ── Stand-in judges (mirror the probabilistic specs' PASS conditions) ─────
// person / AI-agent / vacant declaration, read from PROSE. The slim-down moved
// the human/agent declaration to the structured `kind` field, so the live judge
// reads `kind` first; this prose reader is the FALLBACK that still recognises a
// vacant seat (which carries no `kind`). Vacant is checked first: a seat
// budgeted for a future hire reads as vacant even when it names the kind of
// occupant who'll fill it.
function declaresOccupant(body: string | undefined): "person" | "agent" | "vacant" | null {
  const t = (body ?? "").toLowerCase();
  if (
    /\bvacant\b|\bopen (?:seat|role|req|requisition|position|headcount)\b|\bunfilled\b|\bto be (?:hired|filled)\b/.test(
      t,
    )
  ) {
    return "vacant";
  }
  if (
    /\bai[\s-]?agent\b|\bautonomous\b|\b(?:triage|research|review|coding|qa|support)[\s-]?(?:bot|agent)\b|\bbot\b|\boperates under:/.test(
      t,
    )
  ) {
    return "agent";
  }
  if (/\bperson\b|\bhuman\b|\bemployee\b|\bcontractor\b|\bindividual\b/.test(t)) {
    return "person";
  }
  return null;
}

// Mirror the live declaration spec: a seat declares its occupant when `kind` is
// "human"/"agent" (the structured, filled-seat path) OR its prose declares the
// seat vacant (a vacant seat carries no `kind`). Returns false when neither
// holds — exactly the FAIL the judge keeps.
function seatDeclaresOccupant(node: CandidateFields): boolean {
  if (node.kind === "human" || node.kind === "agent") return true;
  return declaresOccupant(typeof node.prose === "string" ? node.prose : "") === "vacant";
}
// top-of-chain explanation (no manager above it is legitimate).
function explainsRoot(body: string | undefined): boolean {
  return /\bfounder\b|\bco-?founder\b|\bboard\b|\btop[\s-]?of[\s-]?chain\b|\broot agent\b|\bexternal authority\b|\bno manager\b/i.test(
    body ?? "",
  );
}

// Resolve a pending probabilistic violation the way a faithful judge would,
// dispatching on the spec text the engine attached.
function judgeKeeps(node: CandidateFields, candidateEdges: EngineEdge[], v: Violation): boolean {
  const spec = v.pending_spec ?? "";
  const body = typeof node.prose === "string" ? node.prose : "";
  if (/no manager above it/i.test(spec)) {
    // A reporting line is any `has_parent` edge from this principal (to its
    // manager principal) — no role tag to inspect now that roles are gone.
    const hasReportsTo = candidateEdges.some((e) => e.edge_type === "has_parent");
    return !(hasReportsTo || explainsRoot(body)); // KEEP (violation) when neither holds
  }
  if (/filled by a person|currently vacant|filled by an AI agent/i.test(spec)) {
    // KEEP (violation) when the seat declares nothing: no `kind`, and no prose
    // vacancy. A filled seat that set `kind` — or a vacant seat that said so —
    // passes.
    return !seatDeclaresOccupant(node);
  }
  return false; // unknown probabilistic → judge passes it (no others in org-chart)
}

interface Surviving {
  /** Hard, engine-decided failures (allowlist, missing field, …). */
  deterministic: Violation[];
  /** Pending probabilistic failures the stand-in judge would keep. */
  probabilistic: Violation[];
}
function assess(node: CandidateFields, candidateEdges: EngineEdge[] = []): Surviving {
  const vs = evaluatePolicies({
    candidate: node,
    policies: POLICIES,
    candidateEdges,
    edges: [],
    principals: new Set(),
    population: [],
  });
  return {
    deterministic: vs.filter((v) => v.kind === "deterministic"),
    probabilistic: vs.filter(
      (v) => v.kind === "probabilistic" && judgeKeeps(node, candidateEdges, v),
    ),
  };
}
/** Which probabilistic specs the engine *fired* (became pending) for this node. */
function firedProbabilistic(node: CandidateFields, candidateEdges: EngineEdge[] = []): string[] {
  return evaluatePolicies({
    candidate: node,
    policies: POLICIES,
    candidateEdges,
    edges: [],
    principals: new Set(),
    population: [],
  })
    .filter((v) => v.kind === "probabilistic")
    .map((v) => v.pending_spec ?? "");
}

const outgoing = (edges: EngineEdge[], id: string) => edges.filter((e) => e.from_id === id);

/** Every node of a legitimate chart survives the policy set with no findings. */
function expectChartClean(nodes: CandidateFields[], edges: EngineEdge[]) {
  for (const n of nodes) {
    const { deterministic, probabilistic } = assess(n, outgoing(edges, n.id));
    expect(deterministic, `${n.id} deterministic findings`).toEqual([]);
    expect(
      probabilistic.map((v) => v.reason),
      `${n.id} probabilistic findings`,
    ).toEqual([]);
  }
}

const TOP_OF_CHAIN = /no manager above it/i;

describe("org-chart template — 10 real-life scenarios", () => {
  it("1) seed-stage SaaS startup — a founder CEO over three functional heads", () => {
    const nodes = [
      principal(
        "ceo",
        "Founder & CEO — a person. Top-of-chain; reports to the board of directors.",
      ),
      principal("eng", "Head of Engineering — the person who leads product engineering."),
      principal("sales", "Head of Sales — a person who owns revenue."),
      principal("ops", "Head of Operations — a person running finance and people ops."),
      intent("eng_team", "Engineering — builds and operates the product."),
    ];
    const edges = [
      reportsTo("eng", "ceo"),
      reportsTo("sales", "ceo"),
      reportsTo("ops", "ceo"),
      memberOf("eng_team", "eng"),
    ];
    expectChartClean(nodes, edges);
  });

  it("2) startup with AI agents — a supervised reviewer and an autonomous triage bot", () => {
    const nodes = [
      principal("cto", "Co-founder & CTO — a person. Top-of-chain; reports to the board."),
      principal(
        "reviewer",
        "Automated code-review agent — an AI agent that operates under: @cto, reviewing every pull request.",
        "active",
        "agent",
      ),
      principal(
        "triage",
        "Autonomous incident-triage bot. No human owner — accountability stops at this agent.",
        "active",
        "agent",
      ),
    ];
    const edges = [reportsTo("reviewer", "cto"), reportsTo("triage", "cto")];
    expectChartClean(nodes, edges);
    // The reviewer + autonomous bot declare `kind: agent` (the org-tree icon
    // comes from the field); the prose still corroborates it.
    expect(nodes[1].kind).toBe("agent");
    expect(nodes[2].kind).toBe("agent");
    expect(declaresOccupant(nodes[1].prose as string)).toBe("agent");
    expect(declaresOccupant(nodes[2].prose as string)).toBe("agent");
  });

  it("3) a budgeted-but-vacant seat keeps headcount visible on the chart", () => {
    const nodes = [
      principal(
        "dir",
        "Director of Engineering — a person. Top-of-chain within this chart; reports to the CTO, who sits outside it.",
      ),
      principal(
        "staff",
        "Vacant — budgeted Staff Engineer seat, currently unfilled. Open req targeting a Q3 start; reports to the Director of Engineering.",
        "active",
        null, // a vacant seat carries NO `kind` — its vacancy lives in prose
      ),
    ];
    const edges = [reportsTo("staff", "dir")];
    expectChartClean(nodes, edges);
    expect(nodes[1].kind).toBeUndefined();
    expect(declaresOccupant(nodes[1].prose as string)).toBe("vacant");
  });

  it("4) a signed hire who hasn't started yet — staged as `queued`", () => {
    const nodes = [
      principal("ceo", "Founder & CEO — a person; top-of-chain."),
      principal(
        "vpmkt",
        "VP Marketing — a person. Signed offer; starts 2026-07-01 (pending start). Reports to the CEO.",
        "queued",
      ),
    ];
    const edges = [reportsTo("vpmkt", "ceo")];
    expectChartClean(nodes, edges);
    // The reporting-completeness nudge now FIRES on a queued seat (it's a
    // committed, ready org fact), and the wired reports_to edge satisfies it.
    expect(firedProbabilistic(nodes[1], outgoing(edges, nodes[1].id))).toEqual(
      expect.arrayContaining([expect.stringMatching(TOP_OF_CHAIN)]),
    );
  });

  it("5) an announced reorg that takes effect next quarter — queued seat, team, and Decision", () => {
    const nodes = [
      principal("ceo", "Founder & CEO — a person; top-of-chain."),
      principal("eng", "Head of Engineering — a person."),
      principal(
        "platform_lead",
        "Platform Lead — a person; reports to the CEO. New seat, effective 2026-Q4.",
        "queued",
      ),
      // Lifecycle (queued = not yet in force) and occupant-state (vacant = no
      // occupant) are orthogonal: a reorg routinely creates budgeted future
      // headcount that is both.
      principal(
        "platform_sre",
        "Vacant — budgeted Platform SRE seat for the new team; open req, to be hired once the team stands up. Reports to the Platform Lead.",
        "queued",
        null, // vacant + queued at once: no `kind`, vacancy stated in prose
      ),
      intent(
        "platform",
        "Platform — a new shared-infrastructure team standing up next quarter.",
        "queued",
      ),
      decision(
        "reorg",
        {
          decision: "Stand up a dedicated Platform team to own shared infrastructure.",
          question: "Should we create a Platform team, and when?",
          chosen: "Yes — effective Q4.",
        },
        "queued",
      ),
    ];
    const edges = [
      reportsTo("eng", "ceo"),
      reportsTo("platform_lead", "ceo"),
      reportsTo("platform_sre", "platform_lead"),
      // The queued team already names its roster (lead + a budgeted vacant SRE
      // seat) — a committed team is held to the membership gate.
      memberOf("platform", "platform_lead"),
      memberOf("platform", "platform_sre"),
    ];
    expectChartClean(nodes, edges);
    // A queued Decision and queued team Intent are accepted node types (the
    // team Intent passes the membership gate via its wired roster edges).
    expect(assess(nodes[4], outgoing(edges, nodes[4].id)).deterministic).toEqual([]);
    expect(assess(nodes[5], outgoing(edges, nodes[5].id)).deterministic).toEqual([]);
    // The queued seat is also vacant — both stages of the abstraction at once.
    expect(declaresOccupant(nodes[3].prose as string)).toBe("vacant");
    expect(nodes[3].lifecycle).toBe("queued");
  });

  it("6) a deep reporting chain — every seat reports to exactly one manager", () => {
    // Dotted-line/matrix reporting is no longer modeled (role is gone); each
    // seat has a single solid `has_parent` reporting line up the chain.
    const nodes = [
      principal(
        "vp",
        "VP Engineering — a person; top-of-chain in this chart, reports to the CEO above it.",
      ),
      principal("eng_mgr", "Engineering Manager — a person."),
      principal("prod_lead", "Product Lead — a person."),
      principal("engineer", "Senior Engineer — a person on the payments squad."),
    ];
    const edges = [
      reportsTo("eng_mgr", "vp"),
      reportsTo("prod_lead", "vp"),
      reportsTo("engineer", "eng_mgr"),
    ];
    expectChartClean(nodes, edges);
    // The single solid line satisfies the reporting nudge — there is no second
    // (dotted) manager edge to model.
    const engineerEdges = outgoing(edges, "principal_engineer");
    expect(engineerEdges.filter((e) => e.edge_type === "has_parent")).toHaveLength(1);
  });

  it("7) a dual-role founder — modeled as one seat (one person, multiple seats is not modeled)", () => {
    // `same_occupant_as` is gone: when one person covers two roles we model the
    // load-bearing seat and document the dual role in prose, rather than minting
    // a second Principal linked back to the first.
    const nodes = [
      principal(
        "ceo",
        "Founder & CEO — a person; top-of-chain, reports to the board. Also acting CTO during the search (one person covering both roles).",
      ),
      principal("eng_mgr", "Engineering Manager — a person; reports to the CEO."),
    ];
    const edges = [reportsTo("eng_mgr", "ceo")];
    expectChartClean(nodes, edges);
    // No `same_occupant_as` / `relates_to` occupancy edge is emitted — the dual
    // role lives in the seat's prose.
    expect(edges.some((e) => e.edge_type === "relates_to")).toBe(false);
  });

  it("8) a hospital department — a non-tech chain reporting up to a board", () => {
    const nodes = [
      principal("chief", "Chief of Medicine — a person; reports to the hospital board."),
      principal("cardio_dir", "Director of Cardiology — a person."),
      principal("attending", "Attending Physician, Cardiology — a person (employee)."),
      principal("nurse_mgr", "Nurse Manager, Cardiology — a person on staff."),
      intent("cardio", "Cardiology — diagnoses and treats cardiac patients."),
    ];
    const edges = [
      reportsTo("cardio_dir", "chief"),
      reportsTo("attending", "cardio_dir"),
      reportsTo("nurse_mgr", "cardio_dir"),
      memberOf("cardio", "cardio_dir"),
    ];
    expectChartClean(nodes, edges);
  });

  it("9) an agency — load-bearing recurring roles, including a fractional contractor", () => {
    const nodes = [
      principal("owner", "Agency Owner & Principal — a person; founder and top-of-chain."),
      principal(
        "frac_cfo",
        "Fractional CFO — a contractor (a person) in a recurring, load-bearing finance role.",
      ),
      principal("creative_dir", "Creative Director — a person."),
    ];
    const edges = [reportsTo("frac_cfo", "owner"), reportsTo("creative_dir", "owner")];
    expectChartClean(nodes, edges);
    // A load-bearing contractor is a legitimate person seat.
    expect(declaresOccupant(nodes[1].prose as string)).toBe("person");
  });

  it("10) a succession — retiring incumbent superseded by a queued successor", () => {
    const nodes = [
      principal("ceo", "Founder & CEO — a person; top-of-chain."),
      principal("vp_out", "VP Engineering (outgoing) — a person; retiring 2026-06-30.", "retired"),
      principal(
        "vp_in",
        "VP Engineering (incoming) — a person promoted from Director, effective 2026-07-01. Reports to the CEO.",
        "queued",
      ),
      decision("succession", {
        decision: "VP Engineering succession from the outgoing VP to the current Director.",
        question: "Who succeeds the outgoing VP Engineering?",
        chosen: "The current Director, effective July 1.",
      }),
    ];
    // The successor's reporting line is wired; the replaces edge ties new→old.
    const edges = [
      reportsTo("vp_in", "ceo"),
      {
        from_id: "principal_vp_in",
        to_id: "principal_vp_out",
        edge_type: "replaces",
        edge_props_json: null,
      } satisfies EngineEdge,
    ];
    expectChartClean(nodes, edges);
    // A RETIRED seat with no reporting edge is fine — the reporting nudge does
    // NOT fire on retired (only queued/active), so an exited incumbent never
    // nags for a manager it no longer has.
    expect(firedProbabilistic(nodes[1])).not.toEqual(
      expect.arrayContaining([expect.stringMatching(TOP_OF_CHAIN)]),
    );
  });
});

describe("org-chart template — lifecycle gating of the reporting nudge", () => {
  // The crux of the `queued` adaptation: a committed (queued) seat is held to
  // the same completeness bar as an in-force one, while a `drafting` sketch is
  // not. Same incomplete seat (declares a person, no manager, no root reason)
  // at three lifecycles:
  const incomplete = (lifecycle: Lifecycle) =>
    principal("loner", "Senior Engineer — a person.", lifecycle);

  it("queued: the reporting nudge fires and (with no edge / no root) is kept as a warning", () => {
    const node = incomplete("queued");
    expect(firedProbabilistic(node)).toEqual(
      expect.arrayContaining([expect.stringMatching(TOP_OF_CHAIN)]),
    );
    const kept = assess(node).probabilistic;
    expect(kept).toHaveLength(1);
    expect(kept[0].on_violation).toBe("warn");
  });

  it("active: same — the reporting nudge fires and is kept as a warning", () => {
    const kept = assess(incomplete("active")).probabilistic;
    expect(kept).toHaveLength(1);
    expect(kept[0].on_violation).toBe("warn");
  });

  it("drafting: the reporting nudge is exempt — a member can be captured before its manager exists", () => {
    const node = incomplete("drafting");
    expect(firedProbabilistic(node)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(TOP_OF_CHAIN)]),
    );
    // Only the (ungated) person/agent declaration applies; it's satisfied here.
    expect(assess(node).probabilistic).toEqual([]);
  });
});

describe("org-chart template — rejects what doesn't belong", () => {
  it("blocks activity/structure node types via the deterministic allowlist", () => {
    for (const node of [
      {
        id: "action_x",
        node_type: "action",
        action: "Deploy the service",
        verb: "deploy",
        lifecycle: "active",
      },
      {
        id: "state_x",
        node_type: "state",
        state: "approved",
        kind: "terminal",
        lifecycle: "active",
      },
      { id: "eval_x", node_type: "eval", eval: "Headcount reconciles", lifecycle: "active" },
    ] as CandidateFields[]) {
      const { deterministic } = assess(node);
      expect(deterministic, `${node.id} should be blocked`).toHaveLength(1);
      expect(deterministic[0].sub_kind).toBe("requires_node_type");
      expect(deterministic[0].on_violation).toBe("block");
    }
  });

  it("accepts the five org node types", () => {
    for (const node of [
      principal("p", "A person — engineer."),
      // Drafting: this case checks the node-type allowlist, not the membership
      // gate (which is committed-only and tested separately).
      intent("t", "A team.", "drafting"),
      decision("d", { decision: "A reorg.", question: "?", chosen: "x" }),
      {
        id: "reference_r",
        node_type: "reference",
        reference: "Headcount sheet",
        lifecycle: "active",
      },
      {
        id: "rule_u",
        node_type: "rule",
        rule: "Spans of control stay under 8.",
        lifecycle: "active",
      },
    ] as CandidateFields[]) {
      expect(assess(node).deterministic, `${node.id} should be allowed`).toEqual([]);
    }
  });

  it("a seat that sets no `kind` and declares neither person, AI agent, nor vacant in prose is flagged (block-grade)", () => {
    // Identity-grade for an org chart, so the declaration policy blocks. Wire a
    // manager so the reporting nudge is satisfied and the *declaration* failure
    // is the one isolated here. No `kind` (passed null) and no prose vacancy →
    // the seat declares nothing, so the judge blocks.
    const blank = principal(
      "mystery",
      "Senior Engineer on the platform team.",
      "active",
      null, // no structured kind set
    );
    const edges = [reportsTo("mystery", "boss")];
    expect(blank.kind).toBeUndefined();
    expect(seatDeclaresOccupant(blank)).toBe(false);
    const kept = assess(blank, edges).probabilistic;
    expect(kept).toHaveLength(1);
    expect(kept[0].on_violation).toBe("block");
    expect(kept[0].pending_spec).toMatch(/filled by a person/i);
  });

  it("an in-force, non-root seat with no reporting edge and no root reason warns (not blocks)", () => {
    const orphan = principal("orphan", "Staff Engineer — a person.", "active");
    // declares a person (so that policy passes); but no manager + no root reason.
    const kept = assess(orphan).probabilistic;
    expect(kept).toHaveLength(1);
    expect(kept[0].pending_spec).toMatch(TOP_OF_CHAIN);
    expect(kept[0].on_violation).toBe("warn");
  });
});

// ── The kind-keyed person/agent/vacant declaration ─────────────────────────
//
// The slim-down moved the human/agent declaration onto the structured `kind`
// field; a vacant seat still carries no `kind` and declares itself in prose.
// These cases pin that a filled seat passes via `kind` even when its prose
// never says "person"/"agent", and a vacant seat passes via prose with no
// `kind`.
describe("org-chart template — declaration keys off the structured `kind` field", () => {
  it("a filled seat passes via `kind: human` even when its prose is silent on person/agent", () => {
    // Prose names only the role; the occupant kind is the structured field.
    const seat = principal("eng", "Staff Engineer on the payments platform.", "active", "human");
    const edges = [reportsTo("eng", "boss")];
    // The prose alone declares nothing (no "person"/"agent"/"vacant")…
    expect(declaresOccupant(seat.prose as string)).toBeNull();
    // …but the structured `kind` carries the declaration, so the judge passes.
    expect(seatDeclaresOccupant(seat)).toBe(true);
    expect(assess(seat, edges).probabilistic).toEqual([]);
  });

  it("a filled seat passes via `kind: agent` even when its prose is silent on person/agent", () => {
    const seat = principal(
      "bot",
      "Pull-request reviewer for the platform repo.",
      "active",
      "agent",
    );
    const edges = [reportsTo("bot", "boss")];
    expect(declaresOccupant(seat.prose as string)).toBeNull();
    expect(seatDeclaresOccupant(seat)).toBe(true);
    expect(assess(seat, edges).probabilistic).toEqual([]);
  });

  it("a vacant seat passes with NO `kind` because its prose declares the vacancy", () => {
    const seat = principal(
      "open",
      "Vacant — budgeted Staff Engineer seat, open req. Reports to the Director.",
      "active",
      null,
    );
    const edges = [reportsTo("open", "boss")];
    expect(seat.kind).toBeUndefined();
    expect(seatDeclaresOccupant(seat)).toBe(true);
    expect(assess(seat, edges).probabilistic).toEqual([]);
  });

  it("a seat with no `kind` and no prose vacancy is blocked — the declaration is genuinely absent", () => {
    const seat = principal("mystery", "Staff Engineer on the platform team.", "active", null);
    const edges = [reportsTo("mystery", "boss")];
    expect(seatDeclaresOccupant(seat)).toBe(false);
    const kept = assess(seat, edges).probabilistic;
    expect(kept).toHaveLength(1);
    expect(kept[0].on_violation).toBe("block");
  });
});

// ── Structural gate: team membership ─────────────────────────────────────────
//
// Team membership was unenforced before — a `descriptive` predicate (recorded,
// never checked). It is now a deterministic `requires_edge`; these cases pin it.
// (The person/agent/vacant declaration is the probabilistic judge above — there
// is no deterministic field floor on a principal now that `body_md` is gone.)

describe("org-chart template — team membership gate (requires_edge)", () => {
  it("warns when a committed team Intent names no members", () => {
    const team = intent("ghost_team", "Ghost Team — roster never wired.", "active");
    const findings = assess(team, []).deterministic; // no outgoing member edges
    const warn = findings.find((v) => v.sub_kind === "requires_edge");
    expect(warn, "expected a requires_edge finding").toBeDefined();
    expect(warn?.reason).toMatch(/attributed_to/);
    expect(warn?.on_violation).toBe("warn");
  });

  it("is satisfied once the team has at least one member edge", () => {
    const team = intent("real_team", "Real Team — has a lead.", "active");
    const edges = [memberOf("real_team", "lead")];
    const findings = assess(team, outgoing(edges, team.id)).deterministic;
    expect(findings.some((v) => v.sub_kind === "requires_edge")).toBe(false);
  });

  it("exempts a drafting team — a roster can be wired up later", () => {
    const team = intent("sketch_team", "Sketch — still being drawn.", "drafting");
    expect(assess(team, []).deterministic).toEqual([]);
  });
});

describe("org-chart template — no deterministic field floor on a principal", () => {
  // `body_md` is gone, so the old empty-body floor (requires_field) was removed.
  // A vacant seat carries no `kind` and declares itself in prose, so any
  // requires_field gate would wrongly block it — there is none.
  it("never raises a requires_field finding on a principal (filled or vacant)", () => {
    const filled = principal("seated", "Director of Engineering — a person.");
    const vacant = principal(
      "open",
      "Vacant — budgeted seat, open req. Reports to the Director.",
      "active",
      null,
    );
    for (const seat of [filled, vacant]) {
      expect(assess(seat, []).deterministic.some((v) => v.sub_kind === "requires_field")).toBe(
        false,
      );
    }
  });
});
