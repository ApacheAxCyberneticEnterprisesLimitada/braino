import { describe, expect, it } from "vitest";
import { DEFAULT_DOCO_TEMPLATES, findDocoTemplateByName } from "../doco-templates.js";

describe("template policies carry no vestigial rule `kind`", () => {
  // Rules are no longer guidances: every policy lives in the one unified
  // `policies` table, classified by a standalone `kind` only at seed time
  // in host.ts — a TemplatePolicy never carries a `kind` field itself
  // (decision_01KRRR5BQ16ASY8HQEE0V499YG). Keep the vestige out for good.
  it("no seeded template policy declares a `kind`", () => {
    for (const t of DEFAULT_DOCO_TEMPLATES) {
      for (const p of t.policies) {
        expect(p).not.toHaveProperty("kind");
      }
    }
  });
});

describe("orphaned pre-unification templates are gone", () => {
  // `global` and `important` were never in the new-Doco picker
  // (DOCO_TEMPLATES); the API and UI reject any handle outside that list,
  // so both were unreachable. `global` also still seeded the removed
  // `guidance_policy` / `node_authoring_policy` node types into the
  // write-only `allowed_node_types` column. Both removed with the policy
  // unify — keep them out.
  for (const name of ["global", "important"]) {
    it(`does not register the orphaned \`${name}\` template`, () => {
      expect(findDocoTemplateByName(name)).toBeUndefined();
      expect(DEFAULT_DOCO_TEMPLATES.some((t) => t.name === name)).toBe(false);
    });
  }
});

describe("business-processes template", () => {
  const template = findDocoTemplateByName("business-processes");
  if (!template) throw new Error("business-processes template not registered");

  it("is registered in DEFAULT_DOCO_TEMPLATES under its plain handle", () => {
    expect(DEFAULT_DOCO_TEMPLATES.find((t) => t.name === "business-processes")).toBeDefined();
  });

  it("is reachable via its bare handle and is NOT reachable via the legacy hashtag-prefixed form", () => {
    const bare = findDocoTemplateByName("business-processes");
    const hashtagged = findDocoTemplateByName("#business-processes");
    expect(bare).toBeDefined();
    expect(bare?.name).toBe("business-processes");
    expect(hashtagged).toBeUndefined();
  });

  it("has the expected metadata (icon, label, defaultNodeLifecycle)", () => {
    expect(template.icon).toBe("🏭");
    expect(template.label).toBe("business-processes");
    expect(template.defaultNodeLifecycle).toBe("drafting");
    expect(template.description).toMatch(/repeatable business processes/i);
    expect(template.description).toMatch(/BPMN/);
  });

  it("ships with the BPMN perspective attached as the default", () => {
    expect(template.perspectives).toEqual([{ slug: "bpmn", isDefault: true }]);
  });

  describe("node-type allowlist", () => {
    const allowlist = template.policies.find(
      (r) => r.predicate?.kind === "requires_node_type",
    )?.predicate;

    it("includes only process node types", () => {
      expect(allowlist?.kind).toBe("requires_node_type");
      if (allowlist?.kind !== "requires_node_type") return;
      expect([...allowlist.node_types].sort()).toEqual(
        ["action", "decision", "eval", "intent", "principal", "reference", "rule", "state"].sort(),
      );
    });

    it("does not list Doco policy metadata as business-process content", () => {
      if (allowlist?.kind !== "requires_node_type") throw new Error("allowlist missing");
      expect(allowlist.node_types).not.toContain("guidance_policy" as never);
      expect(allowlist.node_types).not.toContain("node_authoring_policy" as never);
    });

    it("describes only business-process nodes, not Doco policy metadata", () => {
      const policy = template.policies.find(
        (r) => r.predicate?.kind === "requires_node_type",
      )?.policy;
      expect(policy ?? "").toMatch(
        /Only Intent, Action, Decision, State, Eval, Reference, Rule, and Principal/i,
      );
      expect(policy ?? "").not.toMatch(/guidance_policy|node_authoring_policy|policy records/i);
    });

    it("excludes Log and Idea (Logs live in a sibling Doco; Ideas live in their own home)", () => {
      if (allowlist?.kind !== "requires_node_type") throw new Error("allowlist missing");
      expect(allowlist.node_types).not.toContain("log");
      expect(allowlist.node_types).not.toContain("idea");
    });
  });

  describe("requires_field rules", () => {
    function requiresField(field: string, entityType: string) {
      return template.policies.find(
        (r) =>
          r.predicate?.kind === "requires_field" &&
          r.predicate.fields.includes(field) &&
          r.predicate.when_node_type?.includes(entityType as never),
      );
    }

    it("does not require relationship keys in node JSON", () => {
      expect(requiresField("actor_id", "action")).toBeUndefined();
      expect(requiresField("target_ref", "eval")).toBeUndefined();
      expect(requiresField("actors", "intent")).toBeUndefined();
      expect(requiresField("stakeholders", "intent")).toBeUndefined();
      expect(requiresField("inputs", "action")).toBeUndefined();
      expect(requiresField("outputs", "action")).toBeUndefined();
    });
  });

  describe("requires_edge rules", () => {
    function requiresEdgeRole(edgeType: string, role: string, target: string | null, on: string) {
      return template.policies.find(
        (r) =>
          r.predicate?.kind === "requires_edge_role" &&
          r.predicate.edge_type === edgeType &&
          r.predicate.edge_role === role &&
          (target === null || r.predicate.target_node_type === target) &&
          r.predicate.when_node_type?.includes(on as never),
      );
    }

    it("Action serves Intent", () => {
      expect(requiresEdgeRole("supports", "serves", "intent", "action")).toBeDefined();
    });
    it("Decision serves Intent", () => {
      expect(requiresEdgeRole("supports", "serves", "intent", "decision")).toBeDefined();
    });
    it("State serves Intent", () => {
      expect(requiresEdgeRole("supports", "serves", "intent", "state")).toBeDefined();
    });
    it("Action performed_by Principal", () => {
      expect(
        requiresEdgeRole("attributed_to", "performed_by", "principal", "action"),
      ).toBeDefined();
    });
    it("Decision decided_by Principal", () => {
      // A gateway routes the flow, but a role, team, or system is
      // accountable for how it is decided. Require that decider explicitly,
      // mirroring the Action performed_by gate.
      expect(
        requiresEdgeRole("attributed_to", "decided_by", "principal", "decision"),
      ).toBeDefined();
    });
    it("Decision decided_by fires on both committed stages (queued + active)", () => {
      expect(
        requiresEdgeRole("attributed_to", "decided_by", "principal", "decision")
          ?.fires_when_node_lifecycle,
      ).toEqual(["queued", "active"]);
    });
    it("Eval tests a target", () => {
      const rule = requiresEdgeRole("supports", "tests", null, "eval");
      expect(rule).toBeDefined();
      expect(rule?.fires_when_node_lifecycle).toEqual(["queued", "active"]);
    });

    it("fires flow membership checks on both committed stages (queued + active), exempting drafting", () => {
      // A `queued` node asserts readiness, so it is held to the same
      // actor / serves / sequence-flow wiring as `active`. Only `drafting`
      // sketches are exempt from completeness.
      expect(
        requiresEdgeRole("supports", "serves", "intent", "action")?.fires_when_node_lifecycle,
      ).toEqual(["queued", "active"]);
      expect(
        requiresEdgeRole("supports", "serves", "intent", "decision")?.fires_when_node_lifecycle,
      ).toEqual(["queued", "active"]);
      expect(
        requiresEdgeRole("supports", "serves", "intent", "state")?.fires_when_node_lifecycle,
      ).toEqual(["queued", "active"]);
    });

    it("keeps the role vocabulary in the business-process guidance", () => {
      const policies = template.policies.map((r) => r.policy).join("\n");
      expect(policies).toMatch(/`serves`/);
      expect(policies).toMatch(/`performed_by`/);
      expect(policies).toMatch(/`tests`/);
      expect(policies).toMatch(/`gated_by`/);
    });
  });

  describe("Intent shape", () => {
    const intentRule = template.policies.find(
      (r) =>
        r.predicate?.kind === "probabilistic" &&
        r.predicate.when_node_type?.includes("intent") &&
        /purpose Intent/i.test(r.policy),
    );

    it("requires a brief BPMN headline on the Intent's first line", () => {
      expect(intentRule?.predicate?.kind).toBe("probabilistic");
      if (intentRule?.predicate?.kind !== "probabilistic") return;
      // First line is a short verb+object process name…
      expect(intentRule.predicate.spec).toMatch(/first line/i);
      expect(intentRule.predicate.spec).toMatch(/brief|short|concise/i);
      // …and that is ALL it grades. The Intent no longer has to restate the
      // trigger, terminal outcome, or out-of-scope boundary in its body —
      // those live on the initial/terminal States and the flow wiring, so the
      // policy must not demand them (that demand is what bloated the Intent).
      expect(intentRule.predicate.spec).not.toMatch(/trigger/i);
      expect(intentRule.predicate.spec).not.toMatch(/outcome/i);
      expect(intentRule.predicate.spec).not.toMatch(/out of scope|out-of-scope/i);
    });

    it("asks for the brief name in the human-readable policy too", () => {
      expect(intentRule?.policy).toMatch(/first line/i);
      expect(intentRule?.policy).toMatch(/brief|short|concise/i);
      // The prose policy must not ask for trigger / outcome / scope either.
      expect(intentRule?.policy).not.toMatch(/trigger/i);
      expect(intentRule?.policy).not.toMatch(/outcome/i);
      expect(intentRule?.policy).not.toMatch(/out of scope|out-of-scope/i);
    });
  });

  describe("Principal lane shape", () => {
    const principalRule = template.policies.find(
      (r) =>
        r.predicate?.kind === "probabilistic" &&
        r.predicate.when_node_type?.includes("principal") &&
        /swim-lane actors/i.test(r.policy),
    );

    it("warns when a Principal does not read as a process swim-lane actor", () => {
      expect(principalRule?.on_violation).toBe("warn");
      expect(principalRule?.predicate?.kind).toBe("probabilistic");
      if (principalRule?.predicate?.kind !== "probabilistic") return;
      expect(principalRule.predicate.spec).toMatch(/role, team, external party, or system/i);
      expect(principalRule.predicate.spec).toMatch(/responsibility|boundary/i);
    });
  });

  describe("State wiring", () => {
    // The per-node sequence-flow + uniqueness invariants are now ENGINE-checked
    // (deterministic), not prose-only. Doco-level existence ("≥1 initial, ≥1
    // terminal") can't be a per-candidate predicate, so it stays guidance.
    const guidanceSummaries = template.policies.filter((r) => !r.predicate).map((r) => r.policy);

    it("≥1 active initial State is documented (doco-level, stays guidance)", () => {
      expect(guidanceSummaries.some((s) => /\binitial\b/i.test(s) && /≥1|at least/i.test(s))).toBe(
        true,
      );
    });
    it("≥1 active terminal State is documented (doco-level, stays guidance)", () => {
      expect(guidanceSummaries.some((s) => /\bterminal\b/i.test(s) && /≥1|at least/i.test(s))).toBe(
        true,
      );
    });

    it("State milestone-name uniqueness is ENFORCED via unique_field", () => {
      const rule = template.policies.find(
        (r) =>
          r.predicate?.kind === "unique_field" && r.predicate.when_node_type?.includes("state"),
      );
      expect(rule?.predicate?.kind).toBe("unique_field");
      if (rule?.predicate?.kind !== "unique_field") return;
      expect(rule.predicate.field).toBe("state");
      expect(rule.fires_when_node_lifecycle).toEqual(["queued", "active"]);
    });

    it("sequence-flow completeness is ENFORCED via flow-wiring (the dangling-node fix)", () => {
      const rule = template.policies.find((r) => r.predicate?.kind === "flow-wiring");
      expect(rule?.predicate?.kind).toBe("flow-wiring");
      if (rule?.predicate?.kind !== "flow-wiring") return;
      expect(rule.predicate.edge_type).toBe("flows_to");
      expect(rule.predicate.when_node_type).toEqual(["action", "decision", "state"]);
      expect(rule.predicate.initial_when).toEqual({ field: "kind", equals: "initial" });
      expect(rule.predicate.terminal_when).toEqual({ field: "kind", equals: "terminal" });
      // Committed-only: a drafting sketch may dangle.
      expect(rule.fires_when_node_lifecycle).toEqual(["queued", "active"]);
      // The summary still spells out the terminal + forward-flow shape for agents.
      expect(rule.policy).toMatch(/terminal/i);
      expect(rule.policy).toMatch(/no outgoing.*flows_to/i);
      expect(rule.policy).toMatch(/forward/i);
    });
  });

  describe("actor coverage (enforced)", () => {
    it("ENFORCES that each actor Principal performs ≥1 Action, exempting the owner", () => {
      const rule = template.policies.find(
        (r) =>
          r.predicate?.kind === "requires_edge_role" &&
          r.predicate.edge_role === "performed_by" &&
          r.predicate.direction === "incoming",
      );
      expect(rule?.predicate?.kind).toBe("requires_edge_role");
      if (rule?.predicate?.kind !== "requires_edge_role") return;
      expect(rule.predicate.edge_type).toBe("attributed_to");
      expect(rule.predicate.exempt_when_role).toBe("owned_by");
      expect(rule.predicate.when_node_type).toEqual(["principal"]);
      // A nudge, not a hard block — the owner exemption keeps it from false-firing.
      expect(rule.on_violation).toBe("warn");
      expect(rule.fires_when_node_lifecycle).toEqual(["queued", "active"]);
    });

    it("ENFORCES that the process Intent names an accountable owner (owned_by)", () => {
      const rule = template.policies.find(
        (r) =>
          r.predicate?.kind === "requires_edge_role" &&
          r.predicate.edge_role === "owned_by" &&
          (r.predicate.when_node_type?.includes("intent") ?? false),
      );
      expect(rule?.predicate?.kind).toBe("requires_edge_role");
      if (rule?.predicate?.kind !== "requires_edge_role") return;
      expect(rule.predicate.edge_type).toBe("attributed_to");
      expect(rule.on_violation).toBe("warn");
      expect(rule.fires_when_node_lifecycle).toEqual(["queued", "active"]);
    });
  });

  describe("deterministic floors under the LLM judges", () => {
    it("a gateway Decision needs ≥2 outgoing flows_to (structural floor under the exhaustiveness judge)", () => {
      const rule = template.policies.find(
        (r) =>
          r.predicate?.kind === "requires_edge" &&
          r.predicate.edge_type === "flows_to" &&
          (r.predicate.when_node_type?.includes("decision") ?? false),
      );
      expect(rule?.predicate?.kind).toBe("requires_edge");
      if (rule?.predicate?.kind !== "requires_edge") return;
      expect(rule.predicate.min_count).toBe(2);
      expect(rule.fires_when_node_lifecycle).toEqual(["queued", "active"]);
    });

    it("a deterministic pattern floor blocks raw BPMN/import scaffolding tokens", () => {
      const rule = template.policies.find((r) => r.predicate?.kind === "forbids_field_pattern");
      expect(rule?.predicate?.kind).toBe("forbids_field_pattern");
      if (rule?.predicate?.kind !== "forbids_field_pattern") return;
      // Catches camelCase BPMN element types and generated ids.
      expect("exclusiveGateway").toMatch(new RegExp(rule.predicate.pattern, rule.predicate.flags));
      expect("Gateway_0x1f").toMatch(new RegExp(rule.predicate.pattern, rule.predicate.flags));
      // Leaves ordinary business prose alone.
      expect("approve the invoice").not.toMatch(
        new RegExp(rule.predicate.pattern, rule.predicate.flags),
      );
    });

    it("a headline-length floor warns on a run-on Intent first line", () => {
      const rule = template.policies.find((r) => r.predicate?.kind === "field-line-shape");
      expect(rule?.predicate?.kind).toBe("field-line-shape");
      if (rule?.predicate?.kind !== "field-line-shape") return;
      expect(rule.predicate.field).toBe("intent");
      expect(rule.predicate.max_first_line_chars).toBeGreaterThan(0);
      expect(rule.on_violation).toBe("warn");
    });
  });

  describe("probabilistic specs cover process-critical claims", () => {
    const specs = template.policies
      .map((r) => (r.predicate?.kind === "probabilistic" ? r.predicate.spec : null))
      .filter((s): s is string => s !== null);
    const summaries = template.policies.map((r) => r.policy);
    const haystack = [...specs, ...summaries].join("\n");

    it("exhaustive gateway / branches", () => {
      expect(/exhaustive|default\/else|enum/i.test(haystack)).toBe(true);
    });
    it("keeps gateway completeness as an assertion-time check", () => {
      const rule = template.policies.find(
        (r) =>
          r.predicate?.kind === "probabilistic" && /exhaustive outgoing branches/i.test(r.policy),
      );
      expect(rule?.fires_when_node_lifecycle).toEqual(["queued", "active"]);
    });
    it("keeps Action grain as an assertion-time check", () => {
      const rule = template.policies.find(
        (r) => r.predicate?.kind === "probabilistic" && /atomic business activity/i.test(r.policy),
      );
      expect(rule?.fires_when_node_lifecycle).toEqual(["queued", "active"]);
    });
    it("blocks imported BPMN/source metadata in user-facing process prose", () => {
      const rule = template.policies.find(
        (r) =>
          r.predicate?.kind === "probabilistic" && /imported BPMN\/source metadata/i.test(r.policy),
      );
      expect(rule?.on_violation).toBe("block");
      expect(rule?.fires_when_node_lifecycle).toEqual(["queued", "active"]);
      expect(rule?.predicate?.kind).toBe("probabilistic");
      if (rule?.predicate?.kind !== "probabilistic") return;
      expect(rule.predicate.when_node_type).toEqual(
        expect.arrayContaining(["intent", "action", "decision", "state", "eval", "rule"]),
      );
      expect(rule.predicate.when_node_type).not.toContain("reference");
      expect(rule.predicate.spec).toMatch(/Implementation status/i);
      expect(rule.predicate.spec).toMatch(/Source type/i);
      expect(rule.predicate.spec).toMatch(/exclusiveGateway/i);
      expect(rule.predicate.spec).toMatch(/visible prose/i);
    });
  });

  describe("guidance rules", () => {
    const guidance = template.policies.filter((r) => !r.predicate);
    const summaries = guidance.map((r) => r.policy);

    it("tells agents to use the authoring contract and changesets", () => {
      expect(
        summaries.some((s) => /authoring-contract\.json/i.test(s) && /changesets\.json/i.test(s)),
      ).toBe(true);
    });
    it("tells agents to use relate_many for gateway siblings", () => {
      expect(summaries.some((s) => /relate_many/i.test(s) && /gateway/i.test(s))).toBe(true);
    });
    it("documents the four-stage lifecycle (drafting → queued → active → retired) and its changeset ops", () => {
      expect(
        summaries.some(
          (s) =>
            /drafting/i.test(s) &&
            /queued/i.test(s) &&
            /active/i.test(s) &&
            /\bqueue\b/i.test(s) &&
            /\bactivate\b/i.test(s),
        ),
      ).toBe(true);
    });
    it("documents using `queued` for a ready-but-not-yet-in-force process", () => {
      expect(
        summaries.some(
          (s) => /`queued`/i.test(s) && /ready/i.test(s) && /not yet in force/i.test(s),
        ),
      ).toBe(true);
    });
    it("Log separation (instances live in a sibling Doco)", () => {
      expect(
        summaries.some(
          (s) => /instance/i.test(s) && /(separate|sibling) doco/i.test(s) && /reference/i.test(s),
        ),
      ).toBe(true);
    });
    it("BPMN sequence flow is forward-only and rendered without reversal", () => {
      expect(summaries.some((s) => /flows_to/i.test(s) && /source -> target/i.test(s))).toBe(true);
    });
  });

  describe("relationships are edge-only", () => {
    const guidanceSummaries = template.policies.filter((r) => !r.predicate).map((r) => r.policy);
    const edgeGuidance = guidanceSummaries.find((s) => /Relationships in/i.test(s));

    it("documents edge-only relationship authoring", () => {
      expect(edgeGuidance).toBeDefined();
      expect(edgeGuidance).toMatch(/attributed_to/);
      expect(edgeGuidance).toMatch(/has_parent/);
      expect(edgeGuidance).toMatch(/retiring the old edge and adding the new one/i);
      expect(guidanceSummaries.filter((s) => /Relationships in/i.test(s))).toHaveLength(1);
    });
  });

  describe("membership probabilistic gate", () => {
    const gate = template.policies.find(
      (r) =>
        r.predicate?.kind === "probabilistic" &&
        r.predicate.spec.includes("business-processes") &&
        r.predicate.spec.includes("belongs"),
    );

    it("exists and fires on the process-content node types but not Rule", () => {
      expect(gate?.predicate?.kind).toBe("probabilistic");
      if (gate?.predicate?.kind !== "probabilistic") return;
      const types = gate.predicate.when_node_type ?? [];
      expect(types).toEqual(
        expect.arrayContaining(["intent", "action", "decision", "eval", "reference"]),
      );
      expect(types).not.toContain("rule");
    });

    it("exempts State — milestone States are structural flow nodes, not membership candidates", () => {
      // A lone terminal/initial State reads like a bare state-machine stage,
      // so semantic membership-checking it warned on the very States the
      // template requires. State quality is governed by the milestone-naming
      // policy instead.
      if (gate?.predicate?.kind !== "probabilistic") return;
      expect(gate.predicate.when_node_type ?? []).not.toContain("state");
    });

    it("softens the atomic-activity grain check to a warning (LLM-judged, non-blocking)", () => {
      const atomic = template.policies.find(
        (r) => r.predicate?.kind === "probabilistic" && /atomic business activity/i.test(r.policy),
      );
      expect(atomic?.on_violation).toBe("warn");
    });
  });

  describe("queued and active are held to identical rules", () => {
    // A `queued` node asserts readiness, so promotion to `queued` is gated by
    // exactly the same policies as activation: no business-process policy may
    // fire on one committed stage without the other. Policies with no
    // lifecycle filter fire on every stage and satisfy this trivially. This
    // locks in BUSINESS_PROCESS_COMMITTED_LIFECYCLES and guards against a
    // future `["active"]`-only (or `["queued"]`-only) policy slipping in.
    it("no policy gates one committed stage without the other", () => {
      for (const p of template.policies) {
        const lifecycles = p.fires_when_node_lifecycle;
        if (!lifecycles) continue;
        const firesQueued = lifecycles.includes("queued");
        const firesActive = lifecycles.includes("active");
        expect(
          firesQueued,
          `policy "${p.policy.slice(0, 72)}…" fires on queued=${firesQueued} / active=${firesActive}; the two committed stages must be gated identically`,
        ).toBe(firesActive);
      }
    });
  });
});

describe("github-pull-requests template", () => {
  it("is registered and findable by handle", () => {
    const template = findDocoTemplateByName("github-pull-requests");
    expect(template).toBeDefined();
    expect(template?.name).toBe("github-pull-requests");
  });

  it("has a non-empty label and description", () => {
    const template = findDocoTemplateByName("github-pull-requests");
    expect(template?.label).toBeTruthy();
    expect(template?.description).toBeTruthy();
    expect(template?.description.length).toBeGreaterThan(10);
  });

  it("ships with an empty policies array (no authoring constraints)", () => {
    const template = findDocoTemplateByName("github-pull-requests");
    expect(template?.policies).toEqual([]);
  });

  it("defaults the Doco overview to the Pull requests perspective", () => {
    const template = findDocoTemplateByName("github-pull-requests");
    expect(template?.perspectives).toEqual([{ slug: "pull-requests", isDefault: true }]);
  });
});
