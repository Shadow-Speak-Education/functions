"use strict";

const assert = require("assert");
const {
  buildPerformanceScoringPayload,
  calculateSpeakingChallengeMetrics,
  callPerformanceScoring,
  normalizeRubric,
  normalizeEvaluationLevel,
  publicTestData,
  resolveWritingPerformancePreviewContext,
  saveWritingPerformanceSpeakingChallenge,
  studentBelongsToClass,
  submitWritingPerformanceTest,
  validatePerformanceScore,
} = require("../writing_performance");

const rubric = normalizeRubric({
  content: 4,
  organization: 4,
  accuracy: 4,
  vocabulary: 4,
  requirements: 4,
});
const testData = {
  title: "Lesson 4",
  prompt: "将来やりたいことを理由とともに書きなさい。",
  instructions: "理由を2つ含めてください。",
  minWords: 70,
  maxWords: 100,
  rubric,
  aiTeacherInstruction: "内容を重視してください。",
  totalPoints: 20,
  evaluationLevel: "standard",
};

function scoreValue(overrides = {}) {
  return {
    content: { score: 4, commentJa: "課題に答えています。" },
    organization: { score: 3, commentJa: "流れがあります。" },
    accuracy: { score: 2, commentJa: "誤りがあります。" },
    vocabulary: { score: 3, commentJa: "適切です。" },
    requirements: { score: 4, commentJa: "条件を満たしています。" },
    overallFeedbackJa: "よく書けています。",
    minimalCorrectedText: "I want to be a teacher.",
    corrections: [
      {
        original: "want be",
        corrected: "want to be",
        type: "grammar",
        reasonJa: "toが必要です。",
      },
    ],
    practiceCorrections: [
      {
        type: "replace",
        original: "want be",
        corrected: "want to be",
        reasonJa: "toが必要です。",
        contextBefore: "I",
        contextAfter: "a teacher",
      },
    ],
    rewriteSegments: [],
    deductions: [
      {
        criterion: "organization",
        quote: "I have two reasons.",
        errorPart: "",
        correction: "",
        reasonJa: "理由のつながりが一部不明確です。",
        pointsLost: 1,
      },
      {
        criterion: "accuracy",
        quote: "I want be teacher.",
        errorPart: "want be",
        correction: "want to be",
        reasonJa: "toが必要です。",
        pointsLost: 2,
      },
      {
        criterion: "vocabulary",
        quote: "I do teacher.",
        errorPart: "do teacher",
        correction: "become a teacher",
        reasonJa: "語法に明確な誤りがあります。",
        pointsLost: 1,
      },
    ],
    strengths: [
      { criterion: "content", textJa: "課題に沿って将来の希望を書けています。" },
    ],
    suggestions: [
      {
        quote: "I like teaching.",
        suggestion: "I enjoy teaching others.",
        reasonJa: "より具体的に伝えられます。",
        scoreImpact: false,
      },
    ],
    needsTeacherReview: false,
    reviewReasonJa: null,
    ...overrides,
  };
}

class FakeSnap {
  constructor(value) {
    this.value = value;
    this.exists = value != null;
  }
  data() { return this.value; }
}

class FakeRef {
  constructor(db, path) {
    this.db = db;
    this.path = path;
  }
  collection(name) { return new FakeCollection(this.db, `${this.path}/${name}`); }
  async get() { return new FakeSnap(this.db.docs.get(this.path)); }
  async update(value) {
    this.db.docs.set(this.path, { ...(this.db.docs.get(this.path) || {}), ...value });
  }
}

class FakeCollection {
  constructor(db, path) { this.db = db; this.path = path; }
  doc(id) { return new FakeRef(this.db, `${this.path}/${id}`); }
}

class FakeDb {
  constructor(entries) { this.docs = new Map(entries); }
  collection(name) { return new FakeCollection(this, name); }
  async runTransaction(callback) {
    return callback({
      get: (ref) => ref.get(),
      create: (ref, value) => {
        if (this.docs.has(ref.path)) throw new Error("already exists");
        this.docs.set(ref.path, value);
      },
      update: (ref, value) => {
        if (!this.docs.has(ref.path)) throw new Error("missing");
        this.docs.set(ref.path, { ...this.docs.get(ref.path), ...value });
      },
    });
  }
}

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
  await test("rubric total and zero-point criterion are deterministic", () => {
    const custom = normalizeRubric({
      content: 8,
      organization: 4,
      accuracy: 4,
      vocabulary: 4,
      requirements: 0,
    });
    assert.strictEqual(
      Object.values(custom).reduce((sum, item) => sum + item.maxScore, 0),
      20
    );
    const result = validatePerformanceScore(
      scoreValue({
        requirements: { score: 0, commentJa: "採点対象外です。" },
        deductions: [
          {
            criterion: "content",
            quote: "I want to be a teacher.",
            errorPart: "",
            correction: "",
            reasonJa: "必要な内容が不足しています。",
            pointsLost: 4,
          },
          ...scoreValue().deductions,
        ],
      }),
      { ...testData, rubric: custom }
    );
    assert.strictEqual(result.aiScores.requirements.score, 0);
    assert.strictEqual(result.aiTotalScore, 12);
    assert.strictEqual(result.minimalCorrectedText, "I want to be a teacher.");
  });

  await test("score above criterion maximum is rejected", () => {
    assert.throws(
      () => validatePerformanceScore(
        scoreValue({ accuracy: { score: 5, commentJa: "invalid" } }),
        testData
      ),
      /配点範囲外/
    );
    assert.throws(
      () => validatePerformanceScore(
        scoreValue({ accuracy: { score: "2", commentJa: "invalid" } }),
        testData
      ),
      /配点範囲外/
    );
  });

  await test("missing required rubric score is rejected", () => {
    const missing = scoreValue();
    delete missing.accuracy;
    assert.throws(
      () => validatePerformanceScore(missing, testData),
      /配点範囲外/
    );
  });

  await test("minimal correction text is required and bounded", () => {
    assert.throws(
      () => validatePerformanceScore(
        scoreValue({ minimalCorrectedText: "" }),
        testData
      ),
      /最小訂正文/
    );
    assert.throws(
      () => validatePerformanceScore(
        scoreValue({ minimalCorrectedText: "a".repeat(5001) }),
        testData
      ),
      /最小訂正文/
    );
    assert.throws(
      () => validatePerformanceScore(
        scoreValue({ minimalCorrectedText: { text: "not a string" } }),
        testData
      ),
      /最小訂正文/
    );
  });

  await test("prompt carries word limits, rubric, and teacher instruction", () => {
    const payload = buildPerformanceScoringPayload({
      test: testData,
      submittedText: "I want to be a teacher.",
      wordCount: 6,
    });
    const body = JSON.parse(payload.messages[1].content);
    assert.strictEqual(payload.reasoning_effort, "low");
    assert.strictEqual(body.wordCount, 6);
    assert.strictEqual(body.minWords, 70);
    assert.strictEqual(body.maxWords, 100);
    assert.strictEqual(body.teacherInstruction, "内容を重視してください。");
    assert.strictEqual(body.rubric.content.maxScore, 4);
    assert.strictEqual(body.evaluationLevel, "standard");
    assert(
      payload.response_format.json_schema.schema.required.includes(
        "minimalCorrectedText"
      )
    );
    assert(
      payload.response_format.json_schema.schema.required.includes(
        "deductions"
      )
    );
    assert(
      payload.response_format.json_schema.schema.required.includes(
        "corrections"
      )
    );
    assert(
      payload.response_format.json_schema.schema.required.includes(
        "practiceCorrections"
      )
    );
    assert(
      payload.response_format.json_schema.schema.required.includes(
        "rewriteSegments"
      )
    );
    assert.strictEqual(
      payload.response_format.json_schema.schema.properties.deductions.maxItems,
      5
    );
    assert.strictEqual(
      payload.response_format.json_schema.schema.properties.strengths.maxItems,
      3
    );
    assert.strictEqual(
      payload.response_format.json_schema.schema.properties.suggestions.maxItems,
      2
    );
    assert.match(
      payload.messages[0].content,
      /Do not improve style, naturalness, detail, organization, or expression/
    );
    assert.match(payload.messages[0].content, /Never deduct merely because/);
    assert.match(payload.messages[0].content, /scoreImpact false/);
    assert.match(payload.messages[0].content, /red correction display/);
    assert.match(
      payload.messages[0].content,
      /add its deductions\.pointsLost values/
    );
  });

  await test("advanced evaluation level reaches the scoring payload", () => {
    const payload = buildPerformanceScoringPayload({
      test: { ...testData, evaluationLevel: "advanced" },
      submittedText: "I want to be a teacher.",
      wordCount: 6,
    });
    const body = JSON.parse(payload.messages[1].content);
    assert.strictEqual(body.evaluationLevel, "advanced");
    assert.match(payload.messages[0].content, /advanced expects higher accuracy/);
  });

  await test("structured corrections contain only grammar or spelling", () => {
    const result = validatePerformanceScore(scoreValue({
      corrections: [
        {
          original: "want be",
          corrected: "want to be",
          type: "grammar",
          reasonJa: "toが必要です。",
        },
        {
          original: "techer",
          corrected: "teacher",
          type: "spelling",
          reasonJa: "スペルを直します。",
        },
      ],
    }), testData);
    assert.deepStrictEqual(
      result.corrections.map((item) => item.type),
      ["grammar", "spelling"]
    );
    const softened = validatePerformanceScore(scoreValue({
        corrections: [{
          original: "good",
          corrected: "excellent",
          type: "style",
          reasonJa: "より自然です。",
        }],
      }), testData);
    assert(softened.corrections.every((item) => item.type !== "style"));
    assert(softened.validationWarnings.includes("correction_invalid_item"));
  });

  await test("practice corrections support replace, insert, and delete", () => {
    const result = validatePerformanceScore(scoreValue({
      practiceCorrections: [
        {
          type: "replace",
          original: "wants",
          corrected: "want",
          reasonJa: "主語がIなのでwantです。",
          contextBefore: "I",
          contextAfter: "to meet her.",
        },
        {
          type: "insert",
          original: "",
          corrected: "to",
          reasonJa: "wentの後にはtoが必要です。",
          contextBefore: "I went",
          contextAfter: "school.",
        },
        {
          type: "delete",
          original: "am",
          corrected: "",
          reasonJa: "wentの前にamは不要です。",
          contextBefore: "I",
          contextAfter: "went to school.",
        },
      ],
    }), testData);
    assert.deepStrictEqual(
      result.practiceCorrections.map((item) => item.type),
      ["replace", "insert", "delete"]
    );
  });

  await test("rewrite is review-only and interactive targets are capped at five", () => {
    const practiceCorrections = Array.from({ length: 5 }, (_, index) => ({
      type: "replace",
      original: `bad${index}`,
      corrected: `good${index}`,
      reasonJa: "基本的な誤りを直します。",
      contextBefore: "",
      contextAfter: "",
    }));
    const result = validatePerformanceScore(scoreValue({
      practiceCorrections,
      rewriteSegments: [],
    }), testData);
    assert.strictEqual(result.practiceCorrections.length, 5);
    const capped = validatePerformanceScore(scoreValue({
        practiceCorrections,
        rewriteSegments: [{
          original: "longdistan she there.",
          corrected: "She lives far away.",
          reasonJa: "文の形をまとめて確認します。",
        }],
      }), testData);
    assert.strictEqual(capped.practiceCorrections.length, 5);
    assert.strictEqual(capped.rewriteSegments.length, 0);
    assert(capped.validationWarnings.includes("relearning_targets_truncated"));
  });

  await test("changed text without targets falls back to corrected review", () => {
    const result = validatePerformanceScore(scoreValue({
      minimalCorrectedText: "She lives far away.",
      corrections: [],
      practiceCorrections: [],
      rewriteSegments: [],
    }), testData, "longdistan she there.");
    assert.strictEqual(result.practiceCorrections.length, 0);
    assert.deepStrictEqual(result.rewriteSegments, [{
      original: "longdistan she there.",
      corrected: "She lives far away.",
      reasonJa: "修正版の全文を確認しましょう。",
    }]);
    assert.strictEqual(result.fullTextReviewRequired, true);
  });

  await test("legacy score falls back only to local accuracy deductions", () => {
    const legacy = scoreValue();
    delete legacy.corrections;
    const result = validatePerformanceScore(legacy, testData);
    assert.deepStrictEqual(result.corrections.map((item) => item.corrected), [
      "want to be",
    ]);
  });

  await test("scoring returns the minimal correction in the same API call", async () => {
    let callCount = 0;
    const result = await callPerformanceScoring({
      test: testData,
      submittedText: "i want go to school.",
      wordCount: 5,
      apiKey: "test-key",
      fetchImpl: async () => {
        callCount += 1;
        return {
          ok: true,
          text: async () => JSON.stringify({
            model: "test-model",
            choices: [{
              message: {
                content: JSON.stringify(scoreValue({
                  minimalCorrectedText: "I want to go to school.",
                })),
              },
            }],
          }),
        };
      },
    });
    assert.strictEqual(callCount, 1);
    assert.strictEqual(result.minimalCorrectedText, "I want to go to school.");
    assert.strictEqual(result.deductions.length, 3);
    assert.strictEqual(result.suggestions[0].scoreImpact, false);
    assert.strictEqual(result.deductionMismatch, false);
  });

  await test("unparseable AI response remains a hard failure", async () => {
    await assert.rejects(
      () => callPerformanceScoring({
        test: testData,
        submittedText: "I want to be a teacher.",
        wordCount: 6,
        apiKey: "test-key",
        fetchImpl: async () => ({
          ok: true,
          text: async () => "not-json",
        }),
      }),
      /AI採点APIの応答形式が不正/
    );
  });

  await test("invalid stylistic suggestions are discarded without failing scoring", () => {
    const result = validatePerformanceScore(
        scoreValue({
          suggestions: [{
            quote: "I like teaching.",
            suggestion: "I enjoy teaching others.",
            reasonJa: "より自然です。",
            scoreImpact: true,
          }],
        }),
        testData
    );
    assert.deepStrictEqual(result.suggestions, []);
    assert(result.validationWarnings.includes("suggestion_invalid_item"));
  });

  await test("a fully correct response needs no fabricated deduction", () => {
    const fullScore = {
      content: { score: 4, commentJa: "課題に答えています。" },
      organization: { score: 4, commentJa: "流れが明確です。" },
      accuracy: { score: 4, commentJa: "文法は正確です。" },
      vocabulary: { score: 4, commentJa: "語彙は適切です。" },
      requirements: { score: 4, commentJa: "条件を満たしています。" },
      overallFeedbackJa: "課題に沿って正確に書けています。",
      minimalCorrectedText: "I want to be a teacher because I enjoy helping students.",
      deductions: [],
      strengths: [
        { criterion: "content", textJa: "理由を含めて課題に答えています。" },
        { criterion: "accuracy", textJa: "文法的に正確な英文です。" },
      ],
      suggestions: [{
        quote: "I enjoy helping students.",
        suggestion: "I find it rewarding to help students.",
        reasonJa: "より発展的な表現にできます。",
        scoreImpact: false,
      }],
      needsTeacherReview: false,
      reviewReasonJa: null,
    };
    const result = validatePerformanceScore(fullScore, testData);
    assert.strictEqual(result.aiTotalScore, 20);
    assert.deepStrictEqual(result.deductions, []);
    assert.strictEqual(result.suggestions[0].scoreImpact, false);
  });

  await test("requirements deductions explain missing word or grammar conditions", () => {
    const result = validatePerformanceScore(
      scoreValue({
        requirements: { score: 2, commentJa: "指定条件が不足しています。" },
        deductions: [
          ...scoreValue().deductions,
          {
            criterion: "requirements",
            quote: "提出文全体",
            errorPart: "",
            correction: "",
            reasonJa: "指定語数と指定文法の条件を満たしていません。",
            pointsLost: 2,
          },
        ],
      }),
      testData
    );
    const requirement = result.deductions.find(
      (item) => item.criterion === "requirements"
    );
    assert.strictEqual(requirement.pointsLost, 2);
    assert.strictEqual(requirement.correction, "");
  });

  await test("deduction total mismatch is a soft warning and preserves score data", () => {
    const input = scoreValue({ deductions: scoreValue().deductions.slice(1) });
    const result = validatePerformanceScore(input, testData);
    assert.strictEqual(result.deductionMismatch, true);
    assert.strictEqual(result.aiTotalScore, 16);
    assert.deepStrictEqual(result.aiScores.organization, {
      score: 3,
      maxScore: 4,
      commentJa: "流れがあります。",
    });
    assert.strictEqual(result.minimalCorrectedText, "I want to be a teacher.");
    assert.strictEqual(result.practiceCorrections.length, 1);
    assert.deepStrictEqual(result.rewriteSegments, []);
    assert.deepStrictEqual(result.deductions, input.deductions);
  });

  await test("individual deduction amount mismatch is preserved without changing scores", () => {
    const input = scoreValue({
      deductions: scoreValue().deductions.map((item) =>
        item.criterion === "organization"
          ? { ...item, pointsLost: 2 }
          : item
      ),
    });
    const result = validatePerformanceScore(input, testData);
    assert.strictEqual(result.deductionMismatch, true);
    assert.strictEqual(result.aiScores.organization.score, 3);
    assert.strictEqual(result.aiTotalScore, 16);
    assert.strictEqual(result.deductions[0].pointsLost, 2);
  });

  await test("more than five deductions are truncated without changing rubric scores", () => {
    const deductions = Array.from({ length: 8 }, (_, index) => ({
      criterion: index % 2 === 0 ? "accuracy" : "vocabulary",
      quote: `example ${index}`,
      errorPart: `bad ${index}`,
      correction: `good ${index}`,
      reasonJa: `採点理由${index + 1}です。`,
      pointsLost: 1,
    }));
    const result = validatePerformanceScore(
      scoreValue({ deductions }),
      testData
    );
    assert.strictEqual(result.aiTotalScore, 16);
    assert.strictEqual(result.aiScores.accuracy.score, 2);
    assert.strictEqual(result.deductions.length, 5);
    assert(result.validationWarnings.includes("deductions_truncated"));
  });

  await test("one invalid practice correction is discarded and four remain", () => {
    const practiceCorrections = Array.from({ length: 5 }, (_, index) => ({
      type: index === 2 ? "unknown" : "replace",
      original: `bad${index}`,
      corrected: `good${index}`,
      reasonJa: "基本的な誤りを直します。",
      contextBefore: "",
      contextAfter: "",
    }));
    const result = validatePerformanceScore(
      scoreValue({ practiceCorrections, rewriteSegments: [] }),
      testData
    );
    assert.strictEqual(result.practiceCorrections.length, 4);
    assert(result.validationWarnings.includes("practice_correction_invalid_item"));
  });

  await test("all invalid practice corrections use the full-text review fallback", () => {
    const result = validatePerformanceScore(
      scoreValue({
        minimalCorrectedText: "I want to be a teacher.",
        corrections: [],
        practiceCorrections: [{
          type: "replace",
          original: "",
          corrected: "",
          reasonJa: "invalid",
          contextBefore: "",
          contextAfter: "",
        }],
        rewriteSegments: [],
      }),
      testData,
      "I want be a teacher."
    );
    assert.deepStrictEqual(result.practiceCorrections, []);
    assert.strictEqual(result.rewriteSegments.length, 1);
    assert.strictEqual(result.fullTextReviewRequired, true);
    assert(result.validationWarnings.includes("practice_correction_invalid_item"));
  });

  await test("invalid rewrite segments are discarded while valid segments remain", () => {
    const result = validatePerformanceScore(
      scoreValue({
        practiceCorrections: [],
        rewriteSegments: [
          {
            original: "I want be a teacher.",
            corrected: "I want to be a teacher.",
            reasonJa: "toを補います。",
          },
          {
            original: "",
            corrected: "invalid",
            reasonJa: "invalid",
          },
        ],
      }),
      testData,
      "I want be a teacher."
    );
    assert.strictEqual(result.rewriteSegments.length, 1);
    assert.strictEqual(result.rewriteSegments[0].corrected, "I want to be a teacher.");
    assert(result.validationWarnings.includes("rewrite_segment_invalid_item"));
  });

  await test("strength and suggestion overflow is safely truncated", () => {
    const strengths = Array.from({ length: 5 }, (_, index) => ({
      criterion: "content",
      textJa: `よかった点${index + 1}です。`,
    }));
    const suggestions = Array.from({ length: 4 }, (_, index) => ({
      quote: `quote ${index}`,
      suggestion: `suggestion ${index}`,
      reasonJa: `改善提案${index + 1}です。`,
      scoreImpact: false,
    }));
    const result = validatePerformanceScore(
      scoreValue({ strengths, suggestions }),
      testData
    );
    assert.strictEqual(result.strengths.length, 3);
    assert.strictEqual(result.suggestions.length, 2);
    assert(result.validationWarnings.includes("strengths_truncated"));
    assert(result.validationWarnings.includes("suggestions_truncated"));
  });

  await test("evaluation level defaults safely and rejects unknown values", () => {
    assert.strictEqual(normalizeEvaluationLevel(), "standard");
    assert.strictEqual(normalizeEvaluationLevel("basic"), "basic");
    assert.strictEqual(normalizeEvaluationLevel("advanced"), "advanced");
    assert.throws(() => normalizeEvaluationLevel("expert"), /評価レベル/);
  });

  await test("class membership never accepts an unrelated class", () => {
    assert(studentBelongsToClass({ classIds: ["class-a"] }, "class-a"));
    assert(!studentBelongsToClass({ classIds: ["class-b"] }, "class-a"));
  });

  await test("student response distinguishes AI reference and teacher final scores", () => {
    const item = publicTestData(
      { id: "test-1", data: () => testData },
      new FakeSnap({
        submittedText: "I want to be a teacher.",
        wordCount: 6,
        scoringStatus: "completed",
        aiScores: scoreValue(),
        aiTotalScore: 16,
        aiFeedback: "一次評価です。",
        minimalCorrectedText: "I want to be a teacher.",
        deductions: scoreValue().deductions,
        strengths: scoreValue().strengths,
        suggestions: scoreValue().suggestions,
        teacherScores: {
          content: { score: 4, maxScore: 4 },
          accuracy: { score: 3, maxScore: 4 },
          vocabulary: { score: 3, maxScore: 4 },
          organization: { score: 4, maxScore: 4 },
          requirements: { score: 4, maxScore: 4 },
        },
        teacherTotalScore: 18,
        teacherComment: "確認しました。",
      })
    );
    assert.strictEqual(item.evaluationLevel, "standard");
    assert.strictEqual(item.submission.aiTotalScore, null);
    assert.strictEqual(item.submission.teacherTotalScore, 18);
    assert.strictEqual(item.submission.teacherReviewed, true);
    assert.strictEqual(item.submission.teacherComment, "確認しました。");
    assert.strictEqual(
      item.submission.minimalCorrectedText,
      "I want to be a teacher."
    );
    assert.strictEqual(item.submission.deductions.length, 0);
  });

  await test("student response reads a separate teacher evaluation without mutating the submission", () => {
    const item = publicTestData(
      { id: "test-independent-evaluation", data: () => testData },
      new FakeSnap({
        submittedText: "I write English.",
        wordCount: 3,
        scoringStatus: "failed",
      }),
      new FakeSnap({
        finalScore: 6,
        evaluationMethod: "manual",
        teacherComment: "別の方法で確認しました。",
      }),
    );
    assert.strictEqual(item.submitted, true);
    assert.strictEqual(item.submission.teacherReviewed, true);
    assert.strictEqual(item.submission.teacherTotalScore, 6);
    assert.strictEqual(item.submission.evaluationMethod, "manual");
    assert.strictEqual(item.submission.teacherComment, "別の方法で確認しました。");
  });

  await test("student response hides every evaluation when display is disabled", () => {
    const item = publicTestData(
      {
        id: "test-hidden",
        data: () => ({ ...testData, showEvaluationToStudents: false }),
      },
      new FakeSnap({
        scoringStatus: "completed",
        aiScores: scoreValue(),
        aiTotalScore: 16,
        aiFeedback: "一次評価です。",
        minimalCorrectedText: "I want to be a teacher.",
        deductions: scoreValue().deductions,
        strengths: scoreValue().strengths,
        suggestions: scoreValue().suggestions,
        teacherScores: { content: { score: 4, maxScore: 4 } },
        teacherTotalScore: 18,
        teacherComment: "確認しました。",
      })
    );
    assert.strictEqual(item.showEvaluationToStudents, false);
    assert.strictEqual(item.submission.aiTotalScore, null);
    assert.strictEqual(item.submission.teacherTotalScore, null);
    assert.strictEqual(item.submission.aiFeedback, "");
    assert.strictEqual(
      item.submission.minimalCorrectedText,
      "I want to be a teacher."
    );
    assert.deepStrictEqual(item.submission.deductions, []);
    assert.strictEqual(item.submission.teacherComment, "");
    assert.strictEqual(item.submission.teacherReviewed, true);
  });

  await test("student response waits for final when provisional display is disabled", () => {
    const pending = publicTestData(
      {
        id: "test-final-only",
        data: () => ({
          ...testData,
          showEvaluationToStudents: true,
          showProvisionalEvaluationToStudents: false,
        }),
      },
      new FakeSnap({
        scoringStatus: "completed",
        aiScores: scoreValue(),
        aiTotalScore: 16,
        aiFeedback: "一次評価です。",
        minimalCorrectedText: "I want to be a teacher.",
        deductions: scoreValue().deductions,
        strengths: scoreValue().strengths,
        suggestions: scoreValue().suggestions,
      })
    );
    assert.strictEqual(pending.submission.aiTotalScore, null);
    assert.strictEqual(pending.submission.teacherTotalScore, null);
    assert.strictEqual(pending.submission.teacherReviewed, false);
    assert.strictEqual(
      pending.submission.minimalCorrectedText,
      "I want to be a teacher."
    );

    const confirmed = publicTestData(
      {
        id: "test-final-only",
        data: () => ({
          ...testData,
          showEvaluationToStudents: true,
          showProvisionalEvaluationToStudents: false,
        }),
      },
      new FakeSnap({
        scoringStatus: "completed",
        aiScores: scoreValue(),
        aiTotalScore: 16,
        minimalCorrectedText: "I want to be a teacher.",
        deductions: scoreValue().deductions,
        strengths: scoreValue().strengths,
        suggestions: scoreValue().suggestions,
        teacherScores: { content: { score: 4, maxScore: 4 } },
        teacherTotalScore: 18,
        teacherComment: "確認しました。",
      })
    );
    assert.strictEqual(confirmed.submission.aiTotalScore, null);
    assert.strictEqual(confirmed.submission.teacherTotalScore, 18);
    assert.strictEqual(confirmed.submission.teacherReviewed, true);
    assert.strictEqual(
      confirmed.submission.minimalCorrectedText,
      "I want to be a teacher."
    );
    assert.strictEqual(confirmed.submission.deductions.length, 0);
  });

  await test("legacy tests show provisional evaluation until teacher confirmation", () => {
    const item = publicTestData(
      { id: "legacy", data: () => testData },
      new FakeSnap({
        scoringStatus: "completed",
        aiScores: scoreValue(),
        aiTotalScore: 16,
        aiFeedback: "一次評価です。",
        minimalCorrectedText: "I want to be a teacher.",
        deductions: scoreValue().deductions,
        strengths: scoreValue().strengths,
        suggestions: scoreValue().suggestions,
      })
    );
    assert.strictEqual(item.showEvaluationToStudents, true);
    assert.strictEqual(item.showProvisionalEvaluationToStudents, true);
    assert.strictEqual(item.submission.aiTotalScore, 16);
    assert.strictEqual(item.submission.aiFeedback, "一次評価です。");
    assert.strictEqual(
      item.submission.minimalCorrectedText,
      "I want to be a teacher."
    );
    assert.strictEqual(item.submission.deductions.length, 3);
  });

  await test("legacy saved results without detail arrays remain readable", () => {
    const item = publicTestData(
      { id: "legacy-without-details", data: () => testData },
      new FakeSnap({
        submittedText: "I want to be a teacher.",
        wordCount: 6,
        scoringStatus: "completed",
        aiScores: scoreValue(),
        aiTotalScore: 16,
        aiFeedback: "一次評価です。",
      })
    );
    assert.strictEqual(item.submission.aiTotalScore, 16);
    assert.deepStrictEqual(item.submission.deductions, []);
    assert.deepStrictEqual(item.submission.strengths, []);
    assert.deepStrictEqual(item.submission.suggestions, []);
  });

  await test("teacher preview is limited to the class embedded in its signed token", () => {
    assert.deepStrictEqual(
      resolveWritingPerformancePreviewContext({
        token: {
          role: "teacher_preview",
          schoolId: "school-1",
          classId: "class-1",
        },
        data: { classId: "class-1" },
      }),
      { schoolId: "school-1", classId: "class-1" }
    );
    assert.throws(
      () => resolveWritingPerformancePreviewContext({
        token: {
          role: "teacher_preview",
          schoolId: "school-1",
          classId: "class-1",
        },
        data: { classId: "class-2" },
      }),
      (error) => error.code === "permission-denied"
    );
    assert.throws(
      () => resolveWritingPerformancePreviewContext({
        token: { role: "student", schoolId: "school-1", classId: "class-1" },
        data: { classId: "class-1" },
      }),
      (error) => error.code === "permission-denied"
    );
  });

  await test("below-minimum submission completes when deduction totals mismatch", async () => {
    const performanceTest = {
      ...testData,
      minWords: 40,
      maxWords: null,
      showEvaluationToStudents: true,
      showProvisionalEvaluationToStudents: true,
      isActive: true,
    };
    const submissionPath =
      "schools/school-1/classes/class-1/writingPerformanceTests/test-1/submissions/student-1";
    const db = new FakeDb([
      ["studentSessions/auth-1", {
        active: true,
        role: "student",
        schoolId: "school-1",
        studentInternalUid: "student-1",
        expiresAt: { toMillis: () => Date.now() + 60000 },
      }],
      ["schools/school-1", { schoolCode: "SCH-1" }],
      ["schools/school-1/classes/class-1", { name: "1A" }],
      ["schools/school-1/classes/class-1/students/student-1", { active: true }],
      ["schools/school-1/students/student-1", {
        classIds: ["class-1"],
        password: "legacy-test-password",
      }],
      ["schools/school-1/classes/class-1/writingPerformanceTests/test-1",
        performanceTest],
    ]);
    const submittedText =
      "I study English every day because I want to talk with people from other countries and learn about their cultures in the future at school.";
    const mismatchedScore = scoreValue({
      requirements: { score: 2, commentJa: "指定語数に達していません。" },
      minimalCorrectedText: submittedText,
      rewriteSegments: [{
        original: "their cultures",
        corrected: "their cultures",
        reasonJa: "内容を声に出して確認します。",
      }],
      // More than five explanatory deductions and mismatched totals must not
      // invalidate otherwise sound rubric scores or relearning content.
      deductions: Array.from({ length: 8 }, (_, index) => ({
        criterion: index % 2 === 0 ? "accuracy" : "vocabulary",
        quote: `example ${index}`,
        errorPart: `bad ${index}`,
        correction: `good ${index}`,
        reasonJa: `採点理由${index + 1}です。`,
        pointsLost: 1,
      })),
    });
    let callCount = 0;
    let requestData;
    const result = await submitWritingPerformanceTest({
      db,
      admin: {},
      authUid: "auth-1",
      data: {
        classId: "class-1",
        testId: "test-1",
        submittedText,
      },
      apiKey: "test-key",
      fetchImpl: async (_url, options) => {
        callCount += 1;
        requestData = JSON.parse(options.body);
        return {
          ok: true,
          text: async () => JSON.stringify({
            model: "test-model",
            choices: [{ message: { content: JSON.stringify(mismatchedScore) } }],
          }),
        };
      },
    });

    assert.strictEqual(callCount, 1);
    const promptData = JSON.parse(requestData.messages[1].content);
    assert.strictEqual(promptData.wordCount, 25);
    assert.strictEqual(promptData.minWords, 40);
    assert.strictEqual(result.scoringStatus, "completed");
    assert.strictEqual(result.wordCount, 25);
    assert.strictEqual(result.aiTotalScore, 14);
    assert.strictEqual(result.aiScores.requirements.score, 2);
    assert.strictEqual(result.minimalCorrectedText, submittedText);
    assert.strictEqual(result.practiceCorrections.length, 1);
    assert.strictEqual(result.rewriteSegments.length, 1);
    assert.strictEqual(result.deductions.length, 5);

    const stored = db.docs.get(submissionPath);
    assert.strictEqual(stored.scoringStatus, "completed");
    assert.strictEqual(stored.aiTotalScore, 14);
    assert.strictEqual(stored.deductionMismatch, true);
    assert(stored.validationWarnings.includes("deductions_truncated"));
    assert.strictEqual(stored.deductions.length, 5);
    assert.strictEqual(stored.minimalCorrectedText, submittedText);
    assert.strictEqual(stored.practiceCorrections.length, 1);
    assert.strictEqual(stored.rewriteSegments.length, 1);

    const publicItem = publicTestData(
      { id: "test-1", data: () => performanceTest },
      new FakeSnap(stored),
      null
    );
    assert.strictEqual(publicItem.submission.scoringStatus, "completed");
    assert.strictEqual(publicItem.submission.aiTotalScore, 14);
    assert.strictEqual(publicItem.submission.aiScores.requirements.score, 2);
    assert.strictEqual(publicItem.submission.minimalCorrectedText, submittedText);
    assert.strictEqual(publicItem.submission.practiceCorrections.length, 1);
    assert.strictEqual(publicItem.submission.rewriteSegments.length, 1);
  });

  await test("submission remains saved when AI scoring fails", async () => {
    const db = new FakeDb([
      ["studentSessions/auth-1", {
        active: true,
        role: "student",
        schoolId: "school-1",
        studentInternalUid: "student-1",
        expiresAt: { toMillis: () => Date.now() + 60000 },
      }],
      ["schools/school-1", { schoolCode: "SCH-1" }],
      ["schools/school-1/classes/class-1", { name: "1A" }],
      ["schools/school-1/classes/class-1/students/student-1", { active: true }],
      ["schools/school-1/students/student-1", {
        classIds: ["class-1"],
        password: "legacy-test-password",
      }],
      ["schools/school-1/classes/class-1/writingPerformanceTests/test-1", {
        ...testData,
        isActive: true,
      }],
    ]);
    const result = await submitWritingPerformanceTest({
      db,
      admin: {},
      authUid: "auth-1",
      data: {
        classId: "class-1",
        testId: "test-1",
        submittedText: "I want be teacher in future.",
      },
      apiKey: "test-key",
      fetchImpl: async () => { throw new Error("network down"); },
    });
    const path = "schools/school-1/classes/class-1/writingPerformanceTests/test-1/submissions/student-1";
    assert.strictEqual(result.scoringStatus, "failed");
    assert.strictEqual(db.docs.get(path).status, "submitted");
    assert.strictEqual(db.docs.get(path).scoringStatus, "failed");
    await assert.rejects(
      () => submitWritingPerformanceTest({
        db,
        admin: {},
        authUid: "auth-1",
        data: { classId: "class-1", testId: "test-1", submittedText: "again" },
        apiKey: "test-key",
        fetchImpl: async () => { throw new Error("should not run"); },
      }),
      /提出済み/
    );
  });

  await test("speaking challenge metrics ignore case and punctuation", () => {
    const metrics = calculateSpeakingChallengeMetrics({
      referenceScript: "I like English, very much!",
      recognizedText: "i like english very much",
      durationMs: 10000,
    });
    assert.deepStrictEqual(metrics, {
      accuracy: 100,
      wpm: 30,
      durationMs: 10000,
    });
  });

  await test("speaking challenge metrics ignore apostrophe differences", () => {
    const metrics = calculateSpeakingChallengeMetrics({
      referenceScript: "I don't know.",
      recognizedText: "i dont know",
      durationMs: 6000,
    });
    assert.strictEqual(metrics.accuracy, 100);
  });

  await test("speaking challenge completes after one reading and keeps one best attempt", async () => {
    const submissionPath = "schools/school-1/classes/class-1/writingPerformanceTests/test-1/submissions/student-1";
    const db = new FakeDb([
      ["studentSessions/auth-1", {
        active: true,
        role: "student",
        schoolId: "school-1",
        studentInternalUid: "student-1",
        expiresAt: { toMillis: () => Date.now() + 60000 },
      }],
      ["schools/school-1", { schoolCode: "SCH-1" }],
      ["schools/school-1/classes/class-1", { name: "1A" }],
      ["schools/school-1/classes/class-1/students/student-1", { active: true }],
      ["schools/school-1/students/student-1", {
        classIds: ["class-1"],
        password: "legacy-test-password",
      }],
      ["schools/school-1/classes/class-1/writingPerformanceTests/test-1", {
        ...testData,
        isActive: true,
      }],
      [submissionPath, {
        submittedText: "I want be a teacher.",
        minimalCorrectedText: "I want to be a teacher.",
      }],
    ]);
    await assert.rejects(
      () => saveWritingPerformanceSpeakingChallenge({
        db,
        authUid: "auth-1",
        data: {
          classId: "class-1",
          testId: "test-1",
          sourceType: "writingPerformance",
          referenceScript: "I want be a teacher.",
          recognizedText: "I want be a teacher",
          durationMs: 5000,
        },
      }),
      /練習する英文/
    );
    const first = await saveWritingPerformanceSpeakingChallenge({
      db,
      authUid: "auth-1",
      data: {
        classId: "class-1",
        testId: "test-1",
        sourceType: "writingPerformance",
        referenceScript: "I want to be a teacher.",
        recognizedText: "I want be a teacher",
        durationMs: 5000,
      },
    });
    assert.strictEqual(first.attemptCount, 1);
    assert.strictEqual(first.completed, true);
    assert.strictEqual(first.relearningCompleted, true);
    assert.strictEqual(first.best.accuracy, first.accuracy);
    const second = await saveWritingPerformanceSpeakingChallenge({
      db,
      authUid: "auth-1",
      data: {
        classId: "class-1",
        testId: "test-1",
        sourceType: "writingPerformance",
        referenceScript: "I want to be a teacher.",
        recognizedText: "I want to be a teacher",
        durationMs: 6000,
      },
    });
    assert.strictEqual(second.attemptCount, 2);
    assert.strictEqual(second.accuracy, 100);
    assert.strictEqual(
      db.docs.get(submissionPath).speakingChallenge.latest.recognizedText,
      "I want to be a teacher"
    );
    assert.strictEqual(
      db.docs.get(submissionPath).speakingChallenge.best.recognizedText,
      "I want to be a teacher"
    );
    assert.strictEqual(db.docs.get(submissionPath).speakingChallenge.schemaVersion, 2);
  });

  await test("a lower attempt never overwrites best and equal accuracy uses WPM", async () => {
    const submissionPath = "schools/school-1/classes/class-1/writingPerformanceTests/test-1/submissions/student-1";
    const db = new FakeDb([
      ["studentSessions/auth-1", {
        active: true,
        role: "student",
        schoolId: "school-1",
        studentInternalUid: "student-1",
        expiresAt: { toMillis: () => Date.now() + 60000 },
      }],
      ["schools/school-1", { schoolCode: "SCH-1" }],
      ["schools/school-1/classes/class-1", { name: "1A" }],
      ["schools/school-1/classes/class-1/students/student-1", { active: true }],
      ["schools/school-1/students/student-1", {
        classIds: ["class-1"],
        password: "legacy-test-password",
      }],
      ["schools/school-1/classes/class-1/writingPerformanceTests/test-1", {
        ...testData,
        isActive: true,
      }],
      [submissionPath, {
        submittedText: "I want to be a teacher.",
        minimalCorrectedText: "I want to be a teacher.",
      }],
    ]);
    const save = (recognizedText, durationMs) =>
      saveWritingPerformanceSpeakingChallenge({
        db,
        authUid: "auth-1",
        data: {
          classId: "class-1",
          testId: "test-1",
          sourceType: "writingPerformance",
          referenceScript: "I want to be a teacher.",
          recognizedText,
          durationMs,
          accuracy: 1000,
          wpm: 1000,
        },
      });

    await save("I want to be a teacher", 12000);
    await save("I want teacher", 3000);
    let stored = db.docs.get(submissionPath).speakingChallenge;
    assert.strictEqual(stored.best.accuracy, 100);
    assert.strictEqual(stored.best.durationMs, 12000);
    assert.strictEqual(stored.latest.accuracy < stored.best.accuracy, true);

    await save("I want to be a teacher", 6000);
    stored = db.docs.get(submissionPath).speakingChallenge;
    assert.strictEqual(stored.best.accuracy, 100);
    assert.strictEqual(stored.best.durationMs, 6000);
    assert.strictEqual(stored.best.wpm > 30, true);
    assert.strictEqual(stored.attemptCount, 3);
  });

  console.log("All writing performance tests passed.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
