"use strict";

const fs = require("node:fs");
const assert = require("node:assert/strict");
const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require("@firebase/rules-unit-testing");
const { doc, getDoc, setDoc, Timestamp } = require("firebase/firestore");
const { initializeApp, deleteApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

const projectId = "shadow-speak-whisper-rules-audit";
const rules = fs.readFileSync(
  "rules/firestore.whisper-security-candidate.rules",
  "utf8",
);

(async () => {
  const env = await initializeTestEnvironment({
    projectId,
    firestore: { rules },
  });
  const adminApp = initializeApp({ projectId }, "whisper-rules-admin");
  const adminDb = getFirestore(adminApp);

  try {
    await env.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, "schools/school-a"), { name: "School A" });
      await setDoc(doc(db, "schools/school-a/teachers/teacher-a"), {
        active: true, isAdmin: false,
      });
      await setDoc(doc(db, "schools/school-a/teachers/admin-teacher"), {
        active: true, isAdmin: true,
      });
      const expiresAt = Timestamp.fromMillis(Date.now() + 60 * 60 * 1000);
      await setDoc(doc(db, "teacherSessions/teacher-auth"), {
        active: true, role: "teacher", schoolId: "school-a",
        teacherId: "teacher-a", expiresAt,
      });
      await setDoc(doc(db, "teacherSessions/admin-teacher-auth"), {
        active: true, role: "teacher", schoolId: "school-a",
        teacherId: "admin-teacher", expiresAt,
      });
      await setDoc(doc(db, "schools/school-a/classes/class-a"), { name: "1A" });
      await setDoc(doc(db, "schools/school-a/classes/class-a/materials/material-a"), {
        title: "Material A",
      });
      await setDoc(doc(db, "schools/school-a/classes/class-a/students/student-a"), {
        studentInternalUid: "student-a",
      });
      await setDoc(doc(db, "schools/school-a/classes/class-a/vocabTests/test-a"), {
        title: "Vocabulary A",
      });
      await setDoc(doc(db, "schools/school-a/classes/class-a/vocabTests/test-a/results/student-a"), {
        score: 10,
      });
      await setDoc(doc(db, "schools/school-a/classes/class-a/submit_boxes/box-a"), {
        title: "Submit A",
      });
      await setDoc(doc(db, "schools/school-a/classes/class-a/submit_boxes/box-a/submissions/sub-a"), {
        studentInternalUid: "student-a",
      });
      await setDoc(doc(db, "schools/school-a/classes/class-a/writingPerformanceTests/test-a"), {
        title: "Writing A",
      });
      await setDoc(doc(db, "schools/school-a/students/student-a"), {
        name: "Student A",
      });
      await setDoc(doc(db, "users/student-auth"), { name: "Student A" });
      await setDoc(doc(db, "students/legacy-student-a"), { name: "Legacy A" });
      await setDoc(doc(db, "official_materials/official-a"), { title: "Official" });
      await setDoc(doc(db, "admins/admin-auth"), { active: true, role: "admin" });
      await setDoc(doc(db, "writingFeatureFlags/school-a"), { enabled: true });
      await setDoc(doc(db, "unknownCollection/public-before"), { value: true });
      await setDoc(doc(db, "serverWhisperTranscriptionJobs/job-a"), {
        authUid: "student-auth",
        status: "completed",
        result: { text: "private" },
      });
    });

    const unauth = env.unauthenticatedContext().firestore();
    const student = env.authenticatedContext("student-auth").firestore();
    const teacher = env.authenticatedContext("teacher-auth").firestore();
    const adminTeacher = env.authenticatedContext("admin-teacher-auth").firestore();
    const adminClient = env.authenticatedContext("admin-auth").firestore();
    const job = "serverWhisperTranscriptionJobs/job-a";

    await assertFails(getDoc(doc(unauth, job)));
    await assertFails(getDoc(doc(student, job)));
    await assertFails(getDoc(doc(teacher, job)));
    await assertFails(getDoc(doc(adminClient, job)));
    await assertFails(setDoc(doc(unauth, job), { status: "forged" }));
    await assertFails(setDoc(doc(student, job), { status: "forged" }));
    await assertFails(setDoc(doc(teacher, job), { status: "forged" }));
    await assertFails(setDoc(doc(adminClient, job), { status: "forged" }));
    console.log("ok - Whisper jobs reject every client read and write");

    await adminDb.doc("serverWhisperTranscriptionJobs/admin-job").set({
      status: "completed",
      result: { text: "admin-only" },
    });
    const adminJob = await adminDb
      .doc("serverWhisperTranscriptionJobs/admin-job")
      .get();
    assert.equal(adminJob.data().result.text, "admin-only");
    console.log("ok - Firebase Admin SDK can read and write Whisper jobs");

    // Preserve current Production client behavior for known content paths.
    await assertSucceeds(getDoc(doc(unauth, "schools/school-a")));
    await assertSucceeds(getDoc(doc(unauth, "schools/school-a/classes/class-a")));
    await assertSucceeds(getDoc(doc(
      unauth,
      "schools/school-a/classes/class-a/materials/material-a",
    )));
    await assertSucceeds(getDoc(doc(unauth, "schools/school-a/students/student-a")));
    await assertSucceeds(getDoc(doc(unauth, "schools/school-a/classes/class-a/students/student-a")));
    await assertSucceeds(getDoc(doc(unauth, "schools/school-a/classes/class-a/vocabTests/test-a")));
    await assertSucceeds(getDoc(doc(unauth, "schools/school-a/classes/class-a/vocabTests/test-a/results/student-a")));
    await assertSucceeds(getDoc(doc(unauth, "schools/school-a/classes/class-a/submit_boxes/box-a")));
    await assertSucceeds(getDoc(doc(unauth, "schools/school-a/classes/class-a/submit_boxes/box-a/submissions/sub-a")));
    await assertSucceeds(getDoc(doc(unauth, "official_materials/official-a")));
    await assertSucceeds(getDoc(doc(student, "users/student-auth")));
    await assertSucceeds(getDoc(doc(student, "students/legacy-student-a")));
    await assertFails(getDoc(doc(unauth, "students/legacy-student-a")));
    await assertSucceeds(setDoc(
      doc(teacher, "schools/school-a/classes/class-a"),
      { name: "1A updated" },
      { merge: true },
    ));
    await assertSucceeds(setDoc(
      doc(student, "schools/school-a/classes/class-a/materials/material-a/results/student-auth"),
      { score: 80 },
    ));
    console.log("ok - existing school/material/student read paths remain compatible");

    await assertSucceeds(setDoc(
      doc(student, "schools/school-a/students/student-a"),
      { uiPreferences: { compact: true } },
      { merge: true },
    ));
    await assertFails(setDoc(
      doc(student, "schools/school-a/students/student-a"),
      { grade: "3" },
      { merge: true },
    ));
    await assertFails(setDoc(
      doc(teacher, "schools/school-a/students/forged-student"),
      { loginId: "forged", grade: "1" },
    ));
    await assertSucceeds(setDoc(
      doc(adminTeacher, "schools/school-a/students/new-student"),
      { loginId: "261101", grade: "1", class: "1", number: "01" },
    ));
    await assertFails(setDoc(
      doc(teacher, "schools/school-a"),
      { classNotation: "alphabetic" },
      { merge: true },
    ));
    await assertSucceeds(setDoc(
      doc(adminTeacher, "schools/school-a"),
      { classNotation: "alphabetic" },
      { merge: true },
    ));
    await assertSucceeds(setDoc(
      doc(adminClient, "schools/school-a/students/global-admin-student"),
      { loginId: "261102", grade: "1", class: "1", number: "02" },
    ));
    await assertSucceeds(setDoc(
      doc(adminClient, "schools/school-a"),
      { classNotation: "numeric" },
      { merge: true },
    ));
    console.log("ok - protected student and school settings require a school or global administrator");

    await assertFails(getDoc(doc(
      unauth,
      "schools/school-a/classes/class-a/writingPerformanceTests/test-a",
    )));
    await assertFails(getDoc(doc(
      teacher,
      "schools/school-a/classes/class-a/writingPerformanceTests/test-a",
    )));
    await assertFails(setDoc(
      doc(teacher, "schools/school-a/academicYearUpdateRuns/forged"),
      { status: "completed" },
    ));
    await assertFails(setDoc(
      doc(teacher, "schools/school-a/passwordResetAudit/forged"),
      { result: "success" },
    ));
    console.log("ok - Writing results and new audit collections remain callable/Admin-only");

    await assertSucceeds(getDoc(doc(adminClient, "admins/admin-auth")));
    await assertSucceeds(getDoc(doc(adminClient, "writingFeatureFlags/school-a")));
    await assertFails(getDoc(doc(student, "admins/admin-auth")));
    await assertFails(getDoc(doc(student, "writingFeatureFlags/school-a")));
    console.log("ok - admin app compatibility is explicit and scoped");

    await assertFails(getDoc(doc(unauth, "unknownCollection/public-before")));
    await assertFails(getDoc(doc(student, "unknownCollection/public-before")));
    console.log("ok - unknown top-level collections are no longer public");
  } finally {
    await env.cleanup();
    await deleteApp(adminApp);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
