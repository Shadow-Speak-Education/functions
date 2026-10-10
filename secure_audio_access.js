"use strict";

const path = require("path");

const ALLOWED_EXTENSIONS = new Set([
  ".wav", ".webm", ".m4a", ".aac", ".mp3", ".ogg", ".mp4", ".caf",
]);
const ALLOWED_TYPES = new Set([
  "audio/wav", "audio/x-wav", "audio/webm", "audio/mp4", "audio/aac",
  "audio/mpeg", "audio/ogg", "audio/x-caf", "video/webm", "video/mp4",
]);

class SecureAudioAccessError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function millis(value) {
  if (value && typeof value.toMillis === "function") return value.toMillis();
  return Number(value?._seconds || value?.seconds || 0) * 1000;
}

function normalize(value) {
  const result = String(value || "").trim().replace(/^\/+/, "");
  if (!result || result.includes("\0") || result.split("/").includes("..")) {
    throw new SecureAudioAccessError("invalid-argument", "音声ファイルの指定が不正です。");
  }
  return result;
}

function fromUrl(value, bucketName) {
  const raw = String(value || "").trim();
  if (raw.startsWith("gs://")) {
    const match = raw.match(/^gs:\/\/([^/]+)\/(.+)$/);
    if (!match || match[1] !== bucketName) {
      throw new SecureAudioAccessError("permission-denied", "許可されていないStorageです。");
    }
    return normalize(decodeURIComponent(match[2]));
  }
  let url;
  try { url = new URL(raw); } catch (_) {
    throw new SecureAudioAccessError("invalid-argument", "音声ファイルの指定が不正です。");
  }
  if (url.protocol !== "https:" || url.hostname !== "firebasestorage.googleapis.com") {
    throw new SecureAudioAccessError("permission-denied", "外部URLは利用できません。");
  }
  const match = url.pathname.match(/^\/v0\/b\/([^/]+)\/o\/(.+)$/);
  if (!match || decodeURIComponent(match[1]) !== bucketName) {
    throw new SecureAudioAccessError("permission-denied", "許可されていないStorageです。");
  }
  return normalize(decodeURIComponent(match[2]));
}

function resolvePath(data, bucketName) {
  if (data?.storagePath) return normalize(data.storagePath);
  const legacyUrl = data?.audioUrl || data?.sourceUrl;
  if (!legacyUrl) throw new SecureAudioAccessError("invalid-argument", "storagePathが必要です。");
  return fromUrl(legacyUrl, bucketName);
}

async function requireSession(db, authUid) {
  if (!authUid) throw new SecureAudioAccessError("unauthenticated", "ログインが必要です。");
  for (const collection of ["studentSessions", "teacherSessions"]) {
    const snap = await db.collection(collection).doc(authUid).get();
    const session = snap.exists ? snap.data() : null;
    if (!session || session.active !== true || millis(session.expiresAt) <= Date.now() ||
        (millis(session.absoluteExpiresAt) > 0 &&
         millis(session.absoluteExpiresAt) <= Date.now())) continue;
    if (collection === "studentSessions" && session.role === "student") {
      return { role: "student", authUid, schoolId: String(session.schoolId || "") };
    }
    if (collection === "teacherSessions" && session.role === "teacher") {
      return { role: "teacher", authUid, schoolId: String(session.schoolId || "") };
    }
  }
  throw new SecureAudioAccessError("permission-denied", "有効なセッションを確認できません。");
}

function assertOwned(storagePath, session) {
  const prefixes = session.role === "student"
    ? [`users/${session.authUid}/recordings/`, `tempSttUploads/${session.authUid}/`]
    : [`school_materials/${session.schoolId}/`];
  if (!prefixes.some((prefix) => storagePath.startsWith(prefix))) {
    throw new SecureAudioAccessError("permission-denied", "この音声ファイルを利用する権限がありません。");
  }
}

async function downloadAudio({ bucket, storagePath, maxBytes = 24 * 1024 * 1024 }) {
  const file = bucket.file(storagePath);
  const [exists] = await file.exists();
  if (!exists) throw new SecureAudioAccessError("not-found", "音声ファイルが見つかりません。");
  const [metadata] = await file.getMetadata();
  const size = Number(metadata.size || 0);
  const type = String(metadata.contentType || "").split(";")[0].toLowerCase();
  if (!Number.isFinite(size) || size <= 0 || size > maxBytes) {
    throw new SecureAudioAccessError("invalid-argument", "音声ファイルのサイズが上限を超えています。");
  }
  if (!ALLOWED_EXTENSIONS.has(path.extname(storagePath).toLowerCase()) ||
      !ALLOWED_TYPES.has(type)) {
    throw new SecureAudioAccessError("invalid-argument", "対応していない音声形式です。");
  }
  const [buffer] = await file.download();
  return { buffer, metadata };
}

module.exports = {
  SecureAudioAccessError,
  assertOwned,
  downloadAudio,
  fromUrl,
  requireSession,
  resolvePath,
};
