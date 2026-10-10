"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} = require("@firebase/rules-unit-testing");
const { doc, setDoc, Timestamp } = require("firebase/firestore");

const projectId = "shadow-speak-storage-rules-audit";
const rulesPath = path.resolve(__dirname, "../../shadow_speak_v3/storage.rules");
let env;

function audioUpload(context, schoolId, filename = "lesson.mp3") {
  return context.storage().ref(
    `school_materials/${schoolId}/audio/${filename}`,
  ).put(
    new Uint8Array([1, 2, 3]),
    { contentType: "audio/mpeg" },
  );
}

async function seedTeacherSession(uid, schoolId, { active = true, expired = false } = {}) {
  await env.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), "teacherSessions", uid), {
      active,
      role: "teacher",
      schoolId,
      teacherId: `${uid}-teacher`,
      expiresAt: Timestamp.fromMillis(Date.now() + (expired ? -60_000 : 60_000)),
    });
  });
}

async function seedStudentSession(uid, schoolId, studentId, { active = true } = {}) {
  await env.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), "studentSessions", uid), {
      active,
      role: "student",
      schoolId,
      studentId,
      studentInternalUid: studentId,
      expiresAt: Timestamp.fromMillis(Date.now() + 60_000),
    });
  });
}

async function seedStorageFile(path, contentType = "audio/mpeg") {
  await env.withSecurityRulesDisabled(async (context) => {
    await context.storage().ref(path).put(
      new Uint8Array([1, 2, 3]),
      { contentType },
    );
  });
}

test.before(async () => {
  env = await initializeTestEnvironment({
    projectId,
    firestore: { host: "127.0.0.1", port: 8189 },
    storage: {
      host: "127.0.0.1",
      port: 9299,
      rules: fs.readFileSync(rulesPath, "utf8"),
    },
  });
});

test.after(async () => {
  await env.cleanup();
});

test.beforeEach(async () => {
  await env.clearFirestore();
  await env.clearStorage();
});

test("自校の有効な教師セッションは音声をアップロードできる", async () => {
  await seedTeacherSession("teacher-a", "school-a");
  const context = env.authenticatedContext("teacher-a");
  await assertSucceeds(audioUpload(context, "school-a"));
});

test("未認証・セッションなし・期限切れ教師はアップロードできない", async () => {
  await assertFails(audioUpload(env.unauthenticatedContext(), "school-a"));
  await assertFails(audioUpload(env.authenticatedContext("no-session"), "school-a"));

  await seedTeacherSession("expired", "school-a", { expired: true });
  await assertFails(audioUpload(env.authenticatedContext("expired"), "school-a"));
});

test("他校の教師はアップロードできない", async () => {
  await seedTeacherSession("teacher-b", "school-b");
  await assertFails(audioUpload(env.authenticatedContext("teacher-b"), "school-a"));
});

test("教師でも音声以外や生成物パスへ直接書き込めない", async () => {
  await seedTeacherSession("teacher-a", "school-a");
  const storage = env.authenticatedContext("teacher-a").storage();

  await assertFails(
    storage.ref("school_materials/school-a/audio/not-audio.txt").put(
      new Uint8Array([1]),
      { contentType: "text/plain" },
    ),
  );
  await assertFails(
    storage.ref("school_materials/school-a/subtitles/manual.json").put(
      new Uint8Array([1]),
      { contentType: "application/json" },
    ),
  );
});

test("自校メンバーだけが学校教材を読める", async () => {
  await seedStudentSession("student-a-auth", "school-a", "student-a");
  await seedStudentSession("student-b-auth", "school-b", "student-b");
  await seedTeacherSession("teacher-a", "school-a");
  await seedStorageFile("school_materials/school-a/audio/lesson.mp3");

  await assertSucceeds(
    env.authenticatedContext("student-a-auth").storage()
      .ref("school_materials/school-a/audio/lesson.mp3").getDownloadURL(),
  );
  await assertSucceeds(
    env.authenticatedContext("teacher-a").storage()
      .ref("school_materials/school-a/audio/lesson.mp3").getDownloadURL(),
  );
  await assertFails(
    env.authenticatedContext("student-b-auth").storage()
      .ref("school_materials/school-a/audio/lesson.mp3").getDownloadURL(),
  );
  await assertFails(
    env.unauthenticatedContext().storage()
      .ref("school_materials/school-a/audio/lesson.mp3").getDownloadURL(),
  );
});

test("生徒録音は本人だけが読み書きできる", async () => {
  await seedStudentSession("student-a-auth", "school-a", "student-a");
  await seedStudentSession("student-b-auth", "school-a", "student-b");
  const studentAStorage = env.authenticatedContext("student-a-auth").storage();
  const studentBStorage = env.authenticatedContext("student-b-auth").storage();
  const path = "users/student-a-auth/recordings/answer.webm";

  await assertSucceeds(studentAStorage.ref(path).put(
    new Uint8Array([1, 2, 3]),
    { contentType: "audio/webm" },
  ));
  await assertSucceeds(studentAStorage.ref(path).getDownloadURL());
  await assertFails(studentBStorage.ref(path).getDownloadURL());
  await assertFails(studentBStorage.ref(path).put(
    new Uint8Array([1]),
    { contentType: "audio/webm" },
  ));
  await assertFails(studentAStorage.ref(
    "users/student-a-auth/recordings/not-audio.txt",
  ).put(new Uint8Array([1]), { contentType: "text/plain" }));
});

test("公式教材だけは未認証でも読める", async () => {
  await seedStorageFile("official/audio/example.mp3");
  await assertSucceeds(
    env.unauthenticatedContext().storage()
      .ref("official/audio/example.mp3").getDownloadURL(),
  );
});
