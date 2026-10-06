"use strict";

const { FieldValue } = require("firebase-admin/firestore");
const {
  WRITING_MODEL,
  WritingFunctionError,
  countWritingWords,
  extractJsonObjectText,
  extractMessageContent,
  normalizeWritingText,
} = require("./writing_helpers");
const { WritingAccessError, cleanId, resolveWritingSession } = require("./writing_access");

const RUBRIC_KEYS = [
  "content",
  "accuracy",
  "vocabulary",
  "organization",
  "requirements",
];
const RUBRIC_LABELS = {
  content: "内容",
  accuracy: "文法の正確さ",
  vocabulary: "語彙・表現",
  organization: "構成",
  requirements: "語数・指定条件",
};
const EVALUATION_LEVELS = new Set(["basic", "standard", "advanced"]);

function normalizeEvaluationLevel(value) {
  const level = String(value || "standard").trim().toLowerCase();
  if (!EVALUATION_LEVELS.has(level)) {
    throw new WritingFunctionError("invalid-argument", "評価レベルが不正です。");
  }
  return level;
}

function cleanOptionalWordLimit(value, label) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1000) {
    throw new WritingFunctionError("invalid-argument", `${label}が不正です。`);
  }
  return parsed;
}

function normalizeRubric(value) {
  const input = value && typeof value === "object" ? value : {};
  const rubric = {};
  for (const key of RUBRIC_KEYS) {
    const raw = input[key] && typeof input[key] === "object"
      ? input[key].maxScore
      : input[key];
    const maxScore = Number(raw);
    if (!Number.isInteger(maxScore) || maxScore < 0 || maxScore > 100) {
      throw new WritingFunctionError(
        "invalid-argument",
        `${RUBRIC_LABELS[key]}の配点が不正です。`
      );
    }
    rubric[key] = { key, label: RUBRIC_LABELS[key], maxScore };
  }
  if (Object.values(rubric).reduce((sum, item) => sum + item.maxScore, 0) <= 0) {
    throw new WritingFunctionError("invalid-argument", "合計点は1点以上にしてください。");
  }
  return rubric;
}

function validatePerformanceTestData(data) {
  if (!data || typeof data !== "object") {
    throw new WritingFunctionError("failed-precondition", "課題設定が不正です。");
  }
  const prompt = String(data.prompt || "").trim();
  if (!prompt) {
    throw new WritingFunctionError("failed-precondition", "課題文が設定されていません。");
  }
  const minWords = cleanOptionalWordLimit(data.minWords, "最低語数");
  const maxWords = cleanOptionalWordLimit(data.maxWords, "最大語数");
  if (minWords != null && maxWords != null && minWords > maxWords) {
    throw new WritingFunctionError(
      "failed-precondition",
      "最低語数は最大語数以下にしてください。"
    );
  }
  const rubric = normalizeRubric(data.rubric);
  // Existing tests predate these controls and exposed both the AI provisional
  // evaluation and the teacher-confirmed evaluation. Preserve that behavior
  // when the fields are absent so no migration is required.
  const showEvaluationToStudents = data.showEvaluationToStudents !== false;
  const showProvisionalEvaluationToStudents = showEvaluationToStudents &&
    data.showProvisionalEvaluationToStudents !== false;
  return {
    title: String(data.title || "Writing Performance Test").trim(),
    prompt,
    instructions: String(data.instructions || "").trim(),
    minWords,
    maxWords,
    rubric,
    evaluationLevel: normalizeEvaluationLevel(data.evaluationLevel),
    aiTeacherInstruction: String(data.aiTeacherInstruction || "")
      .trim()
      .slice(0, 500),
    showEvaluationToStudents,
    showProvisionalEvaluationToStudents,
    totalPoints: Object.values(rubric).reduce(
      (sum, item) => sum + item.maxScore,
      0
    ),
  };
}

function performanceScoreSchema(test) {
  const properties = {};
  for (const key of RUBRIC_KEYS) {
    properties[key] = {
      type: "object",
      additionalProperties: false,
      required: ["score", "commentJa"],
      properties: {
        score: { type: "integer", minimum: 0, maximum: test.rubric[key].maxScore },
        commentJa: { type: "string" },
      },
    };
  }
  return {
    type: "object",
    additionalProperties: false,
    required: [
      ...RUBRIC_KEYS,
      "overallFeedbackJa",
      "minimalCorrectedText",
      "deductions",
      "strengths",
      "suggestions",
      "needsTeacherReview",
      "reviewReasonJa",
    ],
    properties: {
      ...properties,
      overallFeedbackJa: { type: "string" },
      minimalCorrectedText: { type: "string" },
      deductions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "criterion",
            "quote",
            "errorPart",
            "correction",
            "reasonJa",
            "pointsLost",
          ],
          properties: {
            criterion: { type: "string", enum: RUBRIC_KEYS },
            quote: { type: "string" },
            errorPart: { type: "string" },
            correction: { type: "string" },
            reasonJa: { type: "string" },
            pointsLost: {
              type: "integer",
              minimum: 1,
              maximum: test.totalPoints,
            },
          },
        },
      },
      strengths: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["criterion", "textJa"],
          properties: {
            criterion: { type: "string", enum: RUBRIC_KEYS },
            textJa: { type: "string" },
          },
        },
      },
      suggestions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "quote",
            "suggestion",
            "reasonJa",
            "scoreImpact",
          ],
          properties: {
            quote: { type: "string" },
            suggestion: { type: "string" },
            reasonJa: { type: "string" },
            scoreImpact: { type: "boolean" },
          },
        },
      },
      needsTeacherReview: { type: "boolean" },
      reviewReasonJa: { type: ["string", "null"] },
    },
  };
}

function buildPerformanceScoringPayload({ test, submittedText, wordCount }) {
  return {
    model: process.env.WRITING_PERFORMANCE_MODEL || WRITING_MODEL,
    reasoning_effort: "low",
    max_completion_tokens: 4000,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "writing_performance_score",
        strict: true,
        schema: performanceScoreSchema(test),
      },
    },
    messages: [
      {
        role: "system",
        content: [
          "You assess a Japanese junior or senior high school student's Writing Performance Test.",
          "Evaluate the submitted text as written. Do not rewrite it or invent missing content.",
          "Score only against the supplied assignment and rubric. Do not add unstated requirements.",
          "Apply the supplied evaluationLevel as the expected proficiency standard, not as extra assignment requirements.",
          "basic prioritizes understandable content using basic grammar and vocabulary; standard balances grammatical accuracy, appropriate vocabulary, and coherence; advanced expects higher accuracy, broader expression, and logical natural organization.",
          "Use the supplied wordCount; never count words yourself.",
          "Each score must be an integer from 0 through its supplied maximum. A zero-point criterion must receive zero.",
          "Do not decide the overall result from grammar alone. Prioritize the teacher instruction when supplied.",
          "Be cautious when meaning is unclear and set needsTeacherReview when human judgment is advisable.",
          "deductions must contain only concrete reasons that actually lowered a rubric score: clear grammar or usage errors, spelling errors, unmet assignment requirements, missing required grammar, off-topic content, or a concrete organization problem under the rubric.",
          "Never deduct merely because a grammatically acceptable sentence could sound more natural, polished, native-like, detailed, or sophisticated. Put such optional improvements only in suggestions and keep scoreImpact false.",
          "For every deduction, identify its rubric criterion and pointsLost. The pointsLost totals per criterion must equal that criterion's maxScore minus score. Do not create a deduction for a criterion receiving full points.",
          "Keep deductions concise and normally use no more than 3 entries by combining closely related errors. Use an empty errorPart and correction when the deduction is about content, organization, or requirements rather than a local text correction.",
          "Return 1 to 3 concrete rubric-based strengths and no more than 2 optional suggestions. Keep every explanation to one or two short Japanese sentences. Do not generate a full rewritten essay.",
          "For minimalCorrectedText, preserve the student's ideas, vocabulary choices, sentence order, tone, and level.",
          "Correct only clear spelling, capitalization, punctuation, article, preposition, subject-verb agreement, verb form or tense, singular/plural, and other basic grammar errors.",
          "Do not improve style, naturalness, detail, organization, or expression. Do not replace a grammatically acceptable expression with a more polished one.",
          "When a possible change is uncertain, keep the student's original wording. If no clear correction is needed, return submittedText unchanged.",
          "Return exactly the requested JSON object in Japanese feedback.",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          assignment: test.prompt,
          supplementalInstructions: test.instructions || null,
          submittedText,
          wordCount,
          minWords: test.minWords,
          maxWords: test.maxWords,
          rubric: test.rubric,
          evaluationLevel: test.evaluationLevel,
          teacherInstruction: test.aiTeacherInstruction || null,
        }),
      },
    ],
  };
}

function validatePerformanceScore(value, test) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WritingFunctionError("internal", "AI一次評価の形式が不正です。");
  }
  const scores = {};
  let total = 0;
  for (const key of RUBRIC_KEYS) {
    const item = value[key];
    const maxScore = test.rubric[key].maxScore;
    const score = Number(item && item.score);
    if (!Number.isInteger(score) || score < 0 || score > maxScore) {
      throw new WritingFunctionError(
        "internal",
        `${RUBRIC_LABELS[key]}のAI点が配点範囲外です。`
      );
    }
    scores[key] = {
      score,
      maxScore,
      commentJa: String((item && item.commentJa) || "").trim(),
    };
    total += score;
  }
  const minimalCorrectedText = normalizeWritingText(value.minimalCorrectedText);
  if (!minimalCorrectedText || minimalCorrectedText.length > 5000) {
    throw new WritingFunctionError("internal", "最小訂正文の形式が不正です。");
  }
  const deductions = validateDeductions(value.deductions, test, scores);
  const strengths = validateStrengths(value.strengths);
  const suggestions = validateSuggestions(value.suggestions);
  return {
    aiScores: scores,
    aiTotalScore: total,
    aiFeedback: String(value.overallFeedbackJa || "").trim(),
    minimalCorrectedText,
    deductions,
    strengths,
    suggestions,
    needsTeacherReview: value.needsTeacherReview === true,
    reviewReasonJa:
      typeof value.reviewReasonJa === "string" && value.reviewReasonJa.trim()
        ? value.reviewReasonJa.trim()
        : null,
  };
}

function requiredDetailText(value, label, maxLength) {
  const text = String(value || "").trim();
  if (!text || text.length > maxLength) {
    throw new WritingFunctionError("internal", `${label}の形式が不正です。`);
  }
  return text;
}

function optionalDetailText(value, maxLength) {
  const text = String(value || "").trim();
  if (text.length > maxLength) {
    throw new WritingFunctionError("internal", "AI評価詳細の形式が不正です。");
  }
  return text;
}

function validateCriterion(value) {
  const criterion = String(value || "").trim();
  if (!RUBRIC_KEYS.includes(criterion)) {
    throw new WritingFunctionError("internal", "AI評価詳細の評価項目が不正です。");
  }
  return criterion;
}

function validateDeductions(value, test, scores) {
  if (!Array.isArray(value) || value.length > 5) {
    throw new WritingFunctionError("internal", "減点理由の形式が不正です。");
  }
  const lostByCriterion = Object.fromEntries(RUBRIC_KEYS.map((key) => [key, 0]));
  const deductions = value.map((item) => {
    const criterion = validateCriterion(item && item.criterion);
    const pointsLost = Number(item && item.pointsLost);
    const scoreGap = test.rubric[criterion].maxScore - scores[criterion].score;
    if (!Number.isInteger(pointsLost) || pointsLost < 1 || pointsLost > scoreGap) {
      throw new WritingFunctionError("internal", "減点理由とAI点に矛盾があります。");
    }
    lostByCriterion[criterion] += pointsLost;
    return {
      criterion,
      quote: optionalDetailText(item.quote, 500),
      errorPart: optionalDetailText(item.errorPart, 200),
      correction: optionalDetailText(item.correction, 200),
      reasonJa: requiredDetailText(item.reasonJa, "減点理由", 300),
      pointsLost,
    };
  });
  for (const key of RUBRIC_KEYS) {
    const expected = test.rubric[key].maxScore - scores[key].score;
    if (lostByCriterion[key] !== expected) {
      throw new WritingFunctionError("internal", "減点理由の合計とAI点に矛盾があります。");
    }
  }
  return deductions;
}

function validateStrengths(value) {
  if (!Array.isArray(value) || value.length > 3) {
    throw new WritingFunctionError("internal", "よかった点の形式が不正です。");
  }
  return value.map((item) => ({
    criterion: validateCriterion(item && item.criterion),
    textJa: requiredDetailText(item && item.textJa, "よかった点", 300),
  }));
}

function validateSuggestions(value) {
  if (!Array.isArray(value) || value.length > 2) {
    throw new WritingFunctionError("internal", "改善提案の形式が不正です。");
  }
  return value.map((item) => {
    if (!item || item.scoreImpact !== false) {
      throw new WritingFunctionError("internal", "改善提案を減点理由として扱うことはできません。");
    }
    return {
      quote: requiredDetailText(item.quote, "改善前の表現", 500),
      suggestion: requiredDetailText(item.suggestion, "改善提案", 500),
      reasonJa: requiredDetailText(item.reasonJa, "改善提案の理由", 300),
      scoreImpact: false,
    };
  });
}

async function callPerformanceScoring({ test, submittedText, wordCount, apiKey, fetchImpl }) {
  if (!apiKey) {
    throw new WritingFunctionError("failed-precondition", "AI採点APIが設定されていません。");
  }
  const response = await fetchImpl("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(buildPerformanceScoringPayload({ test, submittedText, wordCount })),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new WritingFunctionError("unavailable", `AI採点APIでエラーが発生しました。status=${response.status}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    throw new WritingFunctionError("internal", "AI採点APIの応答形式が不正です。");
  }
  const content = extractMessageContent(parsed);
  if (!content) throw new WritingFunctionError("internal", "AI採点APIの応答に本文がありません。");
  let value;
  try {
    value = JSON.parse(extractJsonObjectText(content));
  } catch (_) {
    throw new WritingFunctionError("internal", "AI採点結果のJSONを解析できませんでした。");
  }
  return {
    ...validatePerformanceScore(value, test),
    aiModel: parsed.model || process.env.WRITING_PERFORMANCE_MODEL || WRITING_MODEL,
  };
}

function studentBelongsToClass(student, classId) {
  const ids = [student.classId, student.currentClassId]
    .map((value) => String(value || "").trim());
  if (ids.includes(classId)) return true;
  for (const key of ["classIds", "enrolledClassIds"]) {
    if (Array.isArray(student[key]) && student[key].map(String).includes(classId)) return true;
  }
  return false;
}

async function assertStudentClass({ db, session, classId }) {
  const cleanClassId = cleanId(classId, "classId");
  const classRef = db.collection("schools").doc(session.schoolId)
    .collection("classes").doc(cleanClassId);
  const [classSnap, memberSnap, studentSnap] = await Promise.all([
    classRef.get(),
    classRef.collection("students").doc(session.studentInternalUid).get(),
    db.collection("schools").doc(session.schoolId)
      .collection("students").doc(session.studentInternalUid).get(),
  ]);
  if (!classSnap.exists || !studentSnap.exists) {
    throw new WritingAccessError("permission-denied", "対象クラスを利用できません。");
  }
  if (!memberSnap.exists && !studentBelongsToClass(studentSnap.data() || {}, cleanClassId)) {
    throw new WritingAccessError("permission-denied", "対象クラスを利用できません。");
  }
  return { classId: cleanClassId, classRef };
}

function publicTestData(doc, submission, evaluation) {
  const test = validatePerformanceTestData(doc.data());
  const submissionData = submission && submission.exists ? submission.data() : null;
  const evaluationData = evaluation && evaluation.exists ? evaluation.data() : null;
  const finalScore = Number.isFinite(evaluationData?.finalScore)
    ? evaluationData.finalScore
    : (Number.isFinite(submissionData?.teacherTotalScore)
      ? submissionData.teacherTotalScore
      : null);
  const teacherScores = evaluationData?.scoreOnly === true
    ? null
    : (evaluationData?.teacherScores || submissionData?.teacherScores || null);
  const teacherComment = String(
    evaluationData?.teacherComment ?? submissionData?.teacherComment ?? ""
  );
  const teacherReviewed = Boolean(
    submissionData &&
    Number.isFinite(finalScore)
  );
  const showProvisional = Boolean(
    submissionData &&
    test.showEvaluationToStudents &&
    test.showProvisionalEvaluationToStudents &&
    !teacherReviewed
  );
  const showFinal = Boolean(
    submissionData && test.showEvaluationToStudents && teacherReviewed
  );
  const finalMatchesAi = teacherReviewed && (
    evaluationData?.evaluationMethod === "ai_confirmed" ||
    rubricScoresMatch(submissionData.aiScores, teacherScores)
  );
  const showAiEvaluationDetails = showProvisional || (showFinal && finalMatchesAi);
  return {
    testId: doc.id,
    title: test.title,
    prompt: test.prompt,
    instructions: test.instructions,
    minWords: test.minWords,
    maxWords: test.maxWords,
    rubric: test.rubric,
    evaluationLevel: test.evaluationLevel,
    totalPoints: test.totalPoints,
    showEvaluationToStudents: test.showEvaluationToStudents,
    showProvisionalEvaluationToStudents:
      test.showProvisionalEvaluationToStudents,
    submitted: Boolean(submission && submission.exists),
    submission: submissionData ? {
      submittedText: String(submissionData.submittedText || ""),
      wordCount: Number(submissionData.wordCount || 0),
      scoringStatus: String(submissionData.scoringStatus || "pending"),
      aiScores: showProvisional ? submissionData.aiScores || null : null,
      aiTotalScore: showProvisional && Number.isFinite(submissionData.aiTotalScore)
        ? submissionData.aiTotalScore : null,
      aiFeedback: showProvisional ? String(submissionData.aiFeedback || "") : "",
      minimalCorrectedText: showProvisional || showFinal
        ? String(submissionData.minimalCorrectedText || "") : "",
      deductions: showAiEvaluationDetails && Array.isArray(submissionData.deductions)
        ? submissionData.deductions : [],
      strengths: showAiEvaluationDetails && Array.isArray(submissionData.strengths)
        ? submissionData.strengths : [],
      suggestions: showAiEvaluationDetails && Array.isArray(submissionData.suggestions)
        ? submissionData.suggestions : [],
      teacherScores: showFinal ? teacherScores : null,
      teacherTotalScore: showFinal ? finalScore : null,
      teacherComment: showFinal ? teacherComment : "",
      evaluationMethod: showFinal
        ? String(evaluationData?.evaluationMethod || "") || null
        : null,
      teacherReviewed,
    } : null,
  };
}

function rubricScoresMatch(aiScores, teacherScores) {
  if (!aiScores || !teacherScores) return false;
  return RUBRIC_KEYS.every((key) => {
    const ai = Number(aiScores[key] && aiScores[key].score);
    const teacher = Number(teacherScores[key] && teacherScores[key].score);
    return Number.isInteger(ai) && ai === teacher;
  });
}

function resolveWritingPerformancePreviewContext({ token, data }) {
  if (!token || token.role !== "teacher_preview") {
    throw new WritingAccessError(
      "permission-denied",
      "生徒アプリのプレビュー権限を確認できません。"
    );
  }
  const schoolId = cleanId(token.schoolId, "schoolId");
  const tokenClassId = cleanId(token.classId, "classId");
  const requestedClassId = cleanId(data && data.classId, "classId");
  if (tokenClassId !== requestedClassId) {
    throw new WritingAccessError(
      "permission-denied",
      "プレビュー対象外のクラスです。"
    );
  }
  return { schoolId, classId: requestedClassId };
}

async function listWritingPerformanceTestsForPreview({ db, token, data }) {
  const { schoolId, classId } = resolveWritingPerformancePreviewContext({
    token,
    data,
  });
  const classRef = db.collection("schools").doc(schoolId)
    .collection("classes").doc(classId);
  const classSnap = await classRef.get();
  if (!classSnap.exists) {
    throw new WritingAccessError(
      "permission-denied",
      "プレビュー対象のクラスを利用できません。"
    );
  }
  const snap = await classRef.collection("writingPerformanceTests")
    .where("isActive", "==", true).get();
  return {
    items: snap.docs.map((doc) => publicTestData(doc, null, null)),
  };
}

async function listWritingPerformanceTests({ db, authUid, data }) {
  const session = await resolveWritingSession({ db, authUid });
  const { classRef } = await assertStudentClass({ db, session, classId: data && data.classId });
  const snap = await classRef.collection("writingPerformanceTests")
    .where("isActive", "==", true).get();
  const items = await Promise.all(snap.docs.map(async (doc) => {
    const [submission, evaluation] = await Promise.all([
      doc.ref.collection("submissions").doc(session.studentInternalUid).get(),
      doc.ref.collection("evaluations").doc(session.studentInternalUid).get(),
    ]);
    return publicTestData(doc, submission, evaluation);
  }));
  return { items };
}

async function submitWritingPerformanceTest({ db, admin, authUid, data, apiKey, fetchImpl }) {
  const session = await resolveWritingSession({ db, authUid });
  const { classId, classRef } = await assertStudentClass({
    db,
    session,
    classId: data && data.classId,
  });
  const testId = cleanId(data && data.testId, "testId");
  const submittedText = normalizeWritingText(data && data.submittedText);
  if (!submittedText || submittedText.length > 5000 || countWritingWords(submittedText) > 700) {
    throw new WritingFunctionError("invalid-argument", "提出英文が不正です。");
  }
  const wordCount = countWritingWords(submittedText);
  const testRef = classRef.collection("writingPerformanceTests").doc(testId);
  const submissionRef = testRef.collection("submissions").doc(session.studentInternalUid);
  let test;
  await db.runTransaction(async (transaction) => {
    const [testSnap, existing] = await Promise.all([
      transaction.get(testRef),
      transaction.get(submissionRef),
    ]);
    if (!testSnap.exists || testSnap.data().isActive !== true) {
      throw new WritingFunctionError("not-found", "公開中の課題が見つかりません。");
    }
    if (existing.exists) {
      throw new WritingFunctionError("already-exists", "この課題は提出済みです。");
    }
    test = validatePerformanceTestData(testSnap.data());
    transaction.create(submissionRef, {
      testId,
      schoolId: session.schoolId,
      classId,
      studentId: session.studentInternalUid,
      submittedText,
      wordCount,
      submittedAt: FieldValue.serverTimestamp(),
      status: "submitted",
      scoringStatus: "pending",
      testSnapshot: {
        title: test.title,
        prompt: test.prompt,
        instructions: test.instructions,
        minWords: test.minWords,
        maxWords: test.maxWords,
        rubric: test.rubric,
        evaluationLevel: test.evaluationLevel,
        totalPoints: test.totalPoints,
        showEvaluationToStudents: test.showEvaluationToStudents,
        showProvisionalEvaluationToStudents:
          test.showProvisionalEvaluationToStudents,
      },
    });
  });

  try {
    const score = await callPerformanceScoring({
      test,
      submittedText,
      wordCount,
      apiKey,
      fetchImpl,
    });
    await submissionRef.update({
      ...score,
      scoringStatus: "completed",
      aiScoredAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    const showProvisional = test.showEvaluationToStudents &&
      test.showProvisionalEvaluationToStudents;
    return {
      submitted: true,
      scoringStatus: "completed",
      wordCount,
      aiScores: showProvisional ? score.aiScores : null,
      aiTotalScore: showProvisional ? score.aiTotalScore : null,
      aiFeedback: showProvisional ? score.aiFeedback : "",
      minimalCorrectedText: showProvisional ? score.minimalCorrectedText : "",
      deductions: showProvisional ? score.deductions : [],
      strengths: showProvisional ? score.strengths : [],
      suggestions: showProvisional ? score.suggestions : [],
    };
  } catch (error) {
    await submissionRef.update({
      scoringStatus: "failed",
      scoringError: error instanceof WritingFunctionError ? error.message : "AI一次評価に失敗しました。",
      scoringFailedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { submitted: true, scoringStatus: "failed", wordCount };
  }
}

module.exports = {
  RUBRIC_KEYS,
  RUBRIC_LABELS,
  normalizeRubric,
  normalizeEvaluationLevel,
  validatePerformanceTestData,
  buildPerformanceScoringPayload,
  validatePerformanceScore,
  callPerformanceScoring,
  studentBelongsToClass,
  publicTestData,
  resolveWritingPerformancePreviewContext,
  listWritingPerformanceTestsForPreview,
  listWritingPerformanceTests,
  submitWritingPerformanceTest,
};
