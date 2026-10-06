"use strict";

const assert = require("assert");
const {
  WritingFunctionError,
  buildCorrectionPayload,
  buildOcrPayload,
  correctWritingHandler,
  describeEmptyOpenAiResponse,
  extractWritingTextFromImageHandler,
  validateCorrectWritingInput,
  validateOcrInput,
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
  improvedText:
    "I often play soccer after school. I used to play soccer after school, and it is still one of my favorite activities.",
  positiveFeedbackJa: "放課後の習慣と以前の習慣を伝えようとしています。",
  corrections: [
    {
      original: "adter",
      corrected: "after",
      reasonJa: "afterのつづりを直しました。",
      explanationJa: "afterのつづりを直しました。",
      type: "spelling",
    },
    {
      original: "used to played",
      corrected: "used to play",
      reasonJa: "used toの後には動詞の原形を使います。",
      explanationJa: "used toの後には動詞の原形を使います。",
      type: "grammar",
    },
  ],
  improvements: [
    {
      addedText: "and it is still one of my favorite activities",
      reasonJa: "今も好きだという一文を加えると、内容が少し具体的になります。",
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
    assert.strictEqual(payload.reasoning_effort, "low");
    assert(payload.max_completion_tokens >= 4000);
    assert(payload.response_format.json_schema.schema.required.includes("improvedText"));
    assert(payload.response_format.json_schema.schema.required.includes("improvements"));
    assert(payload.messages[0].content.includes("correctedText"));
    assert(payload.messages[0].content.includes("improvedText"));
  });

  await test("ocr payload uses image input and json_schema", () => {
    const payload = buildOcrPayload({
      imageBase64: "aGVsbG8=",
      mimeType: "image/jpeg",
    });
    assert.strictEqual(payload.response_format.type, "json_schema");
    assert.strictEqual(payload.response_format.json_schema.strict, true);
    assert.strictEqual(payload.reasoning_effort, "low");
    assert(payload.max_completion_tokens >= 2000);
    assert(payload.messages[1].content.some((part) => part.type === "image_url"));
    const imagePart = payload.messages[1].content.find(
      (part) => part.type === "image_url"
    );
    assert.strictEqual(imagePart.image_url.detail, "high");
    assert(payload.messages[0].content.includes("character-faithful"));
    assert(payload.messages[0].content.includes("Prefer [不明]"));
    assert(payload.messages[0].content.includes("including misspellings"));
    assert(!payload.messages[0].content.includes("transcribe the best guess"));
    assert(!payload.messages[0].content.includes("read the English as naturally"));
    assert(!JSON.stringify(payload.messages[0]).includes("correctedText"));
  });

  await test("ocr rejects unsupported image type", () => {
    assert.throws(
      () => validateOcrInput({ imageBase64: "aGVsbG8=", mimeType: "image/gif" }),
      /画像形式/
    );
  });

  await test("records diagnostics when OpenAI returns no content", () => {
    const details = describeEmptyOpenAiResponse({
      id: "chatcmpl_test",
      model: "gpt-test",
      choices: [{
        finish_reason: "length",
        message: { content: "", refusal: null },
      }],
      usage: {
        prompt_tokens: 42,
        completion_tokens: 500,
        completion_tokens_details: { reasoning_tokens: 500 },
      },
    });
    assert.deepStrictEqual(details, {
      responseId: "chatcmpl_test",
      model: "gpt-test",
      finishReason: "length",
      refusal: null,
      promptTokens: 42,
      completionTokens: 500,
      reasoningTokens: 500,
    });
  });

  await test("ocr returns transcribed text with mocked OpenAI", async () => {
    let calls = 0;
    const result = await extractWritingTextFromImageHandler({
      data: {
        imageBase64: "aGVsbG8=",
        mimeType: "image/jpeg",
      },
      apiKey: "test-key",
      fetchImpl: async (_url, options) => {
        calls += 1;
        const body = JSON.parse(options.body);
        assert.strictEqual(body.response_format.type, "json_schema");
        assert(JSON.stringify(body).includes("data:image/jpeg;base64,aGVsbG8="));
        return makeFetchResponse({
          body: openAiBody({
            transcribedText: "I often plaied soccer.",
            uncertainParts: [
              {
                text: "plaied",
                reasonJa: "手書きが少し不鮮明です。",
              },
            ],
            hasUnreadableText: false,
            warningJa: null,
          }),
        });
      },
    });

    assert.strictEqual(result.transcribedText, "I often plaied soccer.");
    assert.strictEqual(result.uncertainParts.length, 1);
    assert.strictEqual(result.usage.model, "gpt-5.6-luna");
    assert.strictEqual(calls, 1);
  });

  await test("ocr preserves grammar and word-choice errors verbatim", async () => {
    const verbatimText = [
      "I'm trying to write more deeply to recognize my writing.",
      "I'm also like to make apps to improve my English skills.",
      "I hope this writing can read by AI",
    ].join("\n");

    const result = await extractWritingTextFromImageHandler({
      data: {
        imageBase64: "aGVsbG8=",
        mimeType: "image/jpeg",
      },
      apiKey: "test-key",
      fetchImpl: async (_url, options) => {
        const payload = JSON.parse(options.body);
        const instructions = payload.messages[0].content;
        assert(instructions.includes(
          "I'm also like to make apps to improve my English skills."
        ));
        assert(instructions.includes("I hope this writing can read by AI"));
        assert(instructions.includes("never output \"I also like to use apps\""));
        assert(instructions.includes("never output \"can be read by AI\""));
        assert(instructions.includes("or \"can lead by AI\""));

        return makeFetchResponse({
          body: openAiBody({
            transcribedText: verbatimText,
            uncertainParts: [],
            hasUnreadableText: false,
            warningJa: null,
          }),
        });
      },
    });

    assert.strictEqual(result.transcribedText, verbatimText);
    assert(result.transcribedText.includes(
      "I'm also like to make apps to improve my English skills."
    ));
    assert(result.transcribedText.includes("I hope this writing can read by AI"));
    assert(!result.transcribedText.includes("I also like to use apps"));
    assert(!result.transcribedText.includes("can be read by AI"));
    assert(!result.transcribedText.includes("can lead by AI"));
  });

  await test("returns normal schema with mocked OpenAI", async () => {
    let calls = 0;
    const result = await correctWritingHandler({
      data: {
        text: sampleCorrection.originalText,
        mode: "simple_correction",
      },
      apiKey: "test-key",
      fetchImpl: async (_url, options) => {
        calls += 1;
        const body = JSON.parse(options.body);
        assert(!options.body.includes("studentName"));
        assert.strictEqual(body.response_format.type, "json_schema");
        return makeFetchResponse({ body: openAiBody(sampleCorrection) });
      },
    });

    assert.strictEqual(result.correctedText, sampleCorrection.correctedText);
    assert.strictEqual(result.improvedText, sampleCorrection.improvedText);
    assert.strictEqual(result.corrections.length, 2);
    assert.strictEqual(result.corrections[0].type, "spelling");
    assert.strictEqual(result.improvements.length, 1);
    assert.strictEqual(result.usage.model, "gpt-5.6-luna");
    assert.strictEqual(calls, 1);
  });

  await test("separates correctedText from improvedText", async () => {
    const content = {
      originalText: "I am child. I plaied soccer.",
      correctedText: "I was a child. I played soccer.",
      improvedText:
        "When I was a child, I played soccer with my friends and made good memories.",
      positiveFeedbackJa: "子どものころの経験を伝えようとしています。",
      corrections: [
        {
          original: "am child",
          corrected: "was a child",
          reasonJa: "過去のことなのでwasを使い、childの前にaを付けます。",
          explanationJa: "過去のことなのでwasを使い、childの前にaを付けます。",
          type: "grammar",
        },
        {
          original: "plaied",
          corrected: "played",
          reasonJa: "playedのスペルを修正しました。",
          explanationJa: "playedのスペルを修正しました。",
          type: "spelling",
        },
      ],
      improvements: [
        {
          addedText: "with my friends and made good memories",
          reasonJa: "友達との思い出を一文に入れると、内容がより具体的になります。",
        },
      ],
      nextTipJa: "過去の話では動詞の過去形を確認しましょう。",
      needsTeacherReview: false,
      reviewReasonJa: null,
    };
    const result = await correctWritingHandler({
      data: { text: content.originalText, mode: "simple_correction" },
      apiKey: "test-key",
      fetchImpl: async () => makeFetchResponse({ body: openAiBody(content) }),
    });
    assert.strictEqual(result.correctedText, "I was a child. I played soccer.");
    assert(result.improvedText.includes("with my friends"));
    assert(!result.correctedText.includes("with my friends"));
  });

  await test("does not force rewrite repeated correct sentences", async () => {
    const content = {
      originalText: "I like soccer. I like tennis.",
      correctedText: "I like soccer. I like tennis.",
      improvedText: "I like soccer. I like tennis because they are fun.",
      positiveFeedbackJa: "好きなものを2文で伝えられています。",
      corrections: [],
      improvements: [
        {
          addedText: "because they are fun",
          reasonJa: "理由を加えると内容が少し詳しくなります。",
        },
      ],
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
      improvedText: "I went to the park yesterday and enjoyed walking there.",
      positiveFeedbackJa: "過去の出来事を正しく表せています。",
      corrections: [],
      improvements: [
        {
          addedText: "and enjoyed walking there",
          reasonJa: "何を楽しんだかを足すと具体的になります。",
        },
      ],
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
        improvedText: "She goes to school every day and studies hard.",
        positiveFeedbackJa: "毎日の習慣を伝えられています。",
        corrections: [
          {
            original: "go",
            corrected: "goes",
            reasonJa: "主語がSheなので、現在形では動詞にsをつけます。",
            explanationJa: "主語がSheなので、現在形では動詞にsをつけます。",
            type: "grammar",
          },
        ],
        improvements: [
          {
            addedText: "and studies hard",
            reasonJa: "関連する行動を加えると文が自然につながります。",
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
        improvedText: "He is playing soccer now and looks very focused.",
        positiveFeedbackJa: "今していることを伝えようとしています。",
        corrections: [
          {
            original: "is play",
            corrected: "is playing",
            reasonJa: "現在進行形は be動詞 + 動詞ing です。",
            explanationJa: "現在進行形は be動詞 + 動詞ing です。",
            type: "grammar",
          },
        ],
        improvements: [
          {
            addedText: "and looks very focused",
            reasonJa: "様子を加えると内容が少し詳しくなります。",
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

  await test("supports old response without improved fields", () => {
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
    assert.strictEqual(result.improvedText, result.correctedText);
    assert.deepStrictEqual(result.improvements, []);
    assert.strictEqual(result.corrections[0].type, "expression");
  });

  await test("keeps ambiguous text conservative and reviewable", () => {
    const result = validateCorrectionResult(
      {
        originalText: "photo take want writing",
        correctedText: "photo take want writing",
        improvedText: "photo take want writing",
        positiveFeedbackJa: "伝えたい内容を書こうとしています。",
        corrections: [],
        improvements: [],
        nextTipJa: "意味が伝わるように、主語と動詞を入れてみましょう。",
        needsTeacherReview: true,
        reviewReasonJa: "語順と意味が不明瞭なため、先生の確認がおすすめです。",
      },
      { model: "test", inputTokens: 1, outputTokens: 1, elapsedMs: 0 }
    );
    assert.strictEqual(result.needsTeacherReview, true);
    assert(result.reviewReasonJa.includes("不明瞭"));
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
