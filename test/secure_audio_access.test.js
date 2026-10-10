"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  assertPathPrefix,
  pathFromFirebaseStorageUrl,
  requireStudentSession,
  validateAudioObject,
} = require("../secure_audio_access");

const bucketName = "shadow-speak-school.firebasestorage.app";

test("Firebase Storage URL is resolved only for the expected bucket", () => {
  const url = `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/users%2Fauth-a%2Frecordings%2Fa.wav?alt=media`;
  assert.equal(
    pathFromFirebaseStorageUrl(url, bucketName),
    "users/auth-a/recordings/a.wav"
  );
  assert.throws(
    () => pathFromFirebaseStorageUrl("https://example.com/audio.wav", bucketName),
    /外部URL/
  );
  assert.throws(
    () => pathFromFirebaseStorageUrl("http://127.0.0.1/audio.wav", bucketName),
    /外部URL/
  );
  assert.throws(
    () => pathFromFirebaseStorageUrl("http://169.254.169.254/latest/meta-data", bucketName),
    /外部URL/
  );
  assert.throws(
    () => pathFromFirebaseStorageUrl(
      "https://firebasestorage.googleapis.com/v0/b/another-project.appspot.com/o/users%2Fauth-a%2Frecordings%2Fa.wav",
      bucketName
    ),
    /許可されていないStorage/
  );
});

test("student path ownership rejects another auth UID", () => {
  assert.doesNotThrow(() => assertPathPrefix(
    "users/auth-a/recordings/a.wav",
    ["users/auth-a/recordings/"]
  ));
  assert.throws(() => assertPathPrefix(
    "users/auth-b/recordings/a.wav",
    ["users/auth-a/recordings/"]
  ), /権限/);
});

test("student session is required before paid STT", async () => {
  const db = {
    collection: () => ({
      doc: (uid) => ({
        get: async () => uid === "auth-a"
          ? {
            exists: true,
            data: () => ({
              active: true,
              role: "student",
              schoolId: "school-a",
              studentInternalUid: "student-a",
              expiresAt: { toMillis: () => Date.now() + 60_000 },
            }),
          }
          : { exists: false },
      }),
    }),
  };
  await assert.rejects(
    () => requireStudentSession({ db, authUid: null }),
    /ログイン/
  );
  await assert.rejects(
    () => requireStudentSession({ db, authUid: "auth-b" }),
    /セッション/
  );
  const session = await requireStudentSession({ db, authUid: "auth-a" });
  assert.equal(session.schoolId, "school-a");
});

test("audio metadata enforces type and size", async () => {
  const metadata = { size: String(1024), contentType: "audio/wav" };
  const file = {
    exists: async () => [true],
    getMetadata: async () => [metadata],
  };
  const bucket = { file: () => file };
  const result = await validateAudioObject({
    bucket,
    storagePath: "users/auth-a/recordings/a.wav",
    maxBytes: 2048,
  });
  assert.equal(result.size, 1024);

  metadata.size = "4096";
  await assert.rejects(
    () => validateAudioObject({
      bucket,
      storagePath: "users/auth-a/recordings/a.wav",
      maxBytes: 2048,
    }),
    /サイズ/
  );

  metadata.size = "1024";
  metadata.contentType = "text/html";
  await assert.rejects(
    () => validateAudioObject({
      bucket,
      storagePath: "users/auth-a/recordings/a.wav",
      maxBytes: 2048,
    }),
    /音声形式/
  );
});
