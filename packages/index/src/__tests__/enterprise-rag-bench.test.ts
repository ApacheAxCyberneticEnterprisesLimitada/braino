import { describe, expect, it } from "vitest";

import {
  dedupeRankedDocuments,
  parseBenchmarkArgs,
  parseBenchmarkDocument,
  retrievalSummary,
  runnableQuestions,
} from "../../scripts/enterprise-rag-bench-lib.mjs";

describe("EnterpriseRAG-Bench adapter", () => {
  it("makes graph enrichment an explicit benchmark dimension", () => {
    const common = [
      "--archive",
      "/tmp/github.zip",
      "--questions",
      "/tmp/questions.jsonl",
      "--database-url",
      "postgres://localhost/doco_enterprise_benchmark",
    ];

    expect(parseBenchmarkArgs(common, {})).toMatchObject({ graph: false });
    expect(parseBenchmarkArgs([...common, "--graph"], {})).toMatchObject({ graph: true });
  });

  it("preserves the benchmark document id and source identity", () => {
    expect(
      parseBenchmarkDocument(
        "github/serving/pulls/dsid_ae068ee4aa9640159427cd941bef0238_multipart.txt",
        "Multipart upload support\n\nThe default file limit is 10 MiB.",
      ),
    ).toEqual({
      externalId: "dsid_ae068ee4aa9640159427cd941bef0238",
      source: "github",
      locator:
        "enterpriserag://github/serving/pulls/dsid_ae068ee4aa9640159427cd941bef0238_multipart.txt",
      title: "Multipart upload support",
      content: "The default file limit is 10 MiB.",
    });
  });

  it("uses the archive source for flat slice exports", () => {
    expect(
      parseBenchmarkDocument(
        "dsid_abc123_release_notes.txt",
        "Release notes\nThe rollout starts Monday.",
        "github",
      ),
    ).toMatchObject({ externalId: "dsid_abc123", source: "github" });
  });

  it("rejects entries without a stable benchmark id", () => {
    expect(() => parseBenchmarkDocument("README.txt", "Read me", "github")).toThrow(
      "dataset document id",
    );
  });

  it("selects only questions whose complete gold set exists in the indexed corpus", () => {
    const questions = [
      { question_id: "one", question: "One?", expected_doc_ids: ["dsid_a"] },
      { question_id: "two", question: "Two?", expected_doc_ids: ["dsid_a", "dsid_b"] },
      { question_id: "none", question: "None?", expected_doc_ids: [] },
    ];
    expect(runnableQuestions(questions, new Set(["dsid_a"]))).toEqual([questions[0]]);
  });

  it("deduplicates chunks into the first-ranked occurrence of each document", () => {
    expect(
      dedupeRankedDocuments([
        { externalId: "dsid_a", text: "a1" },
        { externalId: "dsid_a", text: "a2" },
        { externalId: "dsid_b", text: "b1" },
      ]),
    ).toEqual([
      { externalId: "dsid_a", text: "a1" },
      { externalId: "dsid_b", text: "b1" },
    ]);
  });

  it("reports macro document recall, complete recall, hit rate, and reciprocal rank", () => {
    expect(
      retrievalSummary([
        { expected: ["a", "b"], retrieved: ["a", "x", "b"] },
        { expected: ["c"], retrieved: ["x", "y"] },
      ]),
    ).toEqual({
      questions: 2,
      documentRecall: 0.5,
      completeRecall: 0.5,
      hitRate: 0.5,
      mrr: 0.5,
    });
  });

  it("excludes questions without gold documents from retrieval metrics", () => {
    expect(
      retrievalSummary([
        { expected: ["a"], retrieved: ["a"] },
        { expected: [], retrieved: ["unscored"] },
      ]),
    ).toEqual({
      questions: 1,
      documentRecall: 1,
      completeRecall: 1,
      hitRate: 1,
      mrr: 1,
    });
  });
});
