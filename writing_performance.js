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
      "corrections",
      "practiceCorrections",
      "rewriteSegments",
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
      corrections: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["original", "corrected", "type", "reasonJa"],
          properties: {
            original: { type: "string" },
            corrected: { type: "string" },
            type: { type: "string", enum: ["grammar", "spelling"] },
            reasonJa: { type: "string" },
          },
        },
      },
      practiceCorrections: {
        type: "array",
        maxItems: 5,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "type",
            "original",
            "corrected",
            "reasonJa",
            "contextBefore",
            "contextAfter",
          ],
          properties: {
            type: { type: "string", enum: ["replace", "insert", "delete"] },
            original: { type: "string" },
            corrected: { type: "string" },
            reasonJa: { type: "string" },
            contextBefore: { type: "string" },
            contextAfter: { type: "string" },
          },
        },
      },
      rewriteSegments: {
        type: "array",
        maxItems: 5,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["original", "corrected", "reasonJa"],
          properties: {
            original: { type: "string" },
            corrected: { type: "string" },
            reasonJa: { type: "string" },
          },
        },
      },
      deductions: {
        type: "array",
        maxItems: 5,
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
        maxItems: 3,
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
        maxItems: 2,
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
          "Before returning JSON, verify each criterion independently: add its deductions.pointsLost values and make that integer total exactly equal maxScore minus score. Keep the rubric score as the assessment result; deductions only explain that score and must never be used to recalculate or replace it.",
          "Keep deductions concise and return no more than 5 entries by combining closely related errors. Deductions explain the rubric scores; they never determine or recalculate them. Use an empty errorPart and correction when the deduction is about content, organization, or requirements rather than a local text correction.",
          "Return 1 to 3 concrete rubric-based strengths and no more than 2 optional suggestions. Keep every explanation to one or two short Japanese sentences. Do not generate a full rewritten essay.",
          "For minimalCorrectedText, preserve the student's ideas, vocabulary choices, sentence order, tone, and level.",
          "Correct only clear spelling, capitalization, punctuation, article, preposition, subject-verb agreement, verb form or tense, singular/plural, and other basic grammar errors.",
          "Do not improve style, naturalness, detail, organization, or expression. Do not replace a grammatically acceptable expression with a more polished one.",
          "When a possible change is uncertain, keep the student's original wording. If no clear correction is needed, return submittedText unchanged.",
          "corrections is the source of truth for the red correction display. Include only objectively necessary grammar or spelling corrections represented in minimalCorrectedText.",
          "Do not include style, naturalness, expression preference, content, organization, word-count requirements, optional rewrites, capitalization-only, or punctuation-only changes in corrections.",
          "Each corrections.original must be the exact local text from submittedText and corrections.corrected must be the exact replacement text present in minimalCorrectedText. Use grammar for article, preposition, agreement, word order, verb form/tense, number, and other grammar; use spelling only for misspelled words.",
          "If there are no objective grammar or spelling corrections, return an empty corrections array.",
          "practiceCorrections and rewriteSegments are for short relearning, not for scoring. Select at most 5 entries total, prioritizing basic grammar, spelling, a missing word, and an obviously extra word.",
          "Use practiceCorrections.type replace for a local replacement, insert for a missing word or short phrase, and delete for an obviously extra word. Never include optional style improvements.",
          "For replace and delete, original must be the exact local text in submittedText. For replace and insert, corrected must be the exact answer in minimalCorrectedText. Use an empty original only for insert and an empty corrected only for delete.",
          "For every practice correction, contextBefore and contextAfter must be short exact adjacent text copied from submittedText so the location can be found. Either context may be empty only at the beginning or end of the submission.",
          "Use rewriteSegments only when a sentence or segment is too broken for a short local replace, insert, or delete. Show the student's exact segment and its minimally corrected form; do not turn it into a full-input exercise.",
          "If submittedText and minimalCorrectedText differ, return at least one practiceCorrection or rewriteSegment whenever possible. If no safe local target can be identified, return one rewriteSegment covering the smallest useful segment.",
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

function validatePerformanceScore(value, test, submittedText = "") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WritingFunctionError("internal", "AI一次評価の形式が不正です。");
  }
  const validationWarnings = [];
  const scores = {};
  let total = 0;
  for (const key of RUBRIC_KEYS) {
    const item = value[key];
    const maxScore = test.rubric[key].maxScore;
    const score = item && item.score;
    if (typeof score !== "number" || !Number.isInteger(score) ||
        score < 0 || score > maxScore) {
      throw new WritingFunctionError(
        "internal",
        `${RUBRIC_LABELS[key]}のAI点が配点範囲外です。`
      );
    }
    scores[key] = {
      score,
      maxScore,
      commentJa: typeof item.commentJa === "string" ? item.commentJa.trim() : "",
    };
    total += score;
  }
  const rubricTotal = RUBRIC_KEYS.reduce(
    (sum, key) => sum + test.rubric[key].maxScore,
    0
  );
  if (!Number.isInteger(total) || total < 0 || total > rubricTotal ||
      rubricTotal !== test.totalPoints) {
    throw new WritingFunctionError("internal", "AI一次評価の合計点が不正です。");
  }
  if (typeof value.minimalCorrectedText !== "string") {
    throw new WritingFunctionError("internal", "最小訂正文の形式が不正です。");
  }
  const minimalCorrectedText = normalizeWritingText(value.minimalCorrectedText);
  if (!minimalCorrectedText || minimalCorrectedText.length > 5000) {
    throw new WritingFunctionError("internal", "最小訂正文の形式が不正です。");
  }
  const deductionValidation = validateDeductions(
    value.deductions,
    test,
    scores,
    validationWarnings
  );
  const deductions = deductionValidation.deductions;
  const corrections = validateCorrections(
    value.corrections,
    deductions,
    validationWarnings
  );
  const practiceCorrections = validatePracticeCorrections(
    value.practiceCorrections,
    corrections,
    validationWarnings
  );
  let rewriteSegments = validateRewriteSegments(
    value.rewriteSegments,
    validationWarnings,
    Math.max(0, 5 - practiceCorrections.length)
  );
  const normalizedSubmittedText = normalizeWritingText(submittedText);
  const fullTextReviewRequired = Boolean(normalizedSubmittedText &&
      normalizeComparableWriting(normalizedSubmittedText) !==
        normalizeComparableWriting(minimalCorrectedText) &&
      practiceCorrections.length === 0 && rewriteSegments.length === 0);
  if (fullTextReviewRequired) {
    rewriteSegments = [{
      original: normalizedSubmittedText,
      corrected: minimalCorrectedText,
      reasonJa: "修正版の全文を確認しましょう。",
    }];
  }
  const strengths = validateStrengths(value.strengths, validationWarnings);
  const suggestions = validateSuggestions(value.suggestions, validationWarnings);
  return {
    aiScores: scores,
    aiTotalScore: total,
    aiFeedback: String(value.overallFeedbackJa || "").trim(),
    minimalCorrectedText,
    corrections,
    practiceCorrections,
    rewriteSegments,
    fullTextReviewRequired,
    deductions,
    deductionMismatch: deductionValidation.mismatch,
    validationWarnings,
    strengths,
    suggestions,
    needsTeacherReview: value.needsTeacherReview === true,
    reviewReasonJa:
      typeof value.reviewReasonJa === "string" && value.reviewReasonJa.trim()
        ? value.reviewReasonJa.trim()
        : null,
  };
}

function normalizeComparableWriting(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function pushValidationWarning(warnings, code) {
  if (Array.isArray(warnings) && !warnings.includes(code)) warnings.push(code);
}

function softDetailText(value, maxLength, required = false) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if ((required && !text) || text.length > maxLength) return null;
  return text;
}

function legacyPracticeCorrections(legacyCorrections) {
  return legacyCorrections.slice(0, 5).map((item) => ({
    type: "replace",
    original: item.original,
    corrected: item.corrected,
    reasonJa: item.reasonJa,
    contextBefore: "",
    contextAfter: "",
  }));
}

function validatePracticeCorrections(
  value,
  legacyCorrections = [],
  warnings = []
) {
  if (value == null) {
    return legacyPracticeCorrections(legacyCorrections);
  }
  if (!Array.isArray(value)) {
    pushValidationWarning(warnings, "practice_corrections_not_array");
    return legacyPracticeCorrections(legacyCorrections);
  }
  const seen = new Set();
  const valid = [];
  for (const item of value) {
    const type = String(item && item.type || "").trim();
    if (!["replace", "insert", "delete"].includes(type)) {
      pushValidationWarning(warnings, "practice_correction_invalid_item");
      continue;
    }
    const original = softDetailText(item && item.original, 200);
    const corrected = softDetailText(item && item.corrected, 200);
    const reasonJa = softDetailText(item && item.reasonJa, 300, true);
    const contextBefore = softDetailText(item && item.contextBefore, 200);
    const contextAfter = softDetailText(item && item.contextAfter, 200);
    if (original == null || corrected == null || reasonJa == null ||
        contextBefore == null || contextAfter == null) {
      pushValidationWarning(warnings, "practice_correction_invalid_item");
      continue;
    }
    if ((type === "insert" && (original || !corrected)) ||
        (type === "delete" && (!original || corrected)) ||
        (type === "replace" && (!original || !corrected))) {
      pushValidationWarning(warnings, "practice_correction_invalid_item");
      continue;
    }
    const correction = {
      type,
      original,
      corrected,
      reasonJa,
      contextBefore,
      contextAfter,
    };
    const key = `${type}\u0000${original}\u0000${corrected}\u0000${correction.contextBefore}\u0000${correction.contextAfter}`;
    if (seen.has(key)) {
      pushValidationWarning(warnings, "practice_correction_duplicate_discarded");
      continue;
    }
    seen.add(key);
    if (valid.length < 5) valid.push(correction);
    else pushValidationWarning(warnings, "practice_corrections_truncated");
  }
  return valid;
}

function validateRewriteSegments(value, warnings = [], limit = 5) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    pushValidationWarning(warnings, "rewrite_segments_not_array");
    return [];
  }
  const seen = new Set();
  const valid = [];
  for (const item of value) {
    const original = softDetailText(item && item.original, 1000, true);
    const corrected = softDetailText(item && item.corrected, 1000, true);
    const reasonJa = softDetailText(item && item.reasonJa, 300, true);
    if (original == null || corrected == null || reasonJa == null) {
      pushValidationWarning(warnings, "rewrite_segment_invalid_item");
      continue;
    }
    const key = `${original}\u0000${corrected}`;
    if (seen.has(key)) {
      pushValidationWarning(warnings, "rewrite_segment_duplicate_discarded");
      continue;
    }
    seen.add(key);
    if (valid.length < limit) valid.push({ original, corrected, reasonJa });
    else pushValidationWarning(warnings, "relearning_targets_truncated");
  }
  return valid;
}

function fallbackCorrectionsFromDeductions(deductions) {
  return deductions
    .filter((item) =>
      item.criterion === "accuracy" &&
      String(item.errorPart || "").trim() &&
      String(item.correction || "").trim()
    )
    .slice(0, 20)
    .map((item) => ({
      original: String(item.errorPart).trim(),
      corrected: String(item.correction).trim(),
      type: /spelling|spell|スペル|綴り/i.test(String(item.reasonJa || ""))
        ? "spelling"
        : "grammar",
      reasonJa: String(item.reasonJa || "").trim(),
    }));
}

function validateCorrections(value, deductions = [], warnings = []) {
  // Old stored responses and local fixtures do not have this field. A
  // conservative accuracy-only fallback keeps them readable without a data
  // migration, while every newly scored response is required by the strict
  // schema above to provide the structured field.
  if (value == null) {
    return fallbackCorrectionsFromDeductions(deductions);
  }
  if (!Array.isArray(value)) {
    pushValidationWarning(warnings, "corrections_not_array");
    return fallbackCorrectionsFromDeductions(deductions);
  }
  const seen = new Set();
  const valid = [];
  for (const item of value) {
    const type = String(item && item.type || "").trim();
    if (type !== "grammar" && type !== "spelling") {
      pushValidationWarning(warnings, "correction_invalid_item");
      continue;
    }
    const original = softDetailText(item && item.original, 200, true);
    const corrected = softDetailText(item && item.corrected, 200, true);
    const reasonJa = softDetailText(item && item.reasonJa, 300, true);
    if (original == null || corrected == null || reasonJa == null) {
      pushValidationWarning(warnings, "correction_invalid_item");
      continue;
    }
    const correction = {
      original,
      corrected,
      type,
      reasonJa,
    };
    const key = `${correction.type}\u0000${correction.original}\u0000${correction.corrected}`;
    if (seen.has(key)) {
      pushValidationWarning(warnings, "correction_duplicate_discarded");
      continue;
    }
    seen.add(key);
    if (valid.length < 20) valid.push(correction);
    else pushValidationWarning(warnings, "corrections_truncated");
  }
  return valid.length > 0 ? valid : fallbackCorrectionsFromDeductions(deductions);
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

function validateDeductions(value, test, scores, warnings = []) {
  const lostByCriterion = Object.fromEntries(RUBRIC_KEYS.map((key) => [key, 0]));
  let mismatch = false;
  if (!Array.isArray(value)) {
    pushValidationWarning(warnings, "deductions_not_array");
    return { deductions: [], mismatch: true };
  }
  const deductions = [];
  for (const item of value) {
    const criterion = String(item && item.criterion || "").trim();
    const pointsLost = item && item.pointsLost;
    const quote = softDetailText(item && item.quote, 500);
    const errorPart = softDetailText(item && item.errorPart, 200);
    const correction = softDetailText(item && item.correction, 200);
    const reasonJa = softDetailText(item && item.reasonJa, 300, true);
    if (!RUBRIC_KEYS.includes(criterion) ||
        typeof pointsLost !== "number" || !Number.isInteger(pointsLost) ||
        pointsLost < 1 || pointsLost > test.totalPoints || quote == null ||
        errorPart == null || correction == null || reasonJa == null) {
      pushValidationWarning(warnings, "deduction_invalid_item");
      mismatch = true;
      continue;
    }
    const scoreGap = test.rubric[criterion].maxScore - scores[criterion].score;
    if (pointsLost > scoreGap) mismatch = true;
    lostByCriterion[criterion] += pointsLost;
    const deduction = {
      criterion,
      quote,
      errorPart,
      correction,
      reasonJa,
      pointsLost,
    };
    if (deductions.length < 5) deductions.push(deduction);
    else pushValidationWarning(warnings, "deductions_truncated");
  }
  for (const key of RUBRIC_KEYS) {
    const expected = test.rubric[key].maxScore - scores[key].score;
    if (lostByCriterion[key] !== expected) {
      mismatch = true;
    }
  }
  return { deductions, mismatch };
}

function validateStrengths(value, warnings = []) {
  if (!Array.isArray(value)) {
    pushValidationWarning(warnings, "strengths_not_array");
    return [];
  }
  const valid = [];
  for (const item of value) {
    const criterion = String(item && item.criterion || "").trim();
    const textJa = softDetailText(item && item.textJa, 300, true);
    if (!RUBRIC_KEYS.includes(criterion) || textJa == null) {
      pushValidationWarning(warnings, "strength_invalid_item");
      continue;
    }
    if (valid.length < 3) valid.push({ criterion, textJa });
    else pushValidationWarning(warnings, "strengths_truncated");
  }
  return valid;
}

function validateSuggestions(value, warnings = []) {
  if (!Array.isArray(value)) {
    pushValidationWarning(warnings, "suggestions_not_array");
    return [];
  }
  const valid = [];
  for (const item of value) {
    if (!item || item.scoreImpact !== false) {
      pushValidationWarning(warnings, "suggestion_invalid_item");
      continue;
    }
    const quote = softDetailText(item.quote, 500, true);
    const suggestion = softDetailText(item.suggestion, 500, true);
    const reasonJa = softDetailText(item.reasonJa, 300, true);
    if (quote == null || suggestion == null || reasonJa == null) {
      pushValidationWarning(warnings, "suggestion_invalid_item");
      continue;
    }
    const normalized = {
      quote,
      suggestion,
      reasonJa,
      scoreImpact: false,
    };
    if (valid.length < 2) valid.push(normalized);
    else pushValidationWarning(warnings, "suggestions_truncated");
  }
  return valid;
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
  const validated = validatePerformanceScore(value, test, submittedText);
  if (validated.deductionMismatch || validated.validationWarnings.length > 0) {
    console.warn("Writing Performance auxiliary AI fields were normalized; rubric scores were kept as the source of truth.", {
      deductionMismatch: validated.deductionMismatch,
      validationWarnings: validated.validationWarnings,
    });
  }
  return {
    ...validated,
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
      // Relearning content is independent from score visibility. Hiding the
      // provisional score must not make the corrected reading target vanish.
      minimalCorrectedText: String(submissionData.minimalCorrectedText || ""),
      corrections: Array.isArray(submissionData.corrections)
        ? submissionData.corrections
        : null,
      practiceCorrections: Array.isArray(submissionData.practiceCorrections)
        ? submissionData.practiceCorrections
        : null,
      rewriteSegments: Array.isArray(submissionData.rewriteSegments)
        ? submissionData.rewriteSegments
        : [],
      fullTextReviewRequired: submissionData.fullTextReviewRequired === true,
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
      speakingChallenge: publicSpeakingChallenge(
        submissionData.speakingChallenge
      ),
    } : null,
  };
}

function publicSpeakingChallenge(raw) {
  if (!raw || typeof raw !== "object" || raw.completed !== true) return null;
  const sanitizeAttempt = (value) => {
    if (!value || typeof value !== "object") return null;
    return {
      recognizedText: String(value.recognizedText || ""),
      accuracy: Number.isFinite(value.accuracy) ? value.accuracy : 0,
      wpm: Number.isFinite(value.wpm) ? value.wpm : 0,
      durationMs: Number.isFinite(value.durationMs) ? value.durationMs : 0,
      performedAtMillis: Number.isFinite(value.performedAtMillis)
        ? value.performedAtMillis
        : (Number.isFinite(value.updatedAtMillis) ? value.updatedAtMillis : null),
    };
  };
  const legacy = sanitizeAttempt(raw);
  const latest = sanitizeAttempt(raw.latest) || legacy;
  const best = sanitizeAttempt(raw.best) || legacy;
  if (!latest || !best) return null;
  return {
    sourceType: "writingPerformance",
    referenceScript: String(raw.referenceScript || ""),
    ...latest,
    completed: true,
    relearningCompleted: raw.relearningCompleted !== false,
    attemptCount: Number.isInteger(raw.attemptCount) ? raw.attemptCount : 1,
    completedAtMillis: Number.isFinite(raw.completedAtMillis)
      ? raw.completedAtMillis
      : null,
    latest,
    best,
    schemaVersion: Number.isInteger(raw.schemaVersion) ? raw.schemaVersion : 1,
    updatedAtMillis: Number.isFinite(raw.updatedAtMillis)
      ? raw.updatedAtMillis
      : latest.performedAtMillis,
  };
}

function normalizeSpeakingWords(text) {
  return String(text || "")
    .toLowerCase()
    // Apostrophes are not observable in speech. Treat "don't" and a speech
    // recognizer's "dont" as the same spoken word.
    .replace(/['\u2019]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function wordEditDistance(reference, recognized) {
  if (reference.length === 0) return recognized.length;
  if (recognized.length === 0) return reference.length;
  let previous = Array.from({ length: recognized.length + 1 }, (_, index) => index);
  for (let i = 1; i <= reference.length; i += 1) {
    const current = Array(recognized.length + 1).fill(0);
    current[0] = i;
    for (let j = 1; j <= recognized.length; j += 1) {
      current[j] = Math.min(
        previous[j - 1] + (reference[i - 1] === recognized[j - 1] ? 0 : 1),
        previous[j] + 1,
        current[j - 1] + 1
      );
    }
    previous = current;
  }
  return previous[recognized.length];
}

function calculateSpeakingChallengeMetrics({ referenceScript, recognizedText, durationMs }) {
  const reference = normalizeSpeakingWords(referenceScript);
  const recognized = normalizeSpeakingWords(recognizedText);
  const distance = wordEditDistance(reference, recognized);
  const accuracy = reference.length === 0
    ? 0
    : Math.max(0, Math.min(100, Math.round((1 - distance / reference.length) * 100)));
  const wpm = durationMs <= 0
    ? 0
    : Math.max(0, Math.min(1000, Math.round(recognized.length * 60000 / durationMs)));
  return { accuracy, wpm, durationMs };
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
      minimalCorrectedText: score.minimalCorrectedText,
      corrections: score.corrections,
      practiceCorrections: score.practiceCorrections,
      rewriteSegments: score.rewriteSegments,
      fullTextReviewRequired: score.fullTextReviewRequired,
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

async function saveWritingPerformanceSpeakingChallenge({ db, authUid, data }) {
  const session = await resolveWritingSession({ db, authUid });
  const { classRef } = await assertStudentClass({
    db,
    session,
    classId: data && data.classId,
  });
  const testId = cleanId(data && data.testId, "testId");
  if (String(data && data.sourceType || "") !== "writingPerformance") {
    throw new WritingFunctionError("invalid-argument", "練習元の種類が不正です。");
  }
  const referenceScript = normalizeWritingText(data && data.referenceScript);
  const recognizedText = normalizeWritingText(data && data.recognizedText);
  const durationMs = Number(data && data.durationMs);
  if (!referenceScript || referenceScript.length > 5000 ||
      !recognizedText || recognizedText.length > 10000 ||
      !Number.isFinite(durationMs) || durationMs < 250 || durationMs > 600000) {
    throw new WritingFunctionError("invalid-argument", "Speaking Challengeの結果が不正です。");
  }

  const testRef = classRef.collection("writingPerformanceTests").doc(testId);
  const submissionRef = testRef.collection("submissions").doc(session.studentInternalUid);
  const metrics = calculateSpeakingChallengeMetrics({
    referenceScript,
    recognizedText,
    durationMs: Math.round(durationMs),
  });
  let savedChallenge;
  await db.runTransaction(async (transaction) => {
    const [testSnap, submissionSnap] = await Promise.all([
      transaction.get(testRef),
      transaction.get(submissionRef),
    ]);
    if (!testSnap.exists || !submissionSnap.exists) {
      throw new WritingFunctionError("failed-precondition", "Writing提出後に利用できます。");
    }
    const submission = submissionSnap.data() || {};
    const expectedReference = normalizeSpeakingWords(
      submission.minimalCorrectedText || submission.submittedText
    ).join(" ");
    if (!expectedReference ||
        expectedReference !== normalizeSpeakingWords(referenceScript).join(" ")) {
      throw new WritingFunctionError("invalid-argument", "練習する英文を確認できませんでした。");
    }

    const previous = publicSpeakingChallenge(submission.speakingChallenge);
    const performedAtMillis = Date.now();
    const latest = {
      recognizedText,
      ...metrics,
      performedAtMillis,
    };
    const previousBest = previous && previous.best;
    const isBetter = !previousBest ||
      latest.accuracy > previousBest.accuracy ||
      (latest.accuracy === previousBest.accuracy && latest.wpm > previousBest.wpm);
    const best = isBetter ? latest : previousBest;
    savedChallenge = {
      sourceType: "writingPerformance",
      referenceScript,
      completed: true,
      relearningCompleted: true,
      completedAt: submission.speakingChallenge?.completedAt || FieldValue.serverTimestamp(),
      completedAtMillis: previous?.completedAtMillis || performedAtMillis,
      attemptCount: (previous?.attemptCount || 0) + 1,
      latest,
      best,
      schemaVersion: 2,
      updatedAt: FieldValue.serverTimestamp(),
      updatedAtMillis: performedAtMillis,
    };
    transaction.update(submissionRef, {
      speakingChallenge: savedChallenge,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
  return publicSpeakingChallenge(savedChallenge);
}

module.exports = {
  RUBRIC_KEYS,
  RUBRIC_LABELS,
  normalizeRubric,
  normalizeEvaluationLevel,
  validatePerformanceTestData,
  buildPerformanceScoringPayload,
  validatePerformanceScore,
  validateCorrections,
  validatePracticeCorrections,
  validateRewriteSegments,
  callPerformanceScoring,
  studentBelongsToClass,
  publicTestData,
  publicSpeakingChallenge,
  normalizeSpeakingWords,
  calculateSpeakingChallengeMetrics,
  resolveWritingPerformancePreviewContext,
  listWritingPerformanceTestsForPreview,
  listWritingPerformanceTests,
  submitWritingPerformanceTest,
  saveWritingPerformanceSpeakingChallenge,
};
