import { describe, expect, it } from "vitest";
import { parseEntityContent, serializeEntityContent } from "../files.js";

describe("parseEntityContent", () => {
  it("parses YAML files into a data record", () => {
    const yaml = `id: tag_01KR441EA37E3M5V0ZV6ZRB97D
node_type: tag
name: tag_adr
`;
    const parsed = parseEntityContent(yaml, "yaml");
    expect(parsed.format).toBe("yaml");
    expect(parsed.body).toBe("");
    expect(parsed.data.id).toBe("tag_01KR441EA37E3M5V0ZV6ZRB97D");
    expect(parsed.data.node_type).toBe("tag");
  });

  it("parses Markdown frontmatter + body", () => {
    const md = `---
id: decision_01KR441EAMKYKCEBSEYHGJ8M3Z
node_type: decision
summary: Optimization priority order
---

# ADR-001 — Optimization priority order
`;
    const parsed = parseEntityContent(md, "md");
    expect(parsed.format).toBe("md");
    expect(parsed.data.id).toBe("decision_01KR441EAMKYKCEBSEYHGJ8M3Z");
    expect(parsed.data.summary).toBe("Optimization priority order");
    expect(parsed.body).toContain("# ADR-001 — Optimization priority order");
  });

  it("parses JSON files generically", () => {
    const json = `{"id": "rule_01KR441EA37E3M5V0ZV6ZRB97D", "node_type": "rule", "result": "pass"}`;
    const parsed = parseEntityContent(json, "json");
    expect(parsed.data.result).toBe("pass");
  });
});

describe("serializeEntityContent", () => {
  it("round-trips a Markdown entity", () => {
    const input = {
      data: { id: "decision_01KR441EAMKYKCEBSEYHGJ8M3Z", node_type: "decision" as const },
      body: "# Body content\n",
      format: "md" as const,
    };
    const text = serializeEntityContent(input);
    expect(text).toContain("---\n");
    expect(text).toContain("id: decision_01KR441EAMKYKCEBSEYHGJ8M3Z");
    expect(text).toContain("# Body content");
    const reparsed = parseEntityContent(text, "md");
    expect(reparsed.data.id).toBe(input.data.id);
    expect(reparsed.body.trim()).toBe(input.body.trim());
  });

  it("round-trips a YAML entity", () => {
    const input = {
      data: { id: "tag_01KR441EA37E3M5V0ZV6ZRB97D", node_type: "tag" as const, name: "tag_adr" },
      body: "",
      format: "yaml" as const,
    };
    const text = serializeEntityContent(input);
    const reparsed = parseEntityContent(text, "yaml");
    expect(reparsed.data).toEqual(input.data);
  });
});
