"use strict";

const assert = require("assert");
const {
  WritingFunctionError,
  buildCorrectionPayload,
  correctWritingHandler,
  validateCorrectWritingInput,
  validateCorrectionResult,
} = require("../writing_helpers");

function makeFetchResponse({ ok = true, status = 200, body }) {
  return {
    ok,
    status,
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
  };
}

function openAiBody(content) {
  return {
    model: "gpt-5.6-luna",
    choices: [
      {
        message: {
          content: JSON.stringify(content),
        },
      },
    ],
    usage: {
      prompt_tokens: 42,
      completion_tokens: 64,
    },
  };
}

const sampleCorrection = {
  originalText:
    "I often play soccer adter school. I used to played soccer after school.",
  correctedText:
    "I often play soccer after school. I used to play soccer after school.",
  positiveFeedbackJa: "放課後の習慣と以前の習慣を伝えようとしています。",
  corrections: [
    {
      original: "adter",
      corrected: "after",
      reasonJa: "afterのつづりを直しました。",
    },
    {
      original: "used to played",
      corrected: "used to play",
      reasonJa: "used toの後には動詞の原形を使います。",
    },
  ],
  nextTipJa: "文を書いた後に、動詞の形をもう一度確認してみましょう。",
  needsTeacherReview: false,
  reviewReasonJa: null,
};

async function test(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

(async () => {
  await test("rejects blank text before API call", () => {
    assert.throws(
      () => validateCorrectWritingInput({ text: "  \n ", mode: "simple_correction" }),
      WritingFunctionError
    );
  });

  await test("rejects invalid mode", () => {
    assert.throws(
      () => validateCorrectWritingInput({ text: "I like soccer.", mode: "score" }),
      /mode/
    );
  });

  await test("rejects too long input", () => {
    assert.throws(
      () =>
        validateCorrectWritingInput({
          text: Array.from({ length: 351 }, () => "word").join(" "),
          mode: "simple_correction",
        }),
      /350語/
    );
  });

  await test("payload uses json_schema structured output", () => {
    const payload = buildCorrectionPayload("I like soccer.");
    assert.strictEqual(payload.model, "gpt-5.6-luna");
    assert.strictEqual(payload.response_format.type, "json_schema");
    assert.strictEqual(payload.response_format.json_schema.strict, true);
  });

  await test("returns normal schema with mocked OpenAI", async () => {
    const result = await correctWritingHandler({
      data: {
        text: sampleCorrection.originalText,
        mode: "simple_correction",
      },
      apiKey: "test-key",
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body);
        assert(!options.body.includes("studentName"));
        assert.strictEqual(body.response_format.type, "json_schema");
        return makeFetchResponse({ body: openAiBody(sampleCorrection) });
      },
    });

    assert.strictEqual(result.correctedText, sampleCorrection.correctedText);
    assert.strictEqual(result.corrections.length, 2);
    assert.strictEqual(result.usage.model, "gpt-5.6-luna");
  });

  await test("does not force rewrite repeated correct sentences", async () => {
    const content = {
      originalText: "I like soccer. I like tennis.",
      correctedText: "I like soccer. I like tennis.",
      positiveFeedbackJa: "好きなものを2文で伝えられています。",
      corrections: [],
      nextTipJa: "次は理由を一文加えてみましょう。",
      needsTeacherReview: false,
      reviewReasonJa: null,
    };
    const result = await correctWritingHandler({
      data: { text: content.originalText, mode: "simple_correction" },
      apiKey: "test-key",
      fetchImpl: async () => makeFetchResponse({ body: openAiBody(content) }),
    });
    assert.deepStrictEqual(result.corrections, []);
    assert.strictEqual(result.correctedText, content.correctedText);
  });

  await test("keeps correct sentence unchanged", async () => {
    const content = {
      originalText: "I went to the park yesterday.",
      correctedText: "I went to the park yesterday.",
      positiveFeedbackJa: "過去の出来事を正しく表せています。",
      corrections: [],
      nextTipJa: "次は場所や理由を足してみましょう。",
      needsTeacherReview: false,
      reviewReasonJa: null,
    };
    const result = await correctWritingHandler({
      data: { text: content.originalText, mode: "simple_correction" },
      apiKey: "test-key",
      fetchImpl: async () => makeFetchResponse({ body: openAiBody(content) }),
    });
    assert.strictEqual(result.correctedText, content.correctedText);
  });

  await test("parses third-person singular correction", () => {
    const result = validateCorrectionResult(
      {
        originalText: "She go to school every day.",
        correctedText: "She goes to school every day.",
        positiveFeedbackJa: "毎日の習慣を伝えられています。",
        corrections: [
          {
            original: "go",
            corrected: "goes",
            reasonJa: "主語がSheなので、現在形では動詞にsをつけます。",
          },
        ],
        nextTipJa: "主語と動詞の形を確認しましょう。",
        needsTeacherReview: false,
        reviewReasonJa: null,
      },
      { model: "test", inputTokens: 1, outputTokens: 1, elapsedMs: 0 }
    );
    assert.strictEqual(result.corrections[0].corrected, "goes");
  });

  await test("parses present progressive correction", () => {
    const result = validateCorrectionResult(
      {
        originalText: "He is play soccer now.",
        correctedText: "He is playing soccer now.",
        positiveFeedbackJa: "今していることを伝えようとしています。",
        corrections: [
          {
            original: "is play",
            corrected: "is playing",
            reasonJa: "現在進行形は be動詞 + 動詞ing です。",
          },
        ],
        nextTipJa: "be動詞の後の動詞の形を確認しましょう。",
        needsTeacherReview: false,
        reviewReasonJa: null,
      },
      { model: "test", inputTokens: 1, outputTokens: 1, elapsedMs: 0 }
    );
    assert.strictEqual(result.correctedText, "He is playing soccer now.");
  });

  await test("rejects malformed JSON from OpenAI", async () => {
    await assert.rejects(
      () =>
        correctWritingHandler({
          data: { text: "I like soccer.", mode: "simple_correction" },
          apiKey: "test-key",
          fetchImpl: async () =>
            makeFetchResponse({
              body: {
                choices: [{ message: { content: "{ broken" } }],
                usage: {},
              },
            }),
        }),
      /JSON/
    );
  });

  await test("maps OpenAI failure safely", async () => {
    await assert.rejects(
      () =>
        correctWritingHandler({
          data: { text: "I like soccer.", mode: "simple_correction" },
          apiKey: "test-key",
          fetchImpl: async () =>
            makeFetchResponse({ ok: false, status: 500, body: "server error" }),
        }),
      /Writing添削API/
    );
  });

  await test("handles timeout safely", async () => {
    await assert.rejects(
      () =>
        correctWritingHandler({
          data: { text: "I like soccer.", mode: "simple_correction" },
          apiKey: "test-key",
          fetchImpl: async (_url, options) => {
            await new Promise((resolve, reject) => {
              options.signal.addEventListener("abort", () => {
                const error = new Error("aborted");
                error.name = "AbortError";
                reject(error);
              });
            });
          },
        }),
      /タイムアウト/
    );
  });

  console.log("All writing helper tests passed.");
})();
