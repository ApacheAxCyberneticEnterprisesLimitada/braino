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

describe("removed templates are gone", () => {
  // Only the plural `glossaries` handle stays deleted. The glossary concept
  // returns as the singular `glossary` template (reshaped around References),
  // the four decision-record templates return on a shared core
  // (`decision-record-templates.ts`), and `org-chart` returns as the
  // abstraction for documenting org structure — all tested below.
  for (const name of ["glossaries"]) {
    it(`does not register the removed \`${name}\` template`, () => {
      expect(findDocoTemplateByName(name)).toBeUndefined();
      expect(DEFAULT_DOCO_TEMPLATES.some((t) => t.name === name)).toBe(false);
    });
  }

  it("ships exactly the surviving templates", () => {
    expect(DEFAULT_DOCO_TEMPLATES.map((t) => t.name).sort()).toEqual([
      "architectural-decisions",
      "data-decisions",
      "design-decisions",
      "evals",
      "github-pull-requests",
      "glossary",
      "org-chart",
      "process",
      "product-decisions",
      "product-roadmap",
      "test-scenarios",
    ]);
  });
});

describe("evals template", () => {
  const template = findDocoTemplateByName("evals");
  if (!template) throw new Error("evals template not registered");

  it("is registered in DEFAULT_DOCO_TEMPLATES under its plain handle", () => {
    expect(DEFAULT_DOCO_TEMPLATES.find((t) => t.name === "evals")).toBeDefined();
  });

  it("has the expected metadata (icon, label, defaultNodeLifecycle, description)", () => {
    expect(template.icon).toBe("🧪");
    expect(template.label).toBe("AI evals");
    // An eval is sketched and a run captured before either is finalized, so new
    // nodes start `drafting` and the completeness/quality gates spare a sketch.
    expect(template.defaultNodeLifecycle).toBe("drafting");
    expect(template.description).toMatch(/eval/i);
  });

  it("opens on the built-in List perspective (an eval log is a list of evals and runs)", () => {
    expect(template.perspectives).toEqual([{ slug: "list", isDefault: true }]);
  });

  describe("node-type allowlist", () => {
    const allowlist = template.policies.find(
      (r) => r.predicate?.kind === "requires_node_type",
    )?.predicate;

    it("admits Eval (definitions), Log (runs), Reference (data/system), Rule (criteria), Principal (owners)", () => {
      expect(allowlist?.kind).toBe("requires_node_type");
      if (allowlist?.kind !== "requires_node_type") return;
      expect([...allowlist.node_types].sort()).toEqual(
        ["eval", "log", "principal", "reference", "rule"].sort(),
      );
    });

    it("excludes flow/work and free-form node types (action, state, intent, idea, decision)", () => {
      if (allowlist?.kind !== "requires_node_type") throw new Error("allowlist missing");
      for (const t of ["action", "state", "intent", "idea", "decision"]) {
        expect(allowlist.node_types).not.toContain(t as never);
      }
    });
  });

  describe("edge-type allowlist", () => {
    const allowlist = template.policies.find(
      (r) => r.predicate?.kind === "requires_edge_type",
    )?.predicate;

    it("admits the eval-log relationship edges and bars sequence flow", () => {
      expect(allowlist?.kind).toBe("requires_edge_type");
      if (allowlist?.kind !== "requires_edge_type") return;
      expect(new Set(allowlist.edge_types)).toEqual(
        new Set([
          "supports",
          "derived_from",
          "attributed_to",
          "constrained_by",
          "has_parent",
          "replaces",
          "relates_to",
        ]),
      );
      // Process sequence flow has no meaning in an eval log.
      expect(allowlist.edge_types).not.toContain("flows_to");
    });
  });

  it("requires a grading `criterion` on every committed Eval (queued/active) via requires_field", () => {
    const rule = template.policies.find(
      (r) => r.predicate?.kind === "requires_field" && r.predicate.when_node_type?.includes("eval"),
    );
    expect(rule?.predicate?.kind).toBe("requires_field");
    if (rule?.predicate?.kind !== "requires_field") return;
    expect(rule.predicate.fields).toEqual(["criterion"]);
    // A `drafting` eval may capture the intent first and choose the grader later.
    expect(rule.fires_when_node_lifecycle).toEqual(["queued", "active"]);
  });

  describe("the run→eval spine (every committed run links to the eval it ran)", () => {
    const spine = template.policies.find(
      (r) =>
        r.predicate?.kind === "requires_edge" &&
        r.predicate.edge_type === "supports" &&
        r.predicate.target_node_type === "eval" &&
        (r.predicate.when_node_type?.includes("log") ?? false),
    );

    it("ties a committed Log to its Eval via a supports edge, on committed stages only", () => {
      expect(spine?.predicate?.kind).toBe("requires_edge");
      expect(spine?.fires_when_node_lifecycle).toEqual(["queued", "active"]);
    });

    it("seeds as a blocking deterministic policy carrying the predicate verbatim", () => {
      if (!spine) throw new Error("run→eval spine gate missing");
      const seeded = templatePolicyToPolicyRow(spine);
      expect(seeded.kind).toBe("deterministic");
      expect(seeded.on_violation).toBe("block");
      expect(seeded.predicate.sub_kind).toBe("requires_edge");
      expect(seeded.predicate.edge_type).toBe("supports");
      expect(seeded.predicate.target_node_type).toBe("eval");
    });
  });

  it("gates membership softly (warn, all stages) on the primary content node types", () => {
    const membership = template.policies.find(
      (r) =>
        r.predicate?.kind === "probabilistic" &&
        r.on_violation === "warn" &&
        r.fires_when_node_lifecycle === undefined &&
        /belongs in an AI-eval log/i.test(r.predicate.spec),
    );
    expect(membership?.predicate?.kind).toBe("probabilistic");
    if (membership?.predicate?.kind !== "probabilistic") return;
    expect([...(membership.predicate.when_node_type ?? [])].sort()).toEqual(
      ["eval", "log", "reference"].sort(),
    );
    // Owners (Principal) and criteria/gates (Rule) are supporting cast, not
    // membership candidates.
    expect(membership.predicate.when_node_type).not.toContain("principal");
    expect(membership.predicate.when_node_type).not.toContain("rule");
  });

  it("judges eval-definition quality probabilistically as a warn on committed evals", () => {
    const quality = template.policies.find(
      (r) =>
        r.predicate?.kind === "probabilistic" &&
        r.predicate.when_node_type?.includes("eval") &&
        Array.isArray(r.fires_when_node_lifecycle) &&
        /what counts as success/i.test(r.predicate.spec),
    );
    expect(quality?.on_violation).toBe("warn");
    expect(quality?.fires_when_node_lifecycle).toEqual(["queued", "active"]);
  });

  it("judges run quality probabilistically as a warn on committed runs", () => {
    const quality = template.policies.find(
      (r) =>
        r.predicate?.kind === "probabilistic" &&
        r.predicate.when_node_type?.includes("log") &&
        /records BOTH/i.test(r.predicate.spec),
    );
    expect(quality?.on_violation).toBe("warn");
    expect(quality?.fires_when_node_lifecycle).toEqual(["queued", "active"]);
  });

  it("encodes the eval best practices in prose guidance", () => {
    const prose = template.policies
      .filter((p) => !p.predicate)
      .map((p) => p.policy ?? "")
      .join("\n");
    // Two-layer model: stable definition vs append-only run log.
    expect(prose).toMatch(/append-only/i);
    // Grading methods: code-based / LLM-as-judge / human.
    expect(prose).toMatch(/LLM-as-judge/i);
    expect(prose).toMatch(/code-based|programmatic/i);
    expect(prose).toMatch(/human/i);
    // SMART success criteria captured as a Rule threshold.
    expect(prose).toMatch(/SMART/);
    expect(prose).toMatch(/constrained_by/);
    // Versioned dataset / golden set.
    expect(prose).toMatch(/golden|dataset/i);
    // Pin the model/prompt versions per run.
    expect(prose).toMatch(/pin/i);
    // pass@k / pass^k for non-deterministic systems.
    expect(prose).toMatch(/pass@k/);
    expect(prose).toMatch(/pass\^k/);
    // Capability vs regression evals.
    expect(prose).toMatch(/regression/i);
    // Ownership by a Principal that is a person OR an agent.
    expect(prose).toMatch(/attributed_to/);
    expect(prose).toMatch(/agent/i);
    // Suite grouping + supersession.
    expect(prose).toMatch(/has_parent|suite/i);
    expect(prose).toMatch(/replaces/);
  });

  it("does not gate one committed stage without the other", () => {
    for (const p of template.policies) {
      const lifecycles = p.fires_when_node_lifecycle;
      if (!lifecycles) continue;
      expect(lifecycles.includes("queued")).toBe(lifecycles.includes("active"));
    }
  });
});

describe("glossary template", () => {
  const template = findDocoTemplateByName("glossary");
  if (!template) throw new Error("glossary template not registered");

  it("is registered in DEFAULT_DOCO_TEMPLATES under its plain handle", () => {
    expect(DEFAULT_DOCO_TEMPLATES.find((t) => t.name === "glossary")).toBeDefined();
  });

  it("has the expected metadata (icon, label, defaultNodeLifecycle, description)", () => {
    expect(template.icon).toBe("📖");
    expect(template.label).toBe("Glossary");
    // A term is captured before it is fully defined, so new nodes start as
    // `drafting` and the completeness/quality gates spare a sketch.
    expect(template.defaultNodeLifecycle).toBe("drafting");
    expect(template.description).toMatch(/vocabulary|terms?|glossary|definition/i);
  });

  it("ships with the Glossary perspective attached as the default", () => {
    expect(template.perspectives).toEqual([{ slug: "glossary", isDefault: true }]);
  });

  describe("node-type allowlist", () => {
    const allowlist = template.policies.find(
      (r) => r.predicate?.kind === "requires_node_type",
    )?.predicate;

    it("admits only Reference (terms) and Principal (stewards)", () => {
      expect(allowlist?.kind).toBe("requires_node_type");
      if (allowlist?.kind !== "requires_node_type") return;
      expect([...allowlist.node_types].sort()).toEqual(["principal", "reference"]);
    });
  });

  describe("edge-type allowlist", () => {
    const allowlist = template.policies.find(
      (r) => r.predicate?.kind === "requires_edge_type",
    )?.predicate;

    it("admits only the glossary relationship edges", () => {
      expect(allowlist?.kind).toBe("requires_edge_type");
      if (allowlist?.kind !== "requires_edge_type") return;
      expect([...allowlist.edge_types].sort()).toEqual([
        "attributed_to",
        "has_parent",
        "relates_to",
        "replaces",
      ]);
    });
  });

  it("requires a `definition` on every committed term (queued/active) via requires_field", () => {
    const rule = template.policies.find(
      (r) =>
        r.predicate?.kind === "requires_field" && r.predicate.when_node_type?.includes("reference"),
    );
    expect(rule?.predicate?.kind).toBe("requires_field");
    if (rule?.predicate?.kind !== "requires_field") return;
    expect(rule.predicate.fields).toEqual(["definition"]);
    // A `drafting` stub may capture the headword first; the definition is
    // required only once the term is committed.
    expect(rule.fires_when_node_lifecycle).toEqual(["queued", "active"]);
  });

  it("gates membership softly (warn, all stages) so an off-topic node is surfaced, not blocked", () => {
    const membership = template.policies.find(
      (r) =>
        r.predicate?.kind === "probabilistic" &&
        r.predicate.when_node_type?.includes("reference") &&
        r.on_violation === "warn" &&
        r.fires_when_node_lifecycle === undefined,
    );
    expect(membership).toBeDefined();
  });

  it("judges definition quality probabilistically as a warn on committed terms", () => {
    const quality = template.policies.find(
      (r) =>
        r.predicate?.kind === "probabilistic" &&
        r.predicate.when_node_type?.includes("reference") &&
        Array.isArray(r.fires_when_node_lifecycle),
    );
    expect(quality?.predicate?.kind).toBe("probabilistic");
    expect(quality?.on_violation).toBe("warn");
    expect(quality?.fires_when_node_lifecycle).toEqual(["queued", "active"]);
  });

  it("guides preferred terms, synonyms, cross-references, provenance, stewardship, and lifecycle in prose", () => {
    const prose = template.policies
      .filter((p) => !p.predicate)
      .map((p) => p.policy ?? "")
      .join("\n");
    expect(prose).toMatch(/synonym|alias|alternativ/i);
    expect(prose).toMatch(/relates_to|cross-reference/i);
    expect(prose).toMatch(/has_parent|broader|categor/i);
    expect(prose).toMatch(/replaces|deprecat|supersede/i);
    expect(prose).toMatch(/derived_from|source|cite/i);
    expect(prose).toMatch(/attributed_to|steward|owner/i);
    expect(prose).toMatch(/lifecycle|drafting|queued|active|retired/i);
  });
});

describe("process template", () => {
  const template = findDocoTemplateByName("process");
  if (!template) throw new Error("process template not registered");

  it("is registered in DEFAULT_DOCO_TEMPLATES under its plain handle", () => {
    expect(DEFAULT_DOCO_TEMPLATES.find((t) => t.name === "process")).toBeDefined();
  });

  it("is reachable via its bare handle and is NOT reachable via the legacy hashtag-prefixed form", () => {
    const bare = findDocoTemplateByName("process");
    const hashtagged = findDocoTemplateByName("#process");
    expect(bare).toBeDefined();
    expect(bare?.name).toBe("process");
    expect(hashtagged).toBeUndefined();
  });

  it("has the expected metadata (icon, label, defaultNodeLifecycle)", () => {
    expect(template.icon).toBe("🔁");
    expect(template.label).toBe("Processes");
    expect(template.defaultNodeLifecycle).toBe("drafting");
    expect(template.description).toMatch(/repeatable business processes/i);
    expect(template.description).toMatch(/BPMN/);
  });

  it("ships with the BPMN perspective attached as the default", () => {
    expect(template.perspectives).toEqual([{ slug: "process", isDefault: true }]);
  });

  describe("node-type allowlist", () => {
    const allowlist = template.policies.find(
      (r) => r.predicate?.kind === "requires_node_type",
    )?.predicate;

    it("includes only process node types (no Intent — a process is an Action)", () => {
      expect(allowlist?.kind).toBe("requires_node_type");
      if (allowlist?.kind !== "requires_node_type") return;
      expect([...allowlist.node_types].sort()).toEqual(
        ["action", "decision", "eval", "principal", "reference", "rule", "state"].sort(),
      );
      expect(allowlist.node_types).not.toContain("intent");
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
        /Only Action, Decision, State, Eval, Reference, Rule, and Principal/i,
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
    // With `role` gone, each gate that used to be `requires_edge_role` is now a
    // role-free `requires_edge` distinguished by edge_type + target_node_type +
    // the candidate node type (`when_node_type`). E.g. the Action-performer gate
    // is `requires_edge`(attributed_to → principal) scoped to `action`; the
    // membership gate is `requires_edge`(has_parent → action) scoped to the flow node.
    function requiresEdge(edgeType: string, target: string | null, on: string) {
      return template.policies.find(
        (r) =>
          r.predicate?.kind === "requires_edge" &&
          r.predicate.edge_type === edgeType &&
          (target === null
            ? r.predicate.target_node_type === undefined
            : r.predicate.target_node_type === target) &&
          (r.predicate.when_node_type?.includes(on as never) ?? false) &&
          // Exclude the incoming actor-coverage gate (direction: incoming),
          // which also matches attributed_to but is a different rule.
          r.predicate.direction !== "incoming",
      );
    }

    it("Action belongs to a process (has_parent → action)", () => {
      expect(requiresEdge("has_parent", "action", "action")).toBeDefined();
    });
    it("Decision belongs to a process (has_parent → action)", () => {
      expect(requiresEdge("has_parent", "action", "decision")).toBeDefined();
    });
    it("State belongs to a process (has_parent → action)", () => {
      expect(requiresEdge("has_parent", "action", "state")).toBeDefined();
    });
    it("Action attributed to its performer Principal (attributed_to → principal)", () => {
      expect(requiresEdge("attributed_to", "principal", "action")).toBeDefined();
    });
    it("Decision attributed to its decider Principal (attributed_to → principal)", () => {
      // A gateway routes the flow, but a role, team, or system is
      // accountable for how it is decided. Require that decider explicitly,
      // mirroring the Action performer gate. With roles gone, a Decision's
      // `attributed_to` edge to a Principal IS its decider (source = decision).
      expect(requiresEdge("attributed_to", "principal", "decision")).toBeDefined();
    });
    it("Decision decider edge fires only on committed stages (queued + active), NOT drafting", () => {
      // A gateway may be sketched without a decider; the decider Principal is
      // required once it is committed (`queued`/`active`), not while drafting.
      expect(
        requiresEdge("attributed_to", "principal", "decision")?.fires_when_node_lifecycle,
      ).toEqual(["queued", "active"]);
    });
    it("Action performer edge fires only on committed stages (queued + active), NOT drafting", () => {
      // An Action may be sketched without an actor; the performing Principal is
      // required once it is committed, not while drafting.
      expect(
        requiresEdge("attributed_to", "principal", "action")?.fires_when_node_lifecycle,
      ).toEqual(["queued", "active"]);
    });
    it("Eval tests a target (supports, any endpoint)", () => {
      const rule = requiresEdge("supports", null, "eval");
      expect(rule).toBeDefined();
      expect(rule?.fires_when_node_lifecycle).toEqual(["queued", "active"]);
    });

    it("fires the process-membership gate only on committed stages, NOT drafting", () => {
      // Completeness, not Principal-attachment: belonging to a process is
      // deferrable while drafting (a step can be sketched before its parent
      // process/pool is chosen), so the gate fires only on `queued`/`active`.
      // The Principal attribution gates above still fire in `drafting`.
      expect(requiresEdge("has_parent", "action", "action")?.fires_when_node_lifecycle).toEqual([
        "queued",
        "active",
      ]);
      expect(requiresEdge("has_parent", "action", "decision")?.fires_when_node_lifecycle).toEqual([
        "queued",
        "active",
      ]);
      expect(requiresEdge("has_parent", "action", "state")?.fires_when_node_lifecycle).toEqual([
        "queued",
        "active",
      ]);
    });

    it("exempts a top-level process from the membership floor via the top_level_process flag", () => {
      // The membership floor is a hard block, but a top-level process Action has
      // no parent of its own. The ONLY thing that excuses it is the explicit
      // `top_level_process` flag — there is no structural incoming-edge exemption.
      const floor = requiresEdge("has_parent", "action", "action");
      expect(floor?.predicate?.kind).toBe("requires_edge");
      if (floor?.predicate?.kind !== "requires_edge") return;
      expect(floor.predicate.exempt_when_field_truthy).toBe("top_level_process");
      expect(floor.predicate.exempt_when_incoming_edge_type).toBeUndefined();
      // A hard block (default), not a warn.
      expect(floor.on_violation ?? "block").toBe("block");
    });

    it("describes edge meaning by type + endpoint node types, never a role tag", () => {
      // The guidance must NOT reintroduce role tokens as edge roles, and the
      // BPMN-vocabulary guidance now derives meaning from edge type + endpoints.
      const policies = template.policies.map((r) => r.policy ?? "").join("\n");
      expect(policies).toMatch(/an edge's meaning comes from its type plus the node types/i);
      expect(policies).toMatch(/`attributed_to` edge to a Principal drives actor lanes/i);
      expect(policies).toMatch(/`supports` edge from an Eval tests/i);
      expect(policies).toMatch(/`constrained_by` edge to a Rule/i);
      // No retired role vocabulary leaks back into the prose.
      expect(policies).not.toMatch(/`serves`|`performed_by`|`decided_by`|`owned_by`|`gated_by`/);
      expect(policies).not.toMatch(/role `\w+`|carrying role|with role metadata|role examples/i);
    });
  });

  describe("a flow node belongs to exactly one process (membership ceiling)", () => {
    // The membership floor (requires_edge has_parent → action, ≥1) gets a
    // matching CEILING: every flow node has AT MOST one `has_parent`, so it
    // belongs to exactly one BPMN pool. A role-free `limits_edge`(has_parent →
    // action, max 1). Like the floor, the ceiling fires only on the committed
    // stages (`queued`/`active`) — a `drafting` sketch is exempt.
    const ceiling = template.policies.find(
      (r) =>
        r.predicate?.kind === "limits_edge" &&
        r.predicate.edge_type === "has_parent" &&
        r.predicate.target_node_type === "action",
    );

    it("seeds a limits_edge gate on the `has_parent` edge to a process Action, capped at one", () => {
      expect(ceiling?.predicate?.kind).toBe("limits_edge");
      if (ceiling?.predicate?.kind !== "limits_edge") return;
      expect(ceiling.predicate.target_node_type).toBe("action");
      expect(ceiling.predicate.max_count).toBe(1);
      expect([...(ceiling.predicate.when_node_type ?? [])].sort()).toEqual([
        "action",
        "decision",
        "state",
      ]);
    });

    it("blocks (hard) and fires only on committed stages — NOT drafting", () => {
      // A node never belongs to two processes once committed; while drafting the
      // ceiling is exempt, symmetric with the membership floor it complements.
      expect(ceiling?.on_violation ?? "block").toBe("block");
      expect(ceiling?.fires_when_node_lifecycle).toEqual(["queued", "active"]);
    });

    it("seeds as a deterministic policy carrying the predicate verbatim", () => {
      if (!ceiling) throw new Error("ceiling gate missing");
      const seeded = templatePolicyToPolicyRow(ceiling);
      expect(seeded.kind).toBe("deterministic");
      expect(seeded.on_violation).toBe("block");
      expect(seeded.predicate.sub_kind).toBe("limits_edge");
      expect(seeded.predicate.edge_type).toBe("has_parent");
      expect(seeded.predicate.target_node_type).toBe("action");
      expect(seeded.predicate.max_count).toBe(1);
      expect(seeded.fires_when_node_lifecycle).toEqual(["queued", "active"]);
    });
  });

  describe("no Intent / subprocess-naming policies remain", () => {
    it("seeds no edge-probabilistic subprocess-naming policy (a process is an Action now)", () => {
      expect(
        template.policies.find((r) => r.predicate?.kind === "edge-probabilistic"),
      ).toBeUndefined();
    });

    it("scopes no policy to the Intent node type", () => {
      for (const p of template.policies) {
        const pred = p.predicate;
        if (pred && "when_node_type" in pred && pred.when_node_type) {
          expect(pred.when_node_type).not.toContain("intent" as never);
        }
      }
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

  describe("State milestone uniqueness", () => {
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

    it("no flow-wiring gate remains — the curated set drops sequence-flow completeness", () => {
      expect(template.policies.find((r) => r.predicate?.kind === "flow-wiring")).toBeUndefined();
    });
  });

  describe("actor coverage is no longer enforced", () => {
    it("seeds no incoming attributed_to coverage gate", () => {
      // The curated set drops the per-step Principal-coverage warn; the only
      // attributed_to gate left is the OUTGOING actor-attribution floor on
      // Actions + gateway Decisions.
      const rule = template.policies.find(
        (r) =>
          r.predicate?.kind === "requires_edge" &&
          r.predicate.edge_type === "attributed_to" &&
          r.predicate.direction === "incoming",
      );
      expect(rule).toBeUndefined();
    });
  });

  describe("actor attribution gate (merged Action + gateway Decision)", () => {
    // The Action-performer and gateway-decider gates collapse into ONE
    // outgoing `requires_edge`(attributed_to → principal) scoped to both
    // node types: a committed Action or gateway Decision names its Principal.
    const gate = template.policies.find(
      (r) =>
        r.predicate?.kind === "requires_edge" &&
        r.predicate.edge_type === "attributed_to" &&
        r.predicate.target_node_type === "principal" &&
        r.predicate.direction !== "incoming",
    );

    it("is a single gate scoped to both action and decision", () => {
      expect(gate?.predicate?.kind).toBe("requires_edge");
      if (gate?.predicate?.kind !== "requires_edge") return;
      expect([...(gate.predicate.when_node_type ?? [])].sort()).toEqual(["action", "decision"]);
      expect(gate.fires_when_node_lifecycle).toEqual(["queued", "active"]);
    });
  });

  describe("top-level-process exemption on the membership floor", () => {
    // A top-level process Action has no parent. The ONLY thing that excuses a
    // flow node from the `has_parent` membership floor is the explicit
    // `top_level_process` flag — the structural incoming-`has_parent` exemption
    // is gone, and `entry_point` no longer waives membership (it now governs
    // sequence-flow wiring, not pool membership).
    const floor = template.policies.find(
      (r) =>
        r.predicate?.kind === "requires_edge" &&
        r.predicate.edge_type === "has_parent" &&
        r.predicate.target_node_type === "action" &&
        r.predicate.direction !== "incoming",
    );

    it("is exempted only by the top_level_process flag (no structural incoming exemption)", () => {
      expect(floor?.predicate?.kind).toBe("requires_edge");
      if (floor?.predicate?.kind !== "requires_edge") return;
      expect(floor.predicate.exempt_when_field_truthy).toBe("top_level_process");
      expect(floor.predicate.exempt_when_incoming_edge_type).toBeUndefined();
    });

    it("requires the flow node's OUTGOING has_parent (direction stated, not implied)", () => {
      // The required relationship is the flow node → its parent process Action:
      // an OUTGOING `has_parent`. Stating it explicitly keeps the rendered policy
      // unambiguous.
      expect(floor?.predicate?.kind).toBe("requires_edge");
      if (floor?.predicate?.kind !== "requires_edge") return;
      expect(floor.predicate.direction).toBe("outgoing");
    });

    it("documents the top-level-process exemption in its prose", () => {
      expect(floor?.policy ?? "").toMatch(/top.level process/i);
    });
  });

  describe("sequence-flow wiring rules (entry points)", () => {
    // Two role-free `requires_edge` floors keep a committed process wired up:
    //  - reach: every flow node is reached by the flow (≥1 INCOMING `flows_to`)
    //    unless it is an `entry_point`;
    //  - lead:  an `entry_point` leads somewhere (≥1 OUTGOING `flows_to`).
    // Both fire on the committed stages only — a `drafting` sketch may dangle.
    const reach = template.policies.find(
      (r) =>
        r.predicate?.kind === "requires_edge" &&
        r.predicate.edge_type === "flows_to" &&
        r.predicate.direction === "incoming",
    );
    const lead = template.policies.find(
      (r) =>
        r.predicate?.kind === "requires_edge" &&
        r.predicate.edge_type === "flows_to" &&
        r.predicate.require_when_field_truthy === "entry_point",
    );

    it("a flow node must be reached (≥1 incoming flows_to) unless entry point or top-level process", () => {
      expect(reach?.predicate?.kind).toBe("requires_edge");
      if (reach?.predicate?.kind !== "requires_edge") return;
      // Excused for the flow start (entry_point) and the pool container
      // (top_level_process) — both are not reached-by-flow steps.
      expect(reach.predicate.exempt_when_field_truthy).toBe("entry_point, top_level_process");
      expect([...(reach.predicate.when_node_type ?? [])].sort()).toEqual([
        "action",
        "decision",
        "state",
      ]);
      expect(reach.fires_when_node_lifecycle).toEqual(["queued", "active"]);
    });

    it("an entry point must lead somewhere (≥1 outgoing flows_to)", () => {
      expect(lead?.predicate?.kind).toBe("requires_edge");
      if (lead?.predicate?.kind !== "requires_edge") return;
      expect(lead.predicate.direction).toBe("outgoing");
      expect(lead.predicate.require_when_field_truthy).toBe("entry_point");
      expect(lead.fires_when_node_lifecycle).toEqual(["queued", "active"]);
    });
  });

  describe("deterministic floors under the LLM judges", () => {
    it("a gateway Decision needs ≥2 outgoing flows_to (structural floor under the exhaustiveness judge)", () => {
      const rule = template.policies.find(
        (r) =>
          r.predicate?.kind === "requires_edge" &&
          r.predicate.edge_type === "flows_to" &&
          r.predicate.min_count === 2 &&
          (r.predicate.when_node_type?.includes("decision") ?? false),
      );
      expect(rule?.predicate?.kind).toBe("requires_edge");
      if (rule?.predicate?.kind !== "requires_edge") return;
      expect(rule.predicate.min_count).toBe(2);
      expect(rule.fires_when_node_lifecycle).toEqual(["queued", "active"]);
    });

    it("no deterministic scaffolding floor remains — import provenance is the probabilistic judge only", () => {
      expect(
        template.policies.find((r) => r.predicate?.kind === "forbids_field_pattern"),
      ).toBeUndefined();
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
        expect.arrayContaining(["action", "decision", "state", "eval", "rule"]),
      );
      expect(rule.predicate.when_node_type).not.toContain("reference");
      expect(rule.predicate.when_node_type).not.toContain("intent");
      expect(rule.predicate.spec).toMatch(/Implementation status/i);
      expect(rule.predicate.spec).toMatch(/Source type/i);
      expect(rule.predicate.spec).toMatch(/exclusiveGateway/i);
      expect(rule.predicate.spec).toMatch(/visible prose/i);
    });
  });

  describe("guidance rules", () => {
    const guidance = template.policies.filter((r) => !r.predicate);
    const summaries = guidance.map((r) => r.policy ?? "");

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
        r.predicate.spec.includes("process") &&
        r.predicate.spec.includes("belongs"),
    );

    it("exists and fires on the process-content node types but not Rule", () => {
      expect(gate?.predicate?.kind).toBe("probabilistic");
      if (gate?.predicate?.kind !== "probabilistic") return;
      const types = gate.predicate.when_node_type ?? [];
      expect(types).toEqual(expect.arrayContaining(["action", "decision", "eval", "reference"]));
      expect(types).not.toContain("rule");
      expect(types).not.toContain("intent");
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

describe("org-chart template", () => {
  const template = findDocoTemplateByName("org-chart");
  if (!template) throw new Error("org-chart template not registered");

  it("is registered and findable by its plain handle", () => {
    expect(DEFAULT_DOCO_TEMPLATES.find((t) => t.name === "org-chart")).toBeDefined();
    expect(findDocoTemplateByName("org-chart")?.name).toBe("org-chart");
  });

  it("has the expected metadata (icon, label, description)", () => {
    expect(template.icon).toBe("🏢");
    expect(template.label).toBe("Org chart");
    expect(template.description).toMatch(/reports to/i);
    expect(template.description).toMatch(/org tree/i);
  });

  it("documents an existing structure, so it does NOT default new nodes to drafting", () => {
    // No draft → queue → activate workflow: a captured seat lands `active` and
    // is held to the chart's shape immediately. Hence no defaultNodeLifecycle.
    expect(template.defaultNodeLifecycle).toBeUndefined();
  });

  it("ships with the org-tree perspective attached as the default tab", () => {
    expect(template.perspectives).toEqual([{ slug: "org-tree", isDefault: true }]);
  });

  describe("node-type allowlist", () => {
    const allowlist = template.policies.find(
      (r) => r.predicate?.kind === "requires_node_type",
    )?.predicate;

    it("admits only org-structure node types", () => {
      expect(allowlist?.kind).toBe("requires_node_type");
      if (allowlist?.kind !== "requires_node_type") return;
      expect([...allowlist.node_types].sort()).toEqual(
        ["decision", "intent", "principal", "reference", "rule"].sort(),
      );
    });

    it("excludes the process/work node types (Action, State, Eval)", () => {
      if (allowlist?.kind !== "requires_node_type") throw new Error("allowlist missing");
      expect(allowlist.node_types).not.toContain("action");
      expect(allowlist.node_types).not.toContain("state");
      expect(allowlist.node_types).not.toContain("eval");
    });
  });

  describe("edge-type allowlist", () => {
    const allowlist = template.policies.find(
      (r) => r.predicate?.kind === "requires_edge_type",
    )?.predicate;

    it("admits the reporting + association edge types, barring process-flow edges", () => {
      expect(allowlist?.kind).toBe("requires_edge_type");
      if (allowlist?.kind !== "requires_edge_type") return;
      expect(new Set(allowlist.edge_types)).toEqual(
        new Set([
          "has_parent",
          "attributed_to",
          "relates_to",
          "supports",
          "replaces",
          "derived_from",
        ]),
      );
      // `relates_to` carries the dotted-line meaning; flow/guard edges do not belong.
      expect(allowlist.edge_types).toContain("relates_to");
      expect(allowlist.edge_types).not.toContain("flows_to");
      expect(allowlist.edge_types).not.toContain("constrained_by");
    });
  });

  describe("unity of command (one solid reporting line per seat)", () => {
    const ceiling = template.policies.find(
      (r) =>
        r.predicate?.kind === "limits_edge" &&
        r.predicate.edge_type === "has_parent" &&
        r.predicate.target_node_type === "principal",
    );

    it("caps a seat at one `has_parent` edge to a manager, as a hard block", () => {
      expect(ceiling?.predicate?.kind).toBe("limits_edge");
      if (ceiling?.predicate?.kind !== "limits_edge") return;
      expect(ceiling.predicate.max_count).toBe(1);
      expect(ceiling.predicate.when_node_type).toEqual(["principal"]);
      expect(ceiling.on_violation ?? "block").toBe("block");
    });

    it("seeds as a deterministic policy carrying the predicate verbatim", () => {
      if (!ceiling) throw new Error("unity-of-command ceiling missing");
      const seeded = templatePolicyToPolicyRow(ceiling);
      expect(seeded.kind).toBe("deterministic");
      expect(seeded.on_violation).toBe("block");
      expect(seeded.predicate.sub_kind).toBe("limits_edge");
      expect(seeded.predicate.edge_type).toBe("has_parent");
      expect(seeded.predicate.max_count).toBe(1);
    });

    it("is a structural invariant: it carries no lifecycle filter", () => {
      // An org chart has no drafting workflow — the tree must hold at every
      // lifecycle, so the cap is unscoped.
      expect(ceiling?.fires_when_node_lifecycle).toBeUndefined();
    });
  });

  describe("soft semantic gates (warnings, LLM-judged)", () => {
    it("warns when a node does not read as org structure (membership)", () => {
      const gate = template.policies.find(
        (r) =>
          r.predicate?.kind === "probabilistic" &&
          /organizational STRUCTURE/i.test(r.predicate.spec),
      );
      expect(gate?.on_violation).toBe("warn");
      if (gate?.predicate?.kind !== "probabilistic") return;
      const types = gate.predicate.when_node_type ?? [];
      expect(types).toEqual(
        expect.arrayContaining(["principal", "intent", "decision", "reference"]),
      );
      // Rules govern the chart rather than being chart content.
      expect(types).not.toContain("rule");
    });

    it("warns when a seat leaves its occupant (person / agent / vacant) unstated", () => {
      const gate = template.policies.find(
        (r) =>
          r.predicate?.kind === "probabilistic" &&
          r.predicate.when_node_type?.includes("principal") &&
          /vacant/i.test(r.predicate.spec),
      );
      expect(gate?.on_violation).toBe("warn");
      if (gate?.predicate?.kind !== "probabilistic") return;
      expect(gate.predicate.spec).toMatch(/`human`/);
      expect(gate.predicate.spec).toMatch(/`agent`/);
    });
  });

  describe("guidance encodes the org-chart best practices", () => {
    const summaries = template.policies.filter((r) => !r.predicate).map((r) => r.policy ?? "");
    const haystack = summaries.join("\n");

    it("positions define the structure, not the people", () => {
      expect(haystack).toMatch(/Positions define the structure, not the people/i);
    });
    it("dotted-line / matrix coordination is `relates_to`, not a second solid line", () => {
      expect(haystack).toMatch(/dotted-line \/ matrix relationships with `relates_to`/i);
    });
    it("a decision right has a single point of accountability", () => {
      expect(haystack).toMatch(/single (point of )?accountab/i);
      expect(haystack).toMatch(/RACI/);
    });
    it("vacant seats stay on the chart for planning", () => {
      expect(haystack).toMatch(/unfilled seats vacant/i);
    });
    it("teams / departments are Intents the seats are `attributed_to`", () => {
      expect(haystack).toMatch(/teams or departments/i);
      expect(haystack).toMatch(/`attributed_to`/);
    });
  });
});

describe("product-roadmap template", () => {
  const template = findDocoTemplateByName("product-roadmap");
  if (!template) throw new Error("product-roadmap template not registered");

  it("is registered and findable by its plain handle", () => {
    expect(DEFAULT_DOCO_TEMPLATES.find((t) => t.name === "product-roadmap")).toBeDefined();
    expect(findDocoTemplateByName("product-roadmap")?.name).toBe("product-roadmap");
  });

  it("has the expected metadata (icon, label, description, defaultNodeLifecycle)", () => {
    expect(template.icon).toBe("🗺️");
    expect(template.label).toBe("Product roadmap");
    // A bet is parked / sketched before it is committed, so new nodes start as
    // `drafting` and the owner/horizon gates spare a parking-lot idea.
    expect(template.defaultNodeLifecycle).toBe("drafting");
    expect(template.description).toMatch(/roadmap|outcome/i);
    expect(template.description).toMatch(/now ?\/ ?next ?\/ ?later|horizon/i);
  });

  it("opens on the built-in List perspective (a roadmap is a filterable list of bets)", () => {
    expect(template.perspectives).toEqual([{ slug: "list", isDefault: true }]);
  });

  describe("node-type allowlist", () => {
    const allowlist = template.policies.find(
      (r) => r.predicate?.kind === "requires_node_type",
    )?.predicate;

    it("admits only the roadmap node types (item, result, owner, evidence, decision, criteria)", () => {
      expect(allowlist?.kind).toBe("requires_node_type");
      if (allowlist?.kind !== "requires_node_type") return;
      expect([...allowlist.node_types].sort()).toEqual(
        ["decision", "eval", "intent", "principal", "reference", "rule"].sort(),
      );
    });

    it("excludes delivery/changelog node types (Action, State, Log, Idea)", () => {
      if (allowlist?.kind !== "requires_node_type") throw new Error("allowlist missing");
      expect(allowlist.node_types).not.toContain("action");
      expect(allowlist.node_types).not.toContain("state");
      expect(allowlist.node_types).not.toContain("log");
      expect(allowlist.node_types).not.toContain("idea");
    });
  });

  describe("edge-type allowlist", () => {
    const allowlist = template.policies.find(
      (r) => r.predicate?.kind === "requires_edge_type",
    )?.predicate;

    it("admits the roadmap relationship edges and bars process sequence flow", () => {
      expect(allowlist?.kind).toBe("requires_edge_type");
      if (allowlist?.kind !== "requires_edge_type") return;
      expect(new Set(allowlist.edge_types)).toEqual(
        new Set([
          "has_parent",
          "attributed_to",
          "supports",
          "constrained_by",
          "relates_to",
          "derived_from",
          "replaces",
        ]),
      );
      expect(allowlist.edge_types).not.toContain("flows_to");
    });
  });

  describe("completeness gates (committed only)", () => {
    function requiresEdge(edgeType: string, target: string | null, on: string) {
      return template.policies.find(
        (r) =>
          r.predicate?.kind === "requires_edge" &&
          r.predicate.edge_type === edgeType &&
          (target === null
            ? r.predicate.target_node_type === undefined
            : r.predicate.target_node_type === target) &&
          (r.predicate.when_node_type?.includes(on as never) ?? false),
      );
    }

    it("a committed roadmap item is attributed to an owner Principal (attributed_to → principal)", () => {
      const gate = requiresEdge("attributed_to", "principal", "intent");
      expect(gate?.predicate?.kind).toBe("requires_edge");
      expect(gate?.fires_when_node_lifecycle).toEqual(["queued", "active"]);
    });

    it("a committed roadmap item carries a `horizon` (requires_field, committed only)", () => {
      const gate = template.policies.find(
        (r) =>
          r.predicate?.kind === "requires_field" && r.predicate.when_node_type?.includes("intent"),
      );
      expect(gate?.predicate?.kind).toBe("requires_field");
      if (gate?.predicate?.kind !== "requires_field") return;
      expect(gate.predicate.fields).toEqual(["horizon"]);
      expect(gate.fires_when_node_lifecycle).toEqual(["queued", "active"]);
    });

    it("a committed result (Eval) links the item it measures (supports, committed only)", () => {
      const gate = requiresEdge("supports", null, "eval");
      expect(gate?.predicate?.kind).toBe("requires_edge");
      expect(gate?.fires_when_node_lifecycle).toEqual(["queued", "active"]);
    });

    it("seeds the horizon gate as a blocking deterministic policy carrying the predicate verbatim", () => {
      const gate = template.policies.find(
        (r) =>
          r.predicate?.kind === "requires_field" && r.predicate.when_node_type?.includes("intent"),
      );
      if (!gate) throw new Error("horizon gate missing");
      const seeded = templatePolicyToPolicyRow(gate);
      expect(seeded.kind).toBe("deterministic");
      expect(seeded.on_violation).toBe("block");
      expect(seeded.predicate.sub_kind).toBe("requires_field");
      expect(seeded.predicate.fields).toEqual(["horizon"]);
      expect(seeded.fires_when_node_lifecycle).toEqual(["queued", "active"]);
    });
  });

  describe("soft semantic gates (warnings, LLM-judged)", () => {
    it("warns when a node does not read as roadmap content (membership), exempting owners and criteria", () => {
      const gate = template.policies.find(
        (r) =>
          r.predicate?.kind === "probabilistic" &&
          /belongs on a product roadmap/i.test(r.predicate.spec),
      );
      expect(gate?.on_violation).toBe("warn");
      // Membership is an all-stages nudge, like the other templates.
      expect(gate?.fires_when_node_lifecycle).toBeUndefined();
      if (gate?.predicate?.kind !== "probabilistic") return;
      const types = gate.predicate.when_node_type ?? [];
      expect(types).toEqual(expect.arrayContaining(["intent", "eval", "decision", "reference"]));
      // Owners (Principals) and criteria (Rules) are supporting cast, not bets.
      expect(types).not.toContain("principal");
      expect(types).not.toContain("rule");
    });

    it("warns (committed) when an item is framed as an output, not a measurable outcome", () => {
      const gate = template.policies.find(
        (r) =>
          r.predicate?.kind === "probabilistic" &&
          r.predicate.when_node_type?.includes("intent") &&
          /outcome/i.test(r.predicate.spec) &&
          /output|feature/i.test(r.predicate.spec),
      );
      expect(gate?.on_violation).toBe("warn");
      expect(gate?.fires_when_node_lifecycle).toEqual(["queued", "active"]);
    });

    it("warns (committed) when a result does not close the loop (target → actual → verdict → decision)", () => {
      const gate = template.policies.find(
        (r) =>
          r.predicate?.kind === "probabilistic" &&
          r.predicate.when_node_type?.includes("eval") &&
          /persevere|iterate|pivot|kill/i.test(r.predicate.spec),
      );
      expect(gate?.on_violation).toBe("warn");
      expect(gate?.fires_when_node_lifecycle).toEqual(["queued", "active"]);
      if (gate?.predicate?.kind !== "probabilistic") return;
      expect(gate.predicate.spec).toMatch(/expected/i);
      expect(gate.predicate.spec).toMatch(/last_status|pending|validated|invalidated/i);
    });

    it("warns when an owner does not read as a single accountable person/role/team", () => {
      const gate = template.policies.find(
        (r) =>
          r.predicate?.kind === "probabilistic" &&
          r.predicate.when_node_type?.includes("principal") &&
          /accountable owner/i.test(r.predicate.spec),
      );
      expect(gate?.on_violation).toBe("warn");
    });
  });

  describe("queued and active are held to identical rules", () => {
    // A `queued` (planned) item asserts it is on the roadmap, so it is gated by
    // exactly the same policies as an `active` (in-progress) one: no roadmap
    // policy may fire on one committed stage without the other.
    it("no policy gates one committed stage without the other", () => {
      for (const p of template.policies) {
        const lifecycles = p.fires_when_node_lifecycle;
        if (!lifecycles) continue;
        expect(lifecycles.includes("queued")).toBe(lifecycles.includes("active"));
      }
    });
  });

  describe("guidance encodes the roadmap best practices", () => {
    const summaries = template.policies.filter((r) => !r.predicate).map((r) => r.policy ?? "");
    const haystack = summaries.join("\n");

    it("leads with outcomes over outputs", () => {
      expect(haystack).toMatch(/outcomes,? not outputs/i);
    });
    it("buckets items into Now / Next / Later horizons and keeps dates an extension", () => {
      expect(haystack).toMatch(/now ?\/ ?next ?\/ ?later/i);
      expect(haystack).toMatch(/date/i);
    });
    it("gives every item one accountable owner", () => {
      expect(haystack).toMatch(/accountable owner/i);
      expect(haystack).toMatch(/`attributed_to`/);
    });
    it("groups bets under outcomes/objectives and aligns to OKRs", () => {
      expect(haystack).toMatch(/`has_parent`/);
      expect(haystack).toMatch(/OKR|objective|key result/i);
    });
    it("prioritizes explicitly with criteria captured as Rules", () => {
      expect(haystack).toMatch(/prioriti/i);
      expect(haystack).toMatch(/RICE|value vs\.? effort/i);
      expect(haystack).toMatch(/`constrained_by`/);
    });
    it("grounds bets in evidence via References", () => {
      expect(haystack).toMatch(/evidence|discovery|research/i);
      expect(haystack).toMatch(/Reference/);
    });
    it("wires dependencies with relates_to", () => {
      expect(haystack).toMatch(/dependenc/i);
      expect(haystack).toMatch(/`relates_to`/);
    });
    it("closes the loop — a bet is done when measured, with an Eval result", () => {
      expect(haystack).toMatch(/close the loop/i);
      expect(haystack).toMatch(/measured|measur/i);
      expect(haystack).toMatch(/persevere|iterate|pivot|kill/i);
    });
    it("revisits the roadmap on a cadence and supersedes rather than rewrites", () => {
      expect(haystack).toMatch(/cadence|quarterly/i);
      expect(haystack).toMatch(/supersede|`replaces`/i);
    });
    it("keeps a roadmap distinct from a backlog and a release plan", () => {
      expect(haystack).toMatch(/not a backlog/i);
      expect(haystack).toMatch(/release plan/i);
    });
    it("tells agents to author via the contract + changesets", () => {
      expect(haystack).toMatch(/authoring-contract/);
      expect(haystack).toMatch(/changesets/);
    });
  });
});

describe("test-scenarios template", () => {
  const template = findDocoTemplateByName("test-scenarios");
  if (!template) throw new Error("test-scenarios template not registered");

  it("is registered in DEFAULT_DOCO_TEMPLATES under its plain handle", () => {
    expect(DEFAULT_DOCO_TEMPLATES.find((t) => t.name === "test-scenarios")).toBeDefined();
    expect(findDocoTemplateByName("test-scenarios")?.name).toBe("test-scenarios");
  });

  it("has the expected metadata (icon, label, defaultNodeLifecycle, description)", () => {
    expect(template.icon).toBe("🧪");
    expect(template.label).toBe("Test scenarios");
    // A scenario is sketched before its steps and expected result are written,
    // so new nodes start `drafting` and the completeness/quality gates spare a
    // sketch; runs (Logs) are recorded directly as `active` facts.
    expect(template.defaultNodeLifecycle).toBe("drafting");
    expect(template.description).toMatch(/test scenario/i);
    expect(template.description).toMatch(/run|environment|evidence/i);
  });

  it("opens on the list reading (a test Doco is a list of scenarios + runs)", () => {
    expect(template.perspectives).toEqual([{ slug: "list", isDefault: true }]);
  });

  describe("node-type allowlist", () => {
    const allowlist = template.policies.find(
      (r) => r.predicate?.kind === "requires_node_type",
    )?.predicate;

    it("admits only Eval, Intent, Log, Principal, Reference", () => {
      expect(allowlist?.kind).toBe("requires_node_type");
      if (allowlist?.kind !== "requires_node_type") return;
      expect([...allowlist.node_types].sort()).toEqual([
        "eval",
        "intent",
        "log",
        "principal",
        "reference",
      ]);
    });

    it("excludes process/work and governance node types (Action, State, Decision, Rule, Idea)", () => {
      if (allowlist?.kind !== "requires_node_type") throw new Error("allowlist missing");
      for (const excluded of ["action", "state", "decision", "rule", "idea"]) {
        expect(allowlist.node_types).not.toContain(excluded as never);
      }
    });
  });

  describe("edge-type allowlist", () => {
    const allowlist = template.policies.find(
      (r) => r.predicate?.kind === "requires_edge_type",
    )?.predicate;

    it("admits the evidence/validation + association edges, barring flow and guard edges", () => {
      expect(allowlist?.kind).toBe("requires_edge_type");
      if (allowlist?.kind !== "requires_edge_type") return;
      expect(new Set(allowlist.edge_types)).toEqual(
        new Set([
          "supports",
          "attributed_to",
          "has_parent",
          "relates_to",
          "replaces",
          "derived_from",
        ]),
      );
      // `flows_to` is process sequence; `constrained_by` guards with a Rule —
      // neither belongs in a test Doco.
      expect(allowlist.edge_types).not.toContain("flows_to");
      expect(allowlist.edge_types).not.toContain("constrained_by");
    });
  });

  describe("scenario completeness floor (how_to_run)", () => {
    const floor = template.policies.find(
      (r) => r.predicate?.kind === "requires_field" && r.predicate.when_node_type?.includes("eval"),
    );

    it("requires `how_to_run` on every committed (queued/active) scenario, as a hard block", () => {
      expect(floor?.predicate?.kind).toBe("requires_field");
      if (floor?.predicate?.kind !== "requires_field") return;
      expect(floor.predicate.fields).toEqual(["how_to_run"]);
      // A drafting sketch may omit the steps; the floor fires once committed.
      expect(floor.fires_when_node_lifecycle).toEqual(["queued", "active"]);
      expect(floor.on_violation ?? "block").toBe("block");
    });

    it("seeds as a deterministic block carrying the predicate verbatim", () => {
      if (!floor) throw new Error("completeness floor missing");
      const seeded = templatePolicyToPolicyRow(floor);
      expect(seeded.kind).toBe("deterministic");
      expect(seeded.on_violation).toBe("block");
      expect(seeded.predicate.sub_kind).toBe("requires_field");
      expect(seeded.predicate.fields).toEqual(["how_to_run"]);
      expect(seeded.fires_when_node_lifecycle).toEqual(["queued", "active"]);
    });
  });

  describe("traceability gate (supports)", () => {
    const gate = template.policies.find(
      (r) => r.predicate?.kind === "requires_edge" && r.predicate.edge_type === "supports",
    );

    it("nudges every committed scenario AND run to link what it covers via `supports`, as a warn", () => {
      expect(gate?.predicate?.kind).toBe("requires_edge");
      if (gate?.predicate?.kind !== "requires_edge") return;
      // One gate covering both halves: a scenario (Eval) supports its objective/
      // requirement; a run (Log) supports the scenario it executed.
      expect([...(gate.predicate.when_node_type ?? [])].sort()).toEqual(["eval", "log"]);
      // Warn, not block: an ad-hoc smoke check or a quick capture is allowed.
      expect(gate.on_violation).toBe("warn");
      expect(gate.fires_when_node_lifecycle).toEqual(["queued", "active"]);
    });
  });

  describe("soft semantic gates (warnings, LLM-judged)", () => {
    it("warns when a node does not read as test content (membership), exempting Principals", () => {
      const gate = template.policies.find(
        (r) =>
          r.predicate?.kind === "probabilistic" && /belongs in a test Doco/i.test(r.predicate.spec),
      );
      expect(gate?.on_violation).toBe("warn");
      if (gate?.predicate?.kind !== "probabilistic") return;
      const types = gate.predicate.when_node_type ?? [];
      expect(types).toEqual(expect.arrayContaining(["eval", "log", "intent", "reference"]));
      // Principals are actors (testers / systems), not test content.
      expect(types).not.toContain("principal");
      // A soft, all-stages gate — surfaced, never blocking.
      expect(gate.fires_when_node_lifecycle).toBeUndefined();
    });

    it("judges scenario quality (one behavior, reproducible, one observable expected result)", () => {
      const gate = template.policies.find(
        (r) =>
          r.predicate?.kind === "probabilistic" &&
          r.predicate.when_node_type?.includes("eval") &&
          /single observable, checkable expected result/i.test(r.predicate.spec),
      );
      expect(gate?.on_violation).toBe("warn");
      expect(gate?.fires_when_node_lifecycle).toEqual(["queued", "active"]);
    });

    it("judges result quality (environment, outcome, evidence on failure) on runs", () => {
      const gate = template.policies.find(
        (r) =>
          r.predicate?.kind === "probabilistic" &&
          r.predicate.when_node_type?.includes("log") &&
          /browser and version/i.test(r.predicate.spec),
      );
      expect(gate?.on_violation).toBe("warn");
      if (gate?.predicate?.kind !== "probabilistic") return;
      expect(gate.predicate.spec).toMatch(/passed, failed, blocked, or skipped/i);
      expect(gate.fires_when_node_lifecycle).toEqual(["queued", "active"]);
    });
  });

  describe("guidance encodes the test-documentation best practices", () => {
    const haystack = template.policies
      .filter((r) => !r.predicate)
      .map((r) => r.policy ?? "")
      .join("\n");

    it("separates the durable scenario (Eval) from its append-only runs (Log)", () => {
      expect(haystack).toMatch(/two halves/i);
      expect(haystack).toMatch(/append-only/i);
    });
    it("records the environment on every run and sizes the matrix from real usage", () => {
      expect(haystack).toMatch(/record the environment on every run/i);
      expect(haystack).toMatch(/real user analytics/i);
    });
    it("distinguishes failed from blocked, and severity from priority", () => {
      expect(haystack).toMatch(/failed from blocked/i);
      expect(haystack).toMatch(/severity/i);
      expect(haystack).toMatch(/priority/i);
    });
    it("attaches evidence and references the external defect", () => {
      expect(haystack).toMatch(/evidence/i);
      expect(haystack).toMatch(/defect/i);
    });
    it("covers BDD Given/When/Then and session-based exploratory testing (PROOF)", () => {
      expect(haystack).toMatch(/Given \/ When \/ Then/);
      expect(haystack).toMatch(/PROOF/);
      expect(haystack).toMatch(/charter/i);
    });
    it("walks the scenario lifecycle and stays expandable to specialized tests", () => {
      expect(haystack).toMatch(/drafting/i);
      expect(haystack).toMatch(/retired/i);
      expect(haystack).toMatch(/specialized tests/i);
      expect(haystack).toMatch(/WCAG|performance|visual-regression/i);
    });
  });
});

describe("edge-type allowlists (requires_edge_type)", () => {
  // The edge analogue of the node-type allowlist: each template declares which
  // relationship edge types it permits, enforced (block) on edge creation.
  function allowlistOf(name: string): string[] | undefined {
    const t = findDocoTemplateByName(name);
    const p = t?.policies.find((r) => r.predicate?.kind === "requires_edge_type");
    return p?.predicate?.kind === "requires_edge_type" ? [...p.predicate.edge_types] : undefined;
  }

  it("org-chart allows reporting/association edges incl. relates_to and bars flows_to", () => {
    const a = allowlistOf("org-chart");
    expect(a && new Set(a)).toEqual(
      new Set([
        "has_parent",
        "attributed_to",
        "relates_to",
        "supports",
        "replaces",
        "derived_from",
      ]),
    );
    expect(a).toContain("relates_to");
    expect(a).not.toContain("flows_to");
  });

  it("process allows BPMN edge types incl. has_parent (process membership) and bars relates_to", () => {
    const a = allowlistOf("process");
    expect(a && new Set(a)).toEqual(
      new Set([
        "flows_to",
        "has_parent",
        "supports",
        "attributed_to",
        "constrained_by",
        "replaces",
        "derived_from",
      ]),
    );
    expect(a).toContain("has_parent");
    expect(a).not.toContain("relates_to");
  });

  it("seeds as a blocking deterministic policy carrying the edge_types allowlist", () => {
    const template = findDocoTemplateByName("process");
    const policy = template?.policies.find((r) => r.predicate?.kind === "requires_edge_type");
    if (!policy) throw new Error("process requires_edge_type policy missing");
    const seeded = templatePolicyToPolicyRow(policy);
    expect(seeded.kind).toBe("deterministic");
    expect(seeded.on_violation).toBe("block");
    expect(seeded.predicate.sub_kind).toBe("requires_edge_type");
    expect(seeded.predicate.edge_types).toContain("flows_to");
  });
});
