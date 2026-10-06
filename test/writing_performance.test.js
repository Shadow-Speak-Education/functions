"use strict";

const assert = require("assert");
const {
  buildPerformanceScoringPayload,
  callPerformanceScoring,
  normalizeRubric,
  normalizeEvaluationLevel,
  publicTestData,
  resolveWritingPerformancePreviewContext,
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
    assert.match(
      payload.messages[0].content,
      /Do not improve style, naturalness, detail, organization, or expression/
    );
    assert.match(payload.messages[0].content, /Never deduct merely because/);
    assert.match(payload.messages[0].content, /scoreImpact false/);
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
  });

  await test("stylistic suggestions cannot be marked as score impacting", () => {
    assert.throws(
      () => validatePerformanceScore(
        scoreValue({
          suggestions: [{
            quote: "I like teaching.",
            suggestion: "I enjoy teaching others.",
            reasonJa: "より自然です。",
            scoreImpact: true,
          }],
        }),
        testData
      ),
      /減点理由として扱うことはできません/
    );
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

  await test("deduction totals must match the rubric score gap", () => {
    assert.throws(
      () => validatePerformanceScore(
        scoreValue({ deductions: scoreValue().deductions.slice(1) }),
        testData
      ),
      /減点理由の合計とAI点に矛盾/
    );
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
    assert.strictEqual(item.submission.minimalCorrectedText, "");
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
    assert.strictEqual(pending.submission.minimalCorrectedText, "");

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
      ["schools/school-1/students/student-1", { classIds: ["class-1"] }],
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

  console.log("All writing performance tests passed.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
