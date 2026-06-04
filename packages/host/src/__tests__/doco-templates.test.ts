import { describe, expect, it } from "vitest";
import {
  DEFAULT_DOCO_TEMPLATES,
  findDocoTemplateByName,
  templatePolicyToPolicyRow,
} from "../doco-templates.js";

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
    it("Decision decided_by fires only on committed stages (queued + active), NOT drafting", () => {
      // A gateway may be sketched without a decider; the decider Principal is
      // required once it is committed (`queued`/`active`), not while drafting.
      expect(
        requiresEdgeRole("attributed_to", "decided_by", "principal", "decision")
          ?.fires_when_node_lifecycle,
      ).toEqual(["queued", "active"]);
    });
    it("Action performed_by fires only on committed stages (queued + active), NOT drafting", () => {
      // An Action may be sketched without an actor; the performing Principal is
      // required once it is committed, not while drafting.
      expect(
        requiresEdgeRole("attributed_to", "performed_by", "principal", "action")
          ?.fires_when_node_lifecycle,
      ).toEqual(["queued", "active"]);
    });
    it("Eval tests a target", () => {
      const rule = requiresEdgeRole("supports", "tests", null, "eval");
      expect(rule).toBeDefined();
      expect(rule?.fires_when_node_lifecycle).toEqual(["queued", "active"]);
    });

    it("fires the flow `serves`-Intent gate only on committed stages, NOT drafting", () => {
      // Completeness, not Principal-attachment: serving an Intent is deferrable
      // while drafting (a step can be sketched before its Intent/pool is
      // chosen), so the gate fires only on `queued`/`active`. The Principal
      // gates (`performed_by`, `decided_by`) above still fire in `drafting`.
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
      const policies = template.policies.map((r) => r.policy ?? "").join("\n");
      expect(policies).toMatch(/`serves`/);
      expect(policies).toMatch(/`performed_by`/);
      expect(policies).toMatch(/`tests`/);
      expect(policies).toMatch(/`gated_by`/);
    });
  });

  describe("a flow node serves exactly one Intent (serves ceiling)", () => {
    // The `serves` floor (requires_edge_role, ≥1) gets a matching CEILING:
    // every flow node serves AT MOST one Intent, so a flow node belongs to
    // exactly one BPMN pool. Like the floor, the ceiling fires only on the
    // committed stages (`queued`/`active`) — a `drafting` sketch is exempt.
    const ceiling = template.policies.find(
      (r) =>
        r.predicate?.kind === "limits_edge_role" &&
        r.predicate.edge_type === "supports" &&
        r.predicate.edge_role === "serves",
    );

    it("seeds a limits_edge_role gate on the `serves` edge to an Intent, capped at one", () => {
      expect(ceiling?.predicate?.kind).toBe("limits_edge_role");
      if (ceiling?.predicate?.kind !== "limits_edge_role") return;
      expect(ceiling.predicate.target_node_type).toBe("intent");
      expect(ceiling.predicate.max_count).toBe(1);
      expect([...(ceiling.predicate.when_node_type ?? [])].sort()).toEqual([
        "action",
        "decision",
        "state",
      ]);
    });

    it("blocks (hard) and fires only on committed stages — NOT drafting", () => {
      // A node never serves two Intents once committed; while drafting the
      // ceiling is exempt, symmetric with the `serves` floor it complements.
      expect(ceiling?.on_violation ?? "block").toBe("block");
      expect(ceiling?.fires_when_node_lifecycle).toEqual(["queued", "active"]);
    });

    it("seeds as a deterministic policy carrying the predicate verbatim", () => {
      if (!ceiling) throw new Error("ceiling gate missing");
      const seeded = templatePolicyToPolicyRow(ceiling);
      expect(seeded.kind).toBe("deterministic");
      expect(seeded.on_violation).toBe("block");
      expect(seeded.predicate.sub_kind).toBe("limits_edge_role");
      expect(seeded.predicate.edge_role).toBe("serves");
      expect(seeded.predicate.max_count).toBe(1);
      expect(seeded.fires_when_node_lifecycle).toEqual(["queued", "active"]);
    });
  });

  describe("sub-process naming (edge-scoped)", () => {
    // A sub-process pairs a calling Action with a child purpose Intent through
    // a `serves` edge; the Intent's name should be the base (imperative) form
    // of the third-person Action (`Posts a job` → `Post a job`). The convention
    // spans two nodes, so it is enforced on the EDGE, where the judge sees both
    // endpoints — not on either node alone.
    const edgeRule = template.policies.find((r) => r.predicate?.kind === "edge-probabilistic");

    it("is an edge-probabilistic policy on the Action→Intent serves edge", () => {
      expect(edgeRule).toBeDefined();
      if (edgeRule?.predicate?.kind !== "edge-probabilistic") throw new Error("missing edge rule");
      expect(edgeRule.predicate.edge_type).toBe("supports");
      expect(edgeRule.predicate.edge_role).toBe("serves");
      expect(edgeRule.predicate.from_node_type).toBe("action");
      expect(edgeRule.predicate.to_node_type).toBe("intent");
    });

    it("spec compares both endpoints and gates ordinary flow-step serves edges", () => {
      if (edgeRule?.predicate?.kind !== "edge-probabilistic") throw new Error("missing edge rule");
      const { spec } = edgeRule.predicate;
      // Names both endpoints, the base-form rule, and the worked example.
      expect(spec).toMatch(/base \(imperative\) verb form|base form/i);
      expect(spec).toMatch(/Posts a job/);
      expect(spec).toMatch(/Post a job/);
      // A STEP-1 gate so ordinary step→purpose `serves` edges PASS (not graded).
      expect(spec).toMatch(/STEP 1/i);
      expect(spec).toMatch(/sub-?process/i);
    });

    it("seeds as a blocking probabilistic policy carrying the edge scoping", () => {
      if (!edgeRule) throw new Error("missing edge rule");
      const seeded = templatePolicyToPolicyRow(edgeRule);
      expect(seeded.kind).toBe("probabilistic");
      expect(seeded.on_violation).toBe("block");
      // The edge scoping rides on the seeded predicate; no node-type filter.
      expect(seeded.predicate.agent_instruction).toMatch(/sub-?process|base form/i);
      expect(seeded.predicate.edge_type).toBe("supports");
      expect(seeded.predicate.edge_role).toBe("serves");
      expect(seeded.predicate.from_node_type).toBe("action");
      expect(seeded.predicate.to_node_type).toBe("intent");
      expect(seeded.predicate.when_node_type).toBeUndefined();
    });
  });

  describe("Intent shape", () => {
    const intentRule = template.policies.find(
      (r) =>
        r.predicate?.kind === "probabilistic" &&
        r.predicate.when_node_type?.includes("intent") &&
        /Read the ENTIRE/i.test(r.predicate.spec),
    );

    it("grades the WHOLE intent field for a concise process purpose, never a line", () => {
      expect(intentRule?.predicate?.kind).toBe("probabilistic");
      if (intentRule?.predicate?.kind !== "probabilistic") return;
      // Graded over the entire field — a concise process purpose…
      expect(intentRule.predicate.spec).toMatch(/entire|whole field/i);
      expect(intentRule.predicate.spec).toMatch(/concise|focused/i);
      expect(intentRule.predicate.spec).toMatch(/repeatable (business )?process/i);
      // …and it must NOT grade or privilege "the first line" (the line-shaped
      // check distorted the field's vector embedding).
      expect(intentRule.predicate.spec).not.toMatch(/first line/i);
      // The Intent also no longer restates trigger / outcome / out-of-scope.
      expect(intentRule.predicate.spec).not.toMatch(/trigger/i);
      expect(intentRule.predicate.spec).not.toMatch(/out of scope|out-of-scope/i);
    });
  });

  describe("Principal lane shape", () => {
    const principalRule = template.policies.find(
      (r) =>
        r.predicate?.kind === "probabilistic" &&
        r.predicate.when_node_type?.includes("principal") &&
        /role, team, external party, or system/i.test(r.predicate.spec),
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
    const guidanceSummaries = template.policies
      .filter((r) => !r.predicate)
      .map((r) => r.policy ?? "");

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
  });

  describe("no policy grades a single line", () => {
    // Line-shaped grading distorts a field's vector embedding and forces a
    // headline structure into prose. Checks run over the whole field instead;
    // additional structure belongs in a separate field. This guards every
    // template against reintroducing the retired `field-line-shape` predicate
    // or a "first line"-scoped probabilistic spec.
    for (const t of DEFAULT_DOCO_TEMPLATES) {
      it(`${t.name} has no line-scoped policy`, () => {
        for (const p of t.policies) {
          expect(p.predicate?.kind, `${t.name} still uses field-line-shape`).not.toBe(
            "field-line-shape",
          );
          if (p.predicate?.kind === "probabilistic") {
            expect(p.predicate.spec, `${t.name} probabilistic spec scopes to a line`).not.toMatch(
              /first line|line one|the first line/i,
            );
          }
        }
      });
    }
  });

  describe("probabilistic specs cover process-critical claims", () => {
    const specs = template.policies
      .map((r) => (r.predicate?.kind === "probabilistic" ? r.predicate.spec : null))
      .filter((s): s is string => s !== null);
    const summaries = template.policies.map((r) => r.policy ?? "");
    const haystack = [...specs, ...summaries].join("\n");

    it("exhaustive gateway / branches", () => {
      expect(/exhaustive|default\/else|enum/i.test(haystack)).toBe(true);
    });
    it("keeps gateway completeness as an assertion-time check", () => {
      const rule = template.policies.find(
        (r) =>
          r.predicate?.kind === "probabilistic" &&
          r.predicate.when_node_type?.includes("decision") &&
          /default\/else|enumerat/i.test(r.predicate.spec),
      );
      expect(rule?.fires_when_node_lifecycle).toEqual(["queued", "active"]);
    });
    it("keeps Action grain as an assertion-time check", () => {
      const rule = template.policies.find(
        (r) =>
          r.predicate?.kind === "probabilistic" &&
          /single business activity/i.test(r.predicate.spec),
      );
      expect(rule?.fires_when_node_lifecycle).toEqual(["queued", "active"]);
    });
    it("blocks imported BPMN/source metadata in user-facing process prose", () => {
      const rule = template.policies.find(
        (r) => r.predicate?.kind === "probabilistic" && /Source type/i.test(r.predicate.spec ?? ""),
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
    const summaries = guidance.map((r) => r.policy ?? "");

    it("tells agents to use the authoring contract and changesets", () => {
      expect(
        summaries.some((s) => /authoring-contract\.json/i.test(s) && /changesets\.json/i.test(s)),
      ).toBe(true);
    });
    it("tells agents to use relate_many for gateway siblings", () => {
      expect(summaries.some((s) => /relate_many/i.test(s) && /gateway/i.test(s))).toBe(true);
    });
    it("tells agents to name a subprocess Intent as the base form of the calling Action", () => {
      // A subprocess pairs a calling Action with a child purpose Intent via
      // `serves`. The Action verb is typically third-person (`Posts a job`);
      // its child Intent should be the base/imperative form (`Post a job`).
      expect(
        summaries.some(
          (s) =>
            /sub-?process/i.test(s) &&
            /base form/i.test(s) &&
            /Posts a job/i.test(s) &&
            /Post a job/i.test(s),
        ),
      ).toBe(true);
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
    const guidanceSummaries = template.policies
      .filter((r) => !r.predicate)
      .map((r) => r.policy ?? "");
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
        (r) =>
          r.predicate?.kind === "probabilistic" &&
          /single business activity/i.test(r.predicate.spec),
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
          `policy "${(p.policy ?? `[${p.predicate?.kind}]`).slice(0, 72)}…" fires on queued=${firesQueued} / active=${firesActive}; the two committed stages must be gated identically`,
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
