"use strict";

const path = require("path");

const AUDIO_EXTENSIONS = new Set([
  ".wav", ".webm", ".m4a", ".aac", ".mp3", ".ogg", ".mp4", ".caf",
]);
const AUDIO_CONTENT_TYPES = new Set([
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
  "audio/mp4",
  "audio/aac",
  "audio/mpeg",
  "audio/ogg",
  "audio/x-caf",
  "video/webm",
  "video/mp4",
]);

class SecureAudioAccessError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function timestampMillis(value) {
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (value && Number.isFinite(value._seconds)) return value._seconds * 1000;
  if (value && Number.isFinite(value.seconds)) return value.seconds * 1000;
  return 0;
}

function normalizeStoragePath(value) {
  const result = String(value || "").trim().replace(/^\/+/, "");
  if (!result || result.includes("\0") || result.split("/").includes("..")) {
    throw new SecureAudioAccessError("invalid-argument", "音声ファイルの指定が不正です。");
  }
  return result;
}

function pathFromFirebaseStorageUrl(value, expectedBucket) {
  const raw = String(value || "").trim();
  if (raw.startsWith("gs://")) {
    const withoutScheme = raw.slice(5);
    const slash = withoutScheme.indexOf("/");
    const bucket = slash >= 0 ? withoutScheme.slice(0, slash) : withoutScheme;
    if (bucket !== expectedBucket || slash < 0) {
      throw new SecureAudioAccessError("permission-denied", "許可されていないStorageです。");
    }
    return normalizeStoragePath(decodeURIComponent(withoutScheme.slice(slash + 1)));
  }

  let url;
  try {
    url = new URL(raw);
  } catch (_) {
    throw new SecureAudioAccessError("invalid-argument", "音声ファイルの指定が不正です。");
  }
  if (url.protocol !== "https:") {
    throw new SecureAudioAccessError("permission-denied", "外部URLは利用できません。");
  }
  if (url.hostname === "firebasestorage.googleapis.com") {
    const match = url.pathname.match(/^\/v0\/b\/([^/]+)\/o\/(.+)$/);
    if (!match || decodeURIComponent(match[1]) !== expectedBucket) {
      throw new SecureAudioAccessError("permission-denied", "許可されていないStorageです。");
    }
    return normalizeStoragePath(decodeURIComponent(match[2]));
  }
  if (url.hostname === "storage.googleapis.com") {
    const parts = url.pathname.replace(/^\//, "").split("/");
    const bucket = decodeURIComponent(parts.shift() || "");
    if (bucket !== expectedBucket || parts.length === 0) {
      throw new SecureAudioAccessError("permission-denied", "許可されていないStorageです。");
    }
    return normalizeStoragePath(decodeURIComponent(parts.join("/")));
  }
  if (url.hostname === `${expectedBucket}.storage.googleapis.com`) {
    return normalizeStoragePath(decodeURIComponent(url.pathname));
  }
  throw new SecureAudioAccessError("permission-denied", "外部URLは利用できません。");
}

function resolveStoragePath({ data, expectedBucket }) {
  if (data && data.storagePath) return normalizeStoragePath(data.storagePath);
  const legacyUrl = data && (data.audioUrl || data.sourceUrl);
  if (!legacyUrl) {
    throw new SecureAudioAccessError("invalid-argument", "storagePathが必要です。");
  }
  return pathFromFirebaseStorageUrl(legacyUrl, expectedBucket);
}

async function requireStudentSession({ db, authUid }) {
  if (!authUid) throw new SecureAudioAccessError("unauthenticated", "ログインが必要です。");
  const snap = await db.collection("studentSessions").doc(authUid).get();
  const session = snap.exists ? snap.data() : null;
  if (!session || session.active !== true || session.role !== "student" ||
      timestampMillis(session.expiresAt) <= Date.now() ||
      (timestampMillis(session.absoluteExpiresAt) > 0 &&
       timestampMillis(session.absoluteExpiresAt) <= Date.now())) {
    throw new SecureAudioAccessError("permission-denied", "生徒セッションを確認できません。");
  }
  return {
    authUid,
    schoolId: String(session.schoolId || ""),
    studentId: String(session.studentInternalUid || session.studentId || ""),
  };
}

async function requireTeacherSession({ db, authUid }) {
  if (!authUid) throw new SecureAudioAccessError("unauthenticated", "ログインが必要です。");
  const snap = await db.collection("teacherSessions").doc(authUid).get();
  const session = snap.exists ? snap.data() : null;
  if (!session || session.active !== true || session.role !== "teacher" ||
      timestampMillis(session.expiresAt) <= Date.now() ||
      (timestampMillis(session.absoluteExpiresAt) > 0 &&
       timestampMillis(session.absoluteExpiresAt) <= Date.now())) {
    throw new SecureAudioAccessError("permission-denied", "教員セッションを確認できません。");
  }
  return {
    authUid,
    schoolId: String(session.schoolId || ""),
    teacherId: String(session.teacherId || ""),
  };
}

function assertPathPrefix(storagePath, allowedPrefixes) {
  if (!allowedPrefixes.some((prefix) => storagePath.startsWith(prefix))) {
    throw new SecureAudioAccessError("permission-denied", "この音声ファイルを利用する権限がありません。");
  }
}

async function validateAudioObject({ bucket, storagePath, maxBytes }) {
  const file = bucket.file(storagePath);
  const [exists] = await file.exists();
  if (!exists) throw new SecureAudioAccessError("not-found", "音声ファイルが見つかりません。");
  const [metadata] = await file.getMetadata();
  const size = Number(metadata.size || 0);
  const contentType = String(metadata.contentType || "").split(";")[0].toLowerCase();
  const extension = path.extname(storagePath).toLowerCase();
  if (!Number.isFinite(size) || size <= 0 || size > maxBytes) {
    throw new SecureAudioAccessError("invalid-argument", "音声ファイルのサイズが上限を超えています。");
  }
  if (!AUDIO_EXTENSIONS.has(extension) || !AUDIO_CONTENT_TYPES.has(contentType)) {
    throw new SecureAudioAccessError("invalid-argument", "対応していない音声形式です。");
  }
  return { file, metadata, size, contentType, extension };
}

function assertTeacherOutputPath(storagePath, schoolId, allowedSuffixes) {
  if (!storagePath) return null;
  const normalized = normalizeStoragePath(storagePath);
  assertPathPrefix(normalized, [`school_materials/${schoolId}/`]);
  if (!allowedSuffixes.some((suffix) => normalized.toLowerCase().endsWith(suffix))) {
    throw new SecureAudioAccessError("invalid-argument", "出力先の形式が不正です。");
  }
  return normalized;
}

async function enforceRateLimit({ db, authUid, operation, limit, windowMs }) {
  const ref = db.collection("securityRateLimits").doc(`${operation}_${authUid}`);
  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    const current = snap.exists ? snap.data() : {};
    const now = Date.now();
    const windowStartedAtMillis = Number(current.windowStartedAtMillis || 0);
    const insideWindow = windowStartedAtMillis > 0 && now - windowStartedAtMillis < windowMs;
    const count = insideWindow ? Number(current.count || 0) : 0;
    if (count >= limit) {
      throw new SecureAudioAccessError("resource-exhausted", "短時間の利用回数が上限に達しました。少し待って再度お試しください。");
    }
    transaction.set(ref, {
      authUid,
      operation,
      count: count + 1,
      windowStartedAtMillis: insideWindow ? windowStartedAtMillis : now,
      updatedAtMillis: now,
    }, { merge: true });
  });
}

module.exports = {
  AUDIO_CONTENT_TYPES,
  AUDIO_EXTENSIONS,
  SecureAudioAccessError,
  assertPathPrefix,
  assertTeacherOutputPath,
  enforceRateLimit,
  normalizeStoragePath,
  pathFromFirebaseStorageUrl,
  requireStudentSession,
  requireTeacherSession,
  resolveStoragePath,
  validateAudioObject,
};
