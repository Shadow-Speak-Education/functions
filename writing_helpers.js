"use strict";

const WRITING_MODEL = process.env.WRITING_CORRECTION_MODEL || "gpt-5.6-luna";
const MAX_TEXT_CHARS = 2500;
const MAX_TEXT_WORDS = 350;
const ALLOWED_MODES = new Set(["simple_correction"]);
const CORRECTION_TYPES = new Set([
  "spelling",
  "grammar",
  "expression",
  "punctuation",
]);

class WritingFunctionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function normalizeWritingText(value) {
  return String(value || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function countWritingWords(value) {
  const normalized = normalizeWritingText(value);
  if (!normalized) return 0;
  const matches = normalized.match(/[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)?/g);
  return matches ? matches.length : 0;
}

function validateCorrectWritingInput(data) {
  const mode = String((data && data.mode) || "").trim();
  if (!ALLOWED_MODES.has(mode)) {
    throw new WritingFunctionError(
      "invalid-argument",
      "modeが不正です。"
    );
  }

  if (!data || typeof data.text !== "string") {
    throw new WritingFunctionError(
      "invalid-argument",
      "英文を入力してください。"
    );
  }

  const text = normalizeWritingText(data.text);
  if (!text) {
    throw new WritingFunctionError(
      "invalid-argument",
      "英文を入力してください。"
    );
  }
  if (text.length < 3) {
    throw new WritingFunctionError(
      "invalid-argument",
      "英文が短すぎます。もう少し入力してください。"
    );
  }
  if (text.length > MAX_TEXT_CHARS) {
    throw new WritingFunctionError(
      "invalid-argument",
      `英文が長すぎます。${MAX_TEXT_CHARS}文字以内にしてください。`
    );
  }

  const wordCount = countWritingWords(text);
  if (wordCount > MAX_TEXT_WORDS) {
    throw new WritingFunctionError(
      "invalid-argument",
      `英文が長すぎます。${MAX_TEXT_WORDS}語以内にしてください。`
    );
  }

  return { text, mode, wordCount };
}

const correctionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "originalText",
    "correctedText",
    "improvedText",
    "positiveFeedbackJa",
    "corrections",
    "improvements",
    "nextTipJa",
    "needsTeacherReview",
    "reviewReasonJa",
  ],
  properties: {
    originalText: { type: "string" },
    correctedText: { type: "string" },
    improvedText: { type: "string" },
    positiveFeedbackJa: { type: "string" },
    corrections: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["original", "corrected", "reasonJa", "explanationJa", "type"],
        properties: {
          original: { type: "string" },
          corrected: { type: "string" },
          reasonJa: { type: "string" },
          explanationJa: { type: "string" },
          type: {
            type: "string",
            enum: ["spelling", "grammar", "expression", "punctuation"],
          },
        },
      },
    },
    improvements: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["addedText", "reasonJa"],
        properties: {
          addedText: { type: "string" },
          reasonJa: { type: "string" },
        },
      },
    },
    nextTipJa: { type: "string" },
    needsTeacherReview: { type: "boolean" },
    reviewReasonJa: { type: ["string", "null"] },
  },
};

function buildCorrectionPayload(text) {
  return {
    model: WRITING_MODEL,
    max_completion_tokens: 1200,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "writing_correction_result",
        strict: true,
        schema: correctionSchema,
      },
    },
    messages: [
      {
        role: "system",
        content: [
          "You are an English writing tutor for Japanese junior and senior high school students.",
          "Return one JSON object that contains both a conservative correction and a better example.",
          "correctedText: keep the student's meaning. Fix only spelling, grammar, punctuation, word usage, and unnatural expressions. Do not add events, opinions, places, dates, names, or information that the student did not write.",
          "improvedText: start from correctedText and make it more natural, specific, or connected. Stay close to the student's intent. Do not invent proper nouns, places, dates, experiences, or strong facts that are not in the original. If needed, add only a generic natural sentence.",
          "If the student's meaning is unclear, do not decide the meaning aggressively. Keep correctedText conservative, keep improvedText modest, set needsTeacherReview=true, and explain why in reviewReasonJa.",
          "Do not rewrite correct sentences in correctedText just to make them more natural.",
          "Do not penalize repeated expressions if they are grammatically correct.",
          "Each correction type must be one of spelling, grammar, expression, punctuation.",
          "For each correction, reasonJa and explanationJa must both be present and may contain the same concise Japanese explanation.",
          "Use improvements only for text added or meaningfully improved in improvedText compared with correctedText.",
          "Always return exactly the requested JSON schema.",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          task: "simple_correction",
          text,
          outputLanguage: "ja",
        }),
      },
    ],
  };
}

async function callOpenAiCorrection({
  text,
  apiKey,
  fetchImpl,
  timeoutMs = 30000,
}) {
  if (!apiKey) {
    throw new WritingFunctionError(
      "failed-precondition",
      "Writing添削APIが設定されていません。"
    );
  }
  if (typeof fetchImpl !== "function") {
    throw new WritingFunctionError(
      "internal",
      "Writing添削APIの呼び出し設定が不正です。"
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildCorrectionPayload(text)),
      signal: controller.signal,
    });

    const responseText = await response.text();
    if (!response.ok) {
      throw new WritingFunctionError(
        "unavailable",
        `Writing添削APIでエラーが発生しました。status=${response.status}`
      );
    }

    let parsed;
    try {
      parsed = JSON.parse(responseText);
    } catch (_) {
      throw new WritingFunctionError(
        "internal",
        "Writing添削APIの応答形式が不正です。"
      );
    }

    const content = parsed.choices &&
      parsed.choices[0] &&
      parsed.choices[0].message &&
      parsed.choices[0].message.content;
    if (typeof content !== "string") {
      throw new WritingFunctionError(
        "internal",
        "Writing添削APIの応答に本文がありません。"
      );
    }

    let result;
    try {
      result = JSON.parse(content);
    } catch (_) {
      throw new WritingFunctionError(
        "internal",
        "Writing添削APIのJSONを解析できませんでした。"
      );
    }

    const usage = parsed.usage || {};
    const validated = validateCorrectionResult(result, {
      model: parsed.model || WRITING_MODEL,
      inputTokens: Number.isInteger(usage.prompt_tokens)
        ? usage.prompt_tokens
        : null,
      outputTokens: Number.isInteger(usage.completion_tokens)
        ? usage.completion_tokens
        : null,
      totalTokens: Number.isInteger(usage.total_tokens) ? usage.total_tokens : null,
      elapsedMs: 0,
    });
    return validated;
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw new WritingFunctionError(
        "deadline-exceeded",
        "Writing添削APIがタイムアウトしました。"
      );
    }
    if (error instanceof WritingFunctionError) throw error;
    throw new WritingFunctionError(
      "unavailable",
      "Writing添削APIの呼び出しに失敗しました。"
    );
  } finally {
    clearTimeout(timer);
  }
}

function validateCorrectionResult(value, usage) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WritingFunctionError(
      "internal",
      "Writing添削結果の形式が不正です。"
    );
  }

  const result = {
    originalText: requiredString(value, "originalText"),
    correctedText: requiredString(value, "correctedText"),
    improvedText:
      optionalString(value, "improvedText") || requiredString(value, "correctedText"),
    positiveFeedbackJa: requiredString(value, "positiveFeedbackJa"),
    corrections: parseCorrections(value.corrections),
    improvements: parseImprovements(value.improvements),
    nextTipJa: requiredString(value, "nextTipJa"),
    needsTeacherReview: value.needsTeacherReview === true,
    reviewReasonJa:
      typeof value.reviewReasonJa === "string" && value.reviewReasonJa.trim()
        ? value.reviewReasonJa.trim()
        : null,
    usage,
  };

  if (result.needsTeacherReview && !result.reviewReasonJa) {
    result.reviewReasonJa = "AIの判断が不確かなため、先生の確認がおすすめです。";
  }

  return result;
}

function requiredString(obj, key) {
  if (typeof obj[key] !== "string" || !obj[key].trim()) {
    throw new WritingFunctionError(
      "internal",
      `Writing添削結果の必須項目が不正です: ${key}`
    );
  }
  return obj[key].trim();
}

function optionalString(obj, key) {
  return typeof obj[key] === "string" && obj[key].trim()
    ? obj[key].trim()
    : null;
}

function parseCorrections(value) {
  if (!Array.isArray(value)) {
    throw new WritingFunctionError(
      "internal",
      "Writing添削結果のcorrectionsが不正です。"
    );
  }
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new WritingFunctionError(
        "internal",
        "Writing添削結果のcorrectionが不正です。"
      );
    }
    const explanationJa =
      optionalString(item, "explanationJa") || requiredString(item, "reasonJa");
    const type = optionalString(item, "type") || "expression";
    if (!CORRECTION_TYPES.has(type)) {
      throw new WritingFunctionError(
        "internal",
        "Writing添削結果のcorrection typeが不正です。"
      );
    }
    return {
      original: requiredString(item, "original"),
      corrected: requiredString(item, "corrected"),
      reasonJa: explanationJa,
      explanationJa,
      type,
    };
  });
}

function parseImprovements(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new WritingFunctionError(
      "internal",
      "Writing添削結果のimprovementsが不正です。"
    );
  }
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new WritingFunctionError(
        "internal",
        "Writing添削結果のimprovementが不正です。"
      );
    }
    return {
      addedText: requiredString(item, "addedText"),
      reasonJa: requiredString(item, "reasonJa"),
    };
  });
}

async function correctWritingHandler({ data, apiKey, fetchImpl }) {
  const startedAt = Date.now();
  const { text } = validateCorrectWritingInput(data);
  const result = await callOpenAiCorrection({ text, apiKey, fetchImpl });

  return {
    ...result,
    originalText: normalizeWritingText(result.originalText),
    usage: {
      ...result.usage,
      model: result.usage.model || WRITING_MODEL,
      elapsedMs: Date.now() - startedAt,
      estimatedCost: null,
    },
  };
}

module.exports = {
  WRITING_MODEL,
  MAX_TEXT_CHARS,
  MAX_TEXT_WORDS,
  WritingFunctionError,
  normalizeWritingText,
  countWritingWords,
  CORRECTION_TYPES,
  validateCorrectWritingInput,
  validateCorrectionResult,
  buildCorrectionPayload,
  callOpenAiCorrection,
  correctWritingHandler,
};
