"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  SecureAudioAccessError,
  assertOwned,
  downloadAudio,
  fromUrl,
  requireSession,
  resolvePath,
} = require("../secure_audio_access");

const BUCKET = "shadow-speak-school.firebasestorage.app";

function fakeDb(documents) {
  return {
    collection(name) {
      return {
        doc(id) {
          return {
            async get() {
              const data = documents[`${name}/${id}`];
              return { exists: Boolean(data), data: () => data };
            },
          };
        },
      };
    },
  };
}

function expectCode(fn, code) {
  assert.throws(fn, (error) =>
    error instanceof SecureAudioAccessError && error.code === code);
}

test("external, localhost, private and other-bucket URLs are rejected", () => {
  for (const value of [
    "https://example.com/audio.wav",
    "http://localhost/audio.wav",
    "http://127.0.0.1/audio.wav",
    "http://169.254.169.254/computeMetadata/v1/",
    "gs://other-bucket/users/u/recordings/a.wav",
  ]) {
    expectCode(() => fromUrl(value, BUCKET), "permission-denied");
  }
});

test("same-bucket Firebase URL and storagePath resolve", () => {
  const path = "users/u1/recordings/a.wav";
  assert.equal(resolvePath({ storagePath: path }, BUCKET), path);
  assert.equal(fromUrl(
    `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(path)}?alt=media`,
    BUCKET,
  ), path);
});

test("valid unexpired student session is required", async () => {
  const expiresAt = { toMillis: () => Date.now() + 60_000 };
  const valid = fakeDb({
    "studentSessions/u1": {
      active: true, role: "student", schoolId: "school-a", expiresAt,
    },
  });
  assert.equal((await requireSession(valid, "u1")).role, "student");
  await assert.rejects(
    requireSession(fakeDb({}), ""),
    (error) => error.code === "unauthenticated",
  );
  await assert.rejects(
    requireSession(fakeDb({}), "u1"),
    (error) => error.code === "permission-denied",
  );
});

test("student and teacher ownership prefixes are enforced", () => {
  const student = { role: "student", authUid: "u1", schoolId: "school-a" };
  assert.doesNotThrow(() => assertOwned("users/u1/recordings/a.wav", student));
  expectCode(
    () => assertOwned("users/u2/recordings/a.wav", student),
    "permission-denied",
  );
  const teacher = { role: "teacher", authUid: "t1", schoolId: "school-a" };
  assert.doesNotThrow(() => assertOwned("school_materials/school-a/audio/a.wav", teacher));
  expectCode(
    () => assertOwned("school_materials/school-b/audio/a.wav", teacher),
    "permission-denied",
  );
});

test("oversize and invalid type objects are rejected before download", async () => {
  function bucket(metadata) {
    return {
      file() {
        return {
          exists: async () => [true],
          getMetadata: async () => [metadata],
          download: async () => [Buffer.from("audio")],
        };
      },
    };
  }
  await assert.rejects(
    downloadAudio({
      bucket: bucket({ size: 25 * 1024 * 1024, contentType: "audio/wav" }),
      storagePath: "users/u1/recordings/a.wav",
    }),
    (error) => error.code === "invalid-argument",
  );
  await assert.rejects(
    downloadAudio({
      bucket: bucket({ size: 100, contentType: "text/plain" }),
      storagePath: "users/u1/recordings/a.txt",
    }),
    (error) => error.code === "invalid-argument",
  );
});
