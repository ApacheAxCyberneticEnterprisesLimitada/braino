import { describe, expect, it } from "vitest";

import {
  categoryCounts,
  formatSessionDocument,
  parseBenchmarkArgs,
  parseJudgeLabel,
  selectStratifiedQuestions,
} from "../../scripts/locomo-bench-lib.mjs";

function fixtureDataset() {
  const totals = new Map([
    [1, 282],
    [2, 321],
    [3, 96],
    [4, 841],
  ]);
  const conversations = Array.from({ length: 10 }, (_, conversationIndex) => ({
    conversation: {
      speaker_a: `Speaker A${conversationIndex}`,
      speaker_b: `Speaker B${conversationIndex}`,
    },
    qa: [] as Array<{ question: string; answer: string; category: number; evidence: string[] }>,
  }));
  for (const [category, total] of totals) {
    for (let index = 0; index < total; index++) {
      conversations[index % conversations.length]?.qa.push({
        question: `category ${category} question ${index}`,
        answer: `answer ${index}`,
        category,
        evidence: [`D${conversationIndex(index)}:${index}`],
      });
    }
  }
  return conversations;
}

function conversationIndex(index: number) {
  return index % 10;
}

describe("LoCoMo pilot adapter", () => {
  it("selects a deterministic ten-percent sample stratified by category and conversation", () => {
    const dataset = fixtureDataset();
    const first = selectStratifiedQuestions(dataset, { rate: 0.1, seed: "pilot-v1" });
    const second = selectStratifiedQuestions(dataset, { rate: 0.1, seed: "pilot-v1" });

    expect(first).toEqual(second);
    expect(first).toHaveLength(154);
    expect(categoryCounts(first)).toEqual({ 1: 28, 2: 32, 3: 10, 4: 84 });
    for (const category of [1, 2, 3, 4]) {
      expect(
        new Set(
          first.filter((item) => item.category === category).map((item) => item.conversationIndex),
        ).size,
      ).toBe(10);
    }
  });

  it("preserves the session date, speaker, dialogue id, and image caption", () => {
    expect(
      formatSessionDocument(
        {
          speaker_a: "Caroline",
          speaker_b: "Melanie",
          session_0_date_time: "1:56 pm on 8 May, 2023",
          session_0: [
            { speaker: "Caroline", dia_id: "D1:1", text: "I joined the support group." },
            {
              speaker: "Melanie",
              dia_id: "D1:2",
              text: "That is wonderful.",
              blip_captions: "two friends smiling",
            },
          ],
        },
        3,
        0,
      ),
    ).toEqual({
      externalId: "conv-3:session-0",
      source: "locomo",
      locator: "locomo://conv-3/session-0",
      title: "Caroline and Melanie — 1:56 pm on 8 May, 2023",
      content:
        "Conversation between Caroline and Melanie\n" +
        "Date: 1:56 pm on 8 May, 2023\n\n" +
        "D1:1 | Caroline: I joined the support group.\n" +
        "D1:2 | Melanie: That is wonderful. [Image: two friends smiling]",
    });
  });

  it("requires an isolated benchmark database and explicit dataset-license acceptance", () => {
    const common = [
      "--dataset",
      "/tmp/locomo10.json",
      "--database-url",
      "postgres://localhost/doco_locomo_benchmark",
    ];
    expect(() => parseBenchmarkArgs(common, {})).toThrow("--accept-noncommercial-license");
    expect(
      parseBenchmarkArgs([...common, "--accept-noncommercial-license"], {
        OPEN_ROUTER_API_KEY: "test",
        VOYAGE_API_KEY: "test",
      }),
    ).toMatchObject({ sampleRate: 0.1, seed: "doco-locomo-pilot-v1", topK: 20 });
    expect(() =>
      parseBenchmarkArgs(
        [
          "--dataset",
          "/tmp/locomo10.json",
          "--database-url",
          "postgres://localhost/doco",
          "--accept-noncommercial-license",
        ],
        { OPENROUTER_API_KEY: "test", VOYAGE_API_KEY: "test" },
      ),
    ).toThrow("benchmark-specific");
  });

  it("reads the OmniMemEval judge's JSON label without accepting ambiguous prose", () => {
    expect(parseJudgeLabel('{"label":"CORRECT"}')).toBe(true);
    expect(parseJudgeLabel('```json\n{"label":"WRONG"}\n```')).toBe(false);
    expect(() => parseJudgeLabel("CORRECT and WRONG")).toThrow("judge label");
  });
});
