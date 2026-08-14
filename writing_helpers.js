"use strict";

const WRITING_MODEL = process.env.WRITING_CORRECTION_MODEL || "gpt-5.6-luna";
const MAX_TEXT_CHARS = 2500;
const MAX_TEXT_WORDS = 350;
const ALLOWED_MODES = new Set(["simple_correction"]);

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
    "positiveFeedbackJa",
    "corrections",
    "nextTipJa",
    "needsTeacherReview",
    "reviewReasonJa",
  ],
  properties: {
    originalText: { type: "string" },
    correctedText: { type: "string" },
    positiveFeedbackJa: { type: "string" },
    corrections: {
      type: "array",
      maxItems: 20,
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
    nextTipJa: { type: "string" },
    needsTeacherReview: { type: "boolean" },
    reviewReasonJa: { type: ["string", "null"] },
  },
};

function buildCorrectionPayload(text) {
  return {
    model: WRITING_MODEL,
    max_completion_tokens: 900,
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
          "Check spelling, grammar, and usage.",
          "Do not rewrite correct sentences just to make them more natural.",
          "Keep the student's meaning and voice.",
          "Do not add facts, reasons, or content that the student did not write.",
          "Do not penalize repeated expressions if they are grammatically correct.",
          "Explain corrections in concise Japanese for Japanese students.",
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
    return validateCorrectionResult(result, {
      model: parsed.model || WRITING_MODEL,
      inputTokens: Number.isInteger(usage.prompt_tokens)
        ? usage.prompt_tokens
        : null,
      outputTokens: Number.isInteger(usage.completion_tokens)
        ? usage.completion_tokens
        : null,
      elapsedMs: 0,
    });
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
    positiveFeedbackJa: requiredString(value, "positiveFeedbackJa"),
    corrections: parseCorrections(value.corrections),
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
    return {
      original: requiredString(item, "original"),
      corrected: requiredString(item, "corrected"),
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
  validateCorrectWritingInput,
  validateCorrectionResult,
  buildCorrectionPayload,
  callOpenAiCorrection,
  correctWritingHandler,
};
