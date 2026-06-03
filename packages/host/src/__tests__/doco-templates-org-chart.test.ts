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
    // captured seat/team/appointment lands `active`. Sketch with an
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

  describe("node-type allowlist", () => {
    const allowlist = template.policies.find(
      (r) => r.predicate?.kind === "requires_node_type",
    )?.predicate;

    it("includes only the five org node types", () => {
      expect(allowlist?.kind).toBe("requires_node_type");
      if (allowlist?.kind !== "requires_node_type") return;
      expect([...allowlist.node_types].sort()).toEqual(
        ["decision", "intent", "principal", "reference", "rule"].sort(),
      );
    });

    it("does not list Doco policy metadata as org-chart nodes", () => {
      if (allowlist?.kind !== "requires_node_type") throw new Error("allowlist missing");
      expect(allowlist.node_types).not.toContain("guidance_policy" as never);
      expect(allowlist.node_types).not.toContain("node_authoring_policy" as never);
    });

    it("excludes Action, State, Eval, Log, and Idea (those describe activity, not org structure)", () => {
      if (allowlist?.kind !== "requires_node_type") throw new Error("allowlist missing");
      for (const t of ["action", "state", "eval", "log", "idea"]) {
        expect(allowlist.node_types).not.toContain(t as never);
      }
    });

    it("describes only the org-chart node types as org-chart nodes", () => {
      const policy = template.policies.find(
        (r) => r.predicate?.kind === "requires_node_type",
      )?.policy;
      expect(policy).toMatch(
        /Only Principal, Intent, Decision, Reference, and Rule belong as org-chart nodes/i,
      );
      expect(policy).not.toMatch(/guidance_policy|node_authoring_policy|polic/i);
      expect(policy).toMatch(/Evals/i);
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

    it("every active Principal either has a reporting edge or explains why it is top-of-chain", () => {
      expect(rule).toBeDefined();
      expect(rule?.predicate?.kind).toBe("probabilistic");
      expect(rule?.policy).toMatch(/either has a `has_parent` reporting edge/);
      expect(rule?.policy).toMatch(/top-of-chain/);
    });

    it("fires on `queued` and `active` — a drafting seat can be captured before its manager exists, but a ready (queued) or in-force seat must wire its reporting line", () => {
      // queued = "committed, ready, not yet in force" (a signed hire, an
      // announced appointment). A ready seat is as complete as an active one,
      // so the reporting-completeness nudge applies to both. Only `drafting`
      // — the still-being-sketched stage — is exempt.
      expect(rule?.fires_when_node_lifecycle).toEqual(["queued", "active"]);
    });

    it("warns rather than blocks while the author is shaping the org", () => {
      expect(rule?.on_violation).toBe("warn");
    });
  });

  describe("team Intents declare members through edges", () => {
    const rule = template.policies.find(
      (r) => r.predicate?.kind === "descriptive" && r.predicate.when_node_type?.includes("intent"),
    );

    it("exists", () => {
      expect(rule).toBeDefined();
      expect(rule?.predicate?.kind).toBe("descriptive");
      if (rule?.predicate?.kind !== "descriptive") return;
      expect(rule.predicate.spec).toMatch(/attributed_to/);
    });

    it("fires on `queued` and `active` — a team can be drafted before its roster is filled, but a ready or in-force team should name its members", () => {
      expect(rule?.fires_when_node_lifecycle).toEqual(["queued", "active"]);
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

    it("reporting chains must not be circular (engine can't check yet)", () => {
      expect(summaries.some((s) => /reporting/i.test(s) && /circular|cycle/i.test(s))).toBe(true);
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

    it("team membership changes are captured as Decisions / edges", () => {
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

    it("dotted-line guidance points at `dotted_reports_to` edges", () => {
      expect(summaries.some((s) => /`dotted_reports_to`/.test(s))).toBe(true);
    });

    it("one occupant / many seats is modeled with `same_occupant_as`", () => {
      expect(summaries.some((s) => /`same_occupant_as`/.test(s) && /seat/i.test(s))).toBe(true);
    });
  });

  describe("reporting relationships are first-class edges", () => {
    const guidance = template.policies.filter((r) => !r.predicate);
    const summaries = guidance.map((r) => r.policy);

    it("frames reporting lines as edges you retire-and-re-add", () => {
      const g = summaries.find((s) => /reporting line/i.test(s) && /first-class/i.test(s));
      expect(g).toBeDefined();
      expect(g).toMatch(/retiring the old edge and adding the new one/i);
    });

    it("frames `dotted_reports_to` as edges", () => {
      const g = summaries.find((s) => /`dotted_reports_to`/.test(s));
      expect(g).toBeDefined();
      expect(g).toMatch(/edges/i);
    });

    it("frames `same_occupant_as` as edges", () => {
      const g = summaries.find((s) => /`same_occupant_as`/.test(s));
      expect(g).toBeDefined();
      expect(g).toMatch(/edges/i);
    });

    it("does not describe relationship keys in Principal data", () => {
      expect(summaries.join("\n")).not.toMatch(/Principal's `data`|pointer field/i);
    });
  });

  describe("queued — staging a committed-but-not-yet-effective org change", () => {
    const guidance = template.policies.filter((r) => !r.predicate);
    const summaries = guidance.map((r) => r.policy);

    it("has dedicated guidance for the `queued` stage (signed hire / future appointment / announced reorg / successor)", () => {
      const g = summaries.find(
        (s) =>
          /`queued`/.test(s) &&
          /(future-effective|effective date|not (yet )?in force|pending|signed hire|successor|announced)/i.test(
            s,
          ),
      );
      expect(g).toBeDefined();
    });

    it("contrasts `queued` (ready, awaiting activation) with `drafting` (still being sketched)", () => {
      const g = summaries.find((s) => /`queued`/.test(s) && /`drafting`/.test(s));
      expect(g).toBeDefined();
      // Points the reader at the activation step on the effective date.
      expect(g).toMatch(/activat/i);
    });
  });

  describe("agent authoring — current changeset ops (post `assert`→`activate` + `queue`)", () => {
    const guidance = template.policies.filter((r) => !r.predicate);
    const summaries = guidance.map((r) => r.policy);

    it("points agents at the authoring contract and changesets endpoint", () => {
      expect(
        summaries.some((s) => /authoring-contract\.json/i.test(s) && /changesets\.json/i.test(s)),
      ).toBe(true);
    });

    it("tells agents to use relate_many for sibling reporting edges that must hold together", () => {
      expect(summaries.some((s) => /relate_many/i.test(s))).toBe(true);
    });

    it("names the current `queue` and `activate` lifecycle ops, not the retired `assert`", () => {
      const g = summaries.find(
        (s) => /relate_many/i.test(s) || /authoring-contract\.json/i.test(s),
      );
      expect(g).toBeDefined();
      expect(summaries.join("\n")).toMatch(/`queue`|`activate`/);
    });
  });

  describe("no stale lifecycle vocabulary (asserted→active rename)", () => {
    // Build a haystack of every human + machine-facing string the template
    // ships, so a lingering `assert`/`asserted`/`asserting` anywhere fails.
    const haystack = template.policies
      .map((r) => {
        const spec =
          r.predicate?.kind === "probabilistic" || r.predicate?.kind === "descriptive"
            ? r.predicate.spec
            : "";
        return `${r.policy}\n${spec}`;
      })
      .join("\n");

    it("never uses the retired `assert` lifecycle verb (use `activate`)", () => {
      expect(haystack).not.toMatch(/\bassert(?:ed|ing|s)?\b/i);
    });

    it("the circular-reporting guidance says to resolve a cycle before *activating*", () => {
      const summaries = template.policies.filter((r) => !r.predicate).map((r) => r.policy);
      expect(summaries.some((s) => /circular|cycle/i.test(s) && /activating/i.test(s))).toBe(true);
    });
  });
});
