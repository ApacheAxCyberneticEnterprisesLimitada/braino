import { describe, expect, it } from "vitest";
import { DEFAULT_DOCO_TEMPLATES, findDocoTemplateByName } from "../doco-templates.js";

describe("org-chart template", () => {
  const template = findDocoTemplateByName("org-chart");
  if (!template) throw new Error("org-chart template not registered");

  it("is registered in DEFAULT_DOCO_TEMPLATES under its plain handle", () => {
    expect(DEFAULT_DOCO_TEMPLATES.find((t) => t.name === "org-chart")).toBeDefined();
  });

  it("is reachable via its bare handle and is NOT reachable via the legacy hashtag-prefixed form", () => {
    const bare = findDocoTemplateByName("org-chart");
    const hashtagged = findDocoTemplateByName("#org-chart");
    expect(bare).toBeDefined();
    expect(bare?.name).toBe("org-chart");
    expect(hashtagged).toBeUndefined();
  });

  it("has the expected metadata (icon, label, defaultNodeLifecycle)", () => {
    expect(template.icon).toBe("🏢");
    expect(template.label).toBe("org-chart");
    // Definitional/live-on-creation Doco: no drafting default, so a
    // captured seat/team/appointment lands `asserted`. Sketch with an
    // explicit `lifecycle: "drafting"`.
    expect(template.defaultNodeLifecycle).toBeUndefined();
    expect(template.description).toMatch(/person/i);
    expect(template.description).toMatch(/AI agent/i);
    // The seat model adds a third occupant state — vacant seats appear
    // on the chart (HR best practice / W3C org:Post-style continuity).
    expect(template.description).toMatch(/vacant/i);
  });

  it("ships with the org-tree perspective attached as default", () => {
    expect(template.perspectives).toEqual([{ slug: "org-tree", isDefault: true }]);
  });

  it("does NOT set the policy-only `allowedNodeTypes` field — that's reserved for `global`", () => {
    expect(template.allowedNodeTypes).toBeUndefined();
  });

  describe("entity-type allowlist", () => {
    const allowlist = template.policies.find(
      (r) => r.predicate?.kind === "requires_entity_type",
    )?.predicate;

    it("includes the five org node types plus the Doco's own policy types", () => {
      expect(allowlist?.kind).toBe("requires_entity_type");
      if (allowlist?.kind !== "requires_entity_type") return;
      expect([...allowlist.entity_types].sort()).toEqual(
        [
          "decision",
          "guidance_policy",
          "intent",
          "node_authoring_policy",
          "principal",
          "reference",
          "rule",
        ].sort(),
      );
    });

    it("admits in-Doco policy authoring (guidance_policy / node_authoring_policy)", () => {
      if (allowlist?.kind !== "requires_entity_type") throw new Error("allowlist missing");
      expect(allowlist.entity_types).toContain("guidance_policy");
      expect(allowlist.entity_types).toContain("node_authoring_policy");
    });

    it("excludes Action, State, Eval, Log, and Idea (those describe activity, not org structure)", () => {
      if (allowlist?.kind !== "requires_entity_type") throw new Error("allowlist missing");
      for (const t of ["action", "state", "eval", "log", "idea"]) {
        expect(allowlist.entity_types).not.toContain(t);
      }
    });
  });

  describe("the unique constraint — person-vs-agent declaration", () => {
    // Post-slim-down: there is no `type` field on Principal anymore;
    // person-vs-agent lives in body_md prose, enforced by a
    // probabilistic policy that reads the prose.
    const rule = template.policies.find(
      (r) =>
        r.predicate?.kind === "probabilistic" &&
        r.predicate.when_node_type?.includes("principal") &&
        /person/i.test(r.predicate.spec) &&
        /agent/i.test(r.predicate.spec) &&
        /body_md/i.test(r.predicate.spec),
    );

    it("exists — every Principal MUST declare person vs agent in body_md", () => {
      expect(rule).toBeDefined();
      expect(rule?.predicate?.kind).toBe("probabilistic");
    });

    it("admits a third state — a vacant/open seat — so budgeted roles appear on the chart", () => {
      expect(rule?.predicate?.kind).toBe("probabilistic");
      if (rule?.predicate?.kind !== "probabilistic") return;
      expect(rule.predicate.spec).toMatch(/vacant|open/i);
      expect(rule.policy).toMatch(/vacant/i);
    });

    it("fires on every Principal regardless of lifecycle (no fires_when_node_lifecycle gate)", () => {
      // A drafting member still needs the kind declared — that's the
      // first thing the org-tree perspective renders.
      expect(rule?.fires_when_node_lifecycle).toBeUndefined();
    });

    it("blocks by default — person-vs-agent is identity-grade for an org chart", () => {
      // No on_violation override means the framework default applies
      // (block). The guidance rules below explicitly say flipping
      // person-vs-agent requires retiring + re-creating the Principal,
      // so a missing declaration at write time should hard-fail.
      expect(rule?.on_violation).toBeUndefined();
    });
  });

  describe("hierarchy — reports_to", () => {
    const deterministicRule = template.policies.find(
      (r) =>
        r.predicate?.kind === "requires_edge" &&
        r.predicate.edge_type === "reports_to" &&
        r.predicate.when_node_type?.includes("principal"),
    );
    const rule = template.policies.find(
      (r) =>
        r.predicate?.kind === "probabilistic" &&
        r.predicate.when_node_type?.includes("principal") &&
        /reports_to/i.test(r.predicate.spec) &&
        /top-of-chain/i.test(r.policy),
    );

    it("does not use a deterministic `requires_edge` rule that would warn legitimate roots", () => {
      expect(deterministicRule).toBeUndefined();
    });

    it("every active Principal either has `reports_to` or explains why it is top-of-chain", () => {
      expect(rule).toBeDefined();
      expect(rule?.predicate?.kind).toBe("probabilistic");
      expect(rule?.policy).toMatch(/either declares `reports_to`/);
      expect(rule?.policy).toMatch(/top-of-chain/);
    });

    it("fires only on `asserted` — drafting members can be captured before their manager exists", () => {
      expect(rule?.fires_when_node_lifecycle).toEqual(["asserted"]);
    });

    it("warns rather than blocks while the author is shaping the org", () => {
      expect(rule?.on_violation).toBe("warn");
    });
  });

  describe("team Intents declare members in `actors`", () => {
    const rule = template.policies.find(
      (r) =>
        r.predicate?.kind === "requires_field" &&
        r.predicate.fields.includes("actors") &&
        r.predicate.when_node_type?.includes("intent"),
    );

    it("exists", () => {
      expect(rule).toBeDefined();
      expect(rule?.predicate?.kind).toBe("requires_field");
    });

    it("fires only on `asserted` — a team can be drafted before its roster is filled", () => {
      // Without the gate, the default `drafting` lifecycle would make
      // this requires_field block the moment a unit is created — the
      // opposite of letting authors sketch incomplete structure.
      expect(rule?.fires_when_node_lifecycle).toEqual(["asserted"]);
    });
  });

  describe("probabilistic style gates", () => {
    const specs = template.policies
      .map((r) => (r.predicate?.kind === "probabilistic" ? r.predicate.spec : null))
      .filter((s): s is string => s !== null);
    const summaries = template.policies.map((r) => r.policy);
    const haystack = [...specs, ...summaries].join("\n");

    it("does not impose a slug-like style gate on Principal names", () => {
      const nameStyleGate = template.policies.find(
        (r) =>
          r.predicate?.kind === "probabilistic" &&
          r.predicate.when_node_type?.includes("principal") &&
          r.predicate.spec.includes("`name`") &&
          /slug|role, title|serial|placeholder/i.test(r.predicate.spec),
      );
      expect(nameStyleGate).toBeUndefined();
      expect(haystack).not.toMatch(/Principal(?:'s)? `name`[^\n]*slug/i);
    });

    it("top-of-chain Principal explains the missing reports_to in body_md", () => {
      const topGate = template.policies.find(
        (r) =>
          r.predicate?.kind === "probabilistic" &&
          r.predicate.when_node_type?.includes("principal") &&
          /top-of-chain/i.test(r.policy) &&
          /no manager above/i.test(r.predicate.spec),
      );
      expect(topGate).toBeDefined();
      expect(topGate?.on_violation).toBe("warn");
    });

    it("references the founder/board/root-agent shapes that legitimately have no manager", () => {
      expect(/founder|board|root agent|external authority/i.test(haystack)).toBe(true);
    });
  });

  describe("guidance rules", () => {
    const guidance = template.policies.filter((r) => !r.predicate);
    const summaries = guidance.map((r) => r.policy);

    it("`reports_to` chains must not be circular (engine can't check yet)", () => {
      expect(summaries.some((s) => /reports_to/i.test(s) && /circular|cycle/i.test(s))).toBe(true);
    });

    it("AI-agent Principals declare their human owner (mirrors User.owner_id)", () => {
      expect(
        summaries.some(
          (s) => /AI(-|\s)?agent/i.test(s) && /(owner|delegated_by|operates under|human)/i.test(s),
        ),
      ).toBe(true);
    });

    it("reorgs / hires / departures captured as Decisions", () => {
      expect(summaries.some((s) => /reorg/i.test(s) && /Decision/i.test(s))).toBe(true);
    });

    it("Intents model teams / departments / units", () => {
      expect(summaries.some((s) => /team/i.test(s) && /Intent/i.test(s))).toBe(true);
    });

    it("person-vs-agent is identity — flipping it in place is forbidden, retire and recreate instead", () => {
      // After the slim-down the kind declaration lives in body_md
      // prose; the guidance still asks contributors to retire the old
      // Principal and create a new one when the kind changes.
      expect(
        summaries.some(
          (s) =>
            /retire/i.test(s) &&
            /(person|agent|kind|occupant)/i.test(s) &&
            /(new|create|recreate)/i.test(s),
        ),
      ).toBe(true);
    });

    it("person vs agent is about who fills the seat, not about who signed in", () => {
      expect(summaries.some((s) => /seat/i.test(s) && /User|sign(ed)? in/i.test(s))).toBe(true);
    });

    it("vacant/budgeted seats are modeled as Principals (seat continuity, not omitted)", () => {
      expect(
        summaries.some((s) => /vacant/i.test(s) && /seat/i.test(s) && /budgeted/i.test(s)),
      ).toBe(true);
    });

    it("seats persist across routine turnover; only a person<->agent nature flip retires + recreates", () => {
      expect(
        summaries.some((s) => /seat/i.test(s) && /turnover|persist/i.test(s) && /retire/i.test(s)),
      ).toBe(true);
    });

    it("team membership changes are captured as Decisions / a versioned `member_of` edge", () => {
      expect(
        summaries.some((s) => /member(ship|_of)/i.test(s) && /Decision|versioned|edge/i.test(s)),
      ).toBe(true);
    });

    it("secondary / dotted-line / matrix reporting layers on top of the single `reports_to` line", () => {
      expect(
        summaries.some(
          (s) => /dotted|matrix|secondary/i.test(s) && /reports_to|reporting/i.test(s),
        ),
      ).toBe(true);
    });

    it("dotted-line guidance points at the structured `dotted_reports_to` field", () => {
      expect(summaries.some((s) => /`dotted_reports_to`/.test(s))).toBe(true);
    });

    it("one occupant / many seats is modeled with `same_occupant_as`", () => {
      expect(summaries.some((s) => /`same_occupant_as`/.test(s) && /seat/i.test(s))).toBe(true);
    });
  });

  // After the node-table collapse dropped the five promoted node→node FK
  // columns (#694), the project settled on one uniform model: a node→node
  // relationship is an id-shaped POINTER FIELD in `data` — re-pointed by
  // editing the field in place (it versions with the node) — unless it has
  // been deliberately promoted to a first-class authored edge, which you
  // reroute by retiring the old edge and adding a new one. `reports_to`,
  // `dotted_reports_to`, and `same_occupant_as` are pointer fields (none is
  // in MANAGED_RELATION_EDGE_TYPES; the org-tree reads them straight from
  // `data`), so the guidance must frame them as edited-in-place, NOT as
  // authored edges you retire-and-re-add. This mirrors business-processes'
  // own "promoted pointer fields, not first-class edges" guidance.
  describe("relationship pointer fields are re-pointed in place (post-FK-drop cohesion)", () => {
    const guidance = template.policies.filter((r) => !r.predicate);
    const summaries = guidance.map((r) => r.policy);

    it("frames `reports_to` as an in-place pointer field, not an edge you retire-and-re-add", () => {
      const g = summaries.find((s) => /`reports_to`/.test(s) && /in place/i.test(s));
      expect(g).toBeDefined();
      expect(g).toMatch(/versions with the node|in place/i);
      expect(g).not.toMatch(/retire the old `reports_to` edge/i);
    });

    it("frames `dotted_reports_to` as an in-place pointer field, not an edge you retire to change", () => {
      const g = summaries.find((s) => /`dotted_reports_to`/.test(s));
      expect(g).toBeDefined();
      expect(g).toMatch(/in place/i);
      expect(g).not.toMatch(/retire (the|its) [^.]*\bedge\b/i);
    });

    it("frames `same_occupant_as` as an in-place pointer field, not an edge you retire to change", () => {
      const g = summaries.find((s) => /`same_occupant_as`/.test(s));
      expect(g).toBeDefined();
      expect(g).toMatch(/in place/i);
      expect(g).not.toMatch(/retire the edge/i);
    });

    it("never tells authors to retire-and-re-add an edge for these promoted pointer fields", () => {
      for (const s of summaries) {
        if (/`reports_to`|`dotted_reports_to`|`same_occupant_as`/.test(s)) {
          expect(s).not.toMatch(/retire (the|its) (old )?[^.]*\bedge\b.*add (the )?new/i);
        }
      }
    });

    it("ties the in-place model back to the dropped inter-node foreign keys", () => {
      expect(summaries.join("\n")).toMatch(/foreign key/i);
    });
  });
});
