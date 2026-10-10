"use strict";

const fs = require("fs");
const assert = require("assert");
const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require("@firebase/rules-unit-testing");
const {
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  updateDoc,
  Timestamp: ClientTimestamp,
} = require("firebase/firestore");
const { initializeApp, deleteApp } = require("firebase-admin/app");
const { getFirestore, Timestamp: AdminTimestamp } = require("firebase-admin/firestore");
const {
  createWritingPerformanceTestForTeacher,
  listWritingPerformanceSubmissionsForTeacher,
  saveWritingPerformanceReviewForTeacher,
} = require("../writing_teacher");
const {
  listWritingPerformanceTests,
  submitWritingPerformanceTest,
} = require("../writing_performance");

const projectId = "shadow-speak-rules-audit";
const rules = fs.readFileSync("rules/firestore.rules", "utf8");

const rubric = {
  content: { maxScore: 4 },
  organization: { maxScore: 4 },
  accuracy: { maxScore: 4 },
  vocabulary: { maxScore: 4 },
  requirements: { maxScore: 4 },
};

function scoreResponse() {
  return {
    ok: true,
    text: async () => JSON.stringify({
      model: "test-model",
      choices: [{ message: { content: JSON.stringify({
        content: { score: 3, commentJa: "内容" },
        organization: { score: 3, commentJa: "構成" },
        accuracy: { score: 3, commentJa: "正確さ" },
        vocabulary: { score: 3, commentJa: "語彙" },
        requirements: { score: 3, commentJa: "条件" },
        overallFeedbackJa: "よく書けています。",
        minimalCorrectedText: "I will study English every day.",
        corrections: [],
        practiceCorrections: [],
        rewriteSegments: [],
        deductions: [
          { criterion: "content", quote: "", errorPart: "", correction: "", reasonJa: "補足が必要です。", pointsLost: 1 },
          { criterion: "organization", quote: "", errorPart: "", correction: "", reasonJa: "構成を確認してください。", pointsLost: 1 },
          { criterion: "accuracy", quote: "", errorPart: "", correction: "", reasonJa: "文法を確認してください。", pointsLost: 1 },
          { criterion: "vocabulary", quote: "", errorPart: "", correction: "", reasonJa: "語彙を確認してください。", pointsLost: 1 },
          { criterion: "requirements", quote: "", errorPart: "", correction: "", reasonJa: "条件を確認してください。", pointsLost: 1 },
        ],
        strengths: [],
        suggestions: [],
        needsTeacherReview: false,
        reviewReasonJa: null,
      }) } }],
    }),
  };
}

async function denied(label, promise) {
  await assertFails(promise);
  console.log(`ok - denied: ${label}`);
}

(async () => {
  const env = await initializeTestEnvironment({ projectId, firestore: { rules } });
  const adminApp = initializeApp({ projectId }, "rules-audit-admin");
  const adminDb = getFirestore(adminApp);
  try {
    await env.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, "schools/school-a"), { schoolCode: "A" });
      await setDoc(doc(db, "schools/school-a/teachers/teacher-a"), { password: "secret", active: true });
      await setDoc(doc(db, "schools/school-a/students/student-a"), { name: "Student A", classIds: ["class-a"] });
      await setDoc(doc(db, "schools/school-a/students/student-b"), { name: "Student B", classIds: ["class-a"] });
      await setDoc(doc(db, "schools/school-a/classes/class-a"), { name: "1A" });
      await setDoc(doc(db, "schools/school-a/classes/class-b"), { name: "1B" });
      await setDoc(doc(db, "schools/school-a/classes/class-b/materials/material-b"), { title: "Other preview material" });
      await setDoc(doc(db, "schools/school-a/classes/class-a/students/student-a"), { studentInternalUid: "student-a" });
      await setDoc(doc(db, "schools/school-a/classes/class-a/students/student-b"), { studentInternalUid: "student-b" });
      await setDoc(doc(db, "schools/school-a/students/student-a/joinedClasses/class-a"), { classId: "class-a", active: true });
      await setDoc(doc(db, "schools/school-a/classes/class-a/students/student-a/dailyStats/2026-08-18"), { count: 1 });
      await setDoc(doc(db, "schools/school-a/classes/class-a/students/student-a/lessonProgress/material-a"), { completed: true });
      await setDoc(doc(db, "schools/school-a/classes/class-a/students/student-a/practiceResults/result-a"), { score: 1 });
      await setDoc(doc(db, "schools/school-a/materials/school-material"), { title: "School material" });
      await setDoc(doc(db, "schools/school-a/classes/class-a/materials/material-a"), { title: "Class material" });
      await setDoc(doc(db, "schools/school-a/classes/class-a/materials/material-a/results/student-a"), { score: 10 });
      await setDoc(doc(db, "schools/school-a/classes/class-a/vocabTests/vocab-a"), { title: "Vocab" });
      await setDoc(doc(db, "schools/school-a/classes/class-a/vocabTests/vocab-a/results/student-a"), { score: 10 });
      await setDoc(doc(db, "schools/school-a/classes/class-a/submit_boxes/box-a"), { title: "Box" });
      await setDoc(doc(db, "schools/school-a/classes/class-a/submit_boxes/box-a/submissions/submission-a"), { text: "answer", studentInternalUid: "student-a" });
      await setDoc(doc(db, "official_materials/official-a"), { title: "Official" });
      await setDoc(doc(db, "users/student-auth"), { name: "Own user" });
      await setDoc(doc(db, "schools/school-a/classes/class-a/writingPerformanceTests/test-a"), {
        title: "Test A", prompt: "Write about your future.", instructions: "", rubric,
        minWords: null, maxWords: null, isActive: true,
      });
      await setDoc(doc(db, "schools/school-a/classes/class-a/writingPerformanceTests/test-a/submissions/student-b"), {
        submittedText: "I want to be a teacher.", wordCount: 6, scoringStatus: "completed",
      });
      await setDoc(doc(db, "schools/school-b"), { schoolCode: "B" });
      await setDoc(doc(db, "schools/school-b/students/student-x"), { name: "Other school" });
      const expiresAt = ClientTimestamp.fromMillis(Date.now() + 60000);
      await setDoc(doc(db, "studentSessions/student-auth"), {
        active: true, role: "student", schoolId: "school-a", studentId: "student-a",
        studentInternalUid: "student-a", loginId: "001", expiresAt,
      });
      await setDoc(doc(db, "studentSessions/other-student-auth"), {
        active: true, role: "student", schoolId: "school-b", studentId: "student-x",
        studentInternalUid: "student-x", loginId: "001", expiresAt,
      });
      await setDoc(doc(db, "teacherSessions/teacher-auth"), {
        active: true, role: "teacher", schoolId: "school-a", teacherId: "teacher-a", expiresAt,
      });
      await setDoc(doc(db, "teacherSessions/other-teacher-auth"), {
        active: true, role: "teacher", schoolId: "school-b", teacherId: "teacher-x", expiresAt,
      });
      await setDoc(doc(db, "admins/admin-auth"), { active: true, role: "admin" });
      await setDoc(doc(db, "schoolCredentials/school-a/studentCredentials/student-a"), {
        algorithm: "scrypt", salt: "server-only", passwordHash: "server-only",
      });
    });

    const unauth = env.unauthenticatedContext().firestore();
    const student = env.authenticatedContext("student-auth").firestore();
    const teacher = env.authenticatedContext("teacher-auth").firestore();
    const otherStudent = env.authenticatedContext("other-student-auth").firestore();
    const otherTeacher = env.authenticatedContext("other-teacher-auth").firestore();
    const adminClient = env.authenticatedContext("admin-auth").firestore();
    const preview = env.authenticatedContext("preview-auth", {
      role: "teacher_preview", schoolId: "school-a", classId: "class-a",
    }).firestore();
    const testPath = "schools/school-a/classes/class-a/writingPerformanceTests/test-a";
    const ownSubmission = `${testPath}/submissions/student-a`;
    const otherSubmission = `${testPath}/submissions/student-b`;

    await denied("unauthenticated Writing test read", getDoc(doc(unauth, testPath)));
    await denied("student direct Writing test read", getDoc(doc(student, testPath)));
    await denied("teacher direct Writing test read", getDoc(doc(teacher, testPath)));
    await denied("student own submission read", getDoc(doc(student, ownSubmission)));
    await denied("student other submission read", getDoc(doc(student, otherSubmission)));
    await denied("teacher direct Writing write", setDoc(doc(teacher, testPath), { title: "forged" }, { merge: true }));
    await denied("unauthenticated teacher document read", getDoc(doc(unauth, "schools/school-a/teachers/teacher-a")));
    await denied("teacher direct password-bearing document read", getDoc(doc(teacher, "schools/school-a/teachers/teacher-a")));
    await denied("unauthenticated student document read", getDoc(doc(unauth, "schools/school-a/students/student-a")));
    await denied("other-school student document read", getDoc(doc(otherStudent, "schools/school-a/students/student-a")));
    await denied("other-school teacher document read", getDoc(doc(otherTeacher, "schools/school-a/students/student-a")));
    await denied("unauthenticated school read", getDoc(doc(unauth, "schools/school-a")));

    await assertSucceeds(updateDoc(
      doc(student, "schools/school-a/students/student-a"),
      { lastSelectedClassId: "class-a", updatedAt: serverTimestamp() },
    ));
    await denied("student changes own schoolId", updateDoc(
      doc(student, "schools/school-a/students/student-a"),
      { schoolId: "school-b" },
    ));
    await denied("student changes own role", updateDoc(
      doc(student, "schools/school-a/students/student-a"),
      { role: "admin" },
    ));
    await denied("student writes plaintext password", updateDoc(
      doc(student, "schools/school-a/students/student-a"),
      { password: "forged" },
    ));
    console.log("ok - student profile update is restricted to explicit safe fields");

    const credentialPath = "schoolCredentials/school-a/studentCredentials/student-a";
    await denied("student reads credential", getDoc(doc(student, credentialPath)));
    await denied("teacher reads credential", getDoc(doc(teacher, credentialPath)));
    await denied("student writes credential", setDoc(
      doc(student, credentialPath), { passwordHash: "forged" }, { merge: true },
    ));
    await denied("teacher writes credential", setDoc(
      doc(teacher, credentialPath), { passwordHash: "forged" }, { merge: true },
    ));
    console.log("ok - credential documents are client-inaccessible");

    await denied("unauthenticated performance log spam", setDoc(
      doc(unauth, "schools/school-a/performanceLogs/unauth"),
      { schoolId: "school-a", createdAt: serverTimestamp(), name: "spam" },
    ));
    await denied("other-school performance log spam", setDoc(
      doc(otherStudent, "schools/school-a/performanceLogs/other-school"),
      { schoolId: "school-a", createdAt: serverTimestamp(), name: "spam" },
    ));
    await assertSucceeds(setDoc(
      doc(student, "schools/school-a/performanceLogs/own"),
      {
        schoolId: "school-a", studentId: "student-a",
        createdAt: serverTimestamp(), name: "screen_load",
      },
    ));
    console.log("ok - performance logs require a matching active school session");

    await assertSucceeds(getDoc(doc(student, "schools/school-a")));
    await assertSucceeds(getDoc(doc(student, "schools/school-a/classes/class-a")));
    await assertSucceeds(getDoc(doc(student, "schools/school-a/materials/school-material")));
    await assertSucceeds(getDoc(doc(student, "schools/school-a/classes/class-a/materials/material-a")));
    await assertSucceeds(getDoc(doc(student, "schools/school-a/classes/class-a/vocabTests/vocab-a")));
    await assertSucceeds(getDoc(doc(student, "users/student-auth")));
    console.log("ok - student session permits school/class/content reads");

    await assertSucceeds(getDoc(doc(student, "schools/school-a/students/student-a")));
    await denied("student reads another student", getDoc(doc(student, "schools/school-a/students/student-b")));
    await denied("student updates another student", updateDoc(
      doc(student, "schools/school-a/students/student-b"), { updatedAt: serverTimestamp() },
    ));
    await assertSucceeds(getDoc(doc(student, "schools/school-a/students/student-a/joinedClasses/class-a")));
    await assertSucceeds(getDoc(doc(student, "schools/school-a/classes/class-a/students/student-a")));
    await assertSucceeds(getDoc(doc(student, "schools/school-a/classes/class-a/students/student-a/dailyStats/2026-08-18")));
    await assertSucceeds(getDoc(doc(student, "schools/school-a/classes/class-a/students/student-a/lessonProgress/material-a")));
    await assertSucceeds(getDoc(doc(student, "schools/school-a/classes/class-a/students/student-a/practiceResults/result-a")));
    await assertSucceeds(getDoc(doc(student, "schools/school-a/classes/class-a/materials/material-a/results/student-a")));
    await assertSucceeds(getDoc(doc(student, "schools/school-a/classes/class-a/vocabTests/vocab-a/results/student-a")));
    await assertSucceeds(getDoc(doc(student, "schools/school-a/classes/class-a/submit_boxes/box-a/submissions/submission-a")));
    await assertSucceeds(setDoc(doc(student, "schools/school-a/classes/class-a/submit_boxes/box-a/submissions/new-submission"), {
      text: "new answer", studentInternalUid: "student-a",
    }));
    await denied("student forges another student's Submit BOX submission", setDoc(
      doc(student, "schools/school-a/classes/class-a/submit_boxes/box-a/submissions/forged"),
      { text: "forged", studentInternalUid: "student-b" },
    ));
    await assertSucceeds(setDoc(
      doc(student, "schools/school-a/classes/class-a/students/student-a/dailyStats/2026-08-19"),
      { dayKey: "2026-08-19", practiceCount: 1, updatedAt: serverTimestamp() },
    ));
    await assertSucceeds(setDoc(
      doc(student, "schools/school-a/classes/class-a/materials/material-a/results/student-a"),
      { listening: 80, lastSubmittedAt: serverTimestamp() }, { merge: true },
    ));
    await assertSucceeds(setDoc(
      doc(student, "schools/school-a/classes/class-a/vocabTests/vocab-a/results/student-a"),
      { score: 8, total: 10, submittedAt: serverTimestamp() }, { merge: true },
    ));
    await assertSucceeds(updateDoc(
      doc(student, "schools/school-a/classes/class-a/students/student-a"),
      { lastPracticedAt: serverTimestamp(), updatedAt: serverTimestamp() },
    ));
    await assertSucceeds(setDoc(
      doc(student, "schools/school-a/students/student-a/joinedClasses/class-b"),
      {
        schoolId: "school-a", classId: "class-b", className: "1B",
        active: true, joinedByClassCode: true,
        joinedAt: serverTimestamp(), updatedAt: serverTimestamp(),
      },
    ));
    await assertSucceeds(setDoc(
      doc(student, "schools/school-a/classes/class-b/students/student-a"),
      {
        schoolId: "school-a", classId: "class-b", className: "1B",
        studentId: "student-a", loginId: "001",
        studentInternalUid: "student-a", internalUid: "student-a",
        studentDocId: "student-a", name: "Student A", isCurrent: true,
        membershipStatus: "active", status: "active",
        joinedByClassCode: true, joinedAt: serverTimestamp(), updatedAt: serverTimestamp(),
      },
    ));
    console.log("ok - student can access only own roster/progress/results/submission data");

    await assertSucceeds(getDoc(doc(teacher, "schools/school-a/students/student-a")));
    await assertSucceeds(getDoc(doc(teacher, "schools/school-a/classes/class-a/students/student-a")));
    await assertSucceeds(getDoc(doc(teacher, "schools/school-a/classes/class-a/materials/material-a/results/student-a")));
    await assertSucceeds(getDoc(doc(teacher, "schools/school-a/classes/class-a/vocabTests/vocab-a/results/student-a")));
    await assertSucceeds(getDoc(doc(teacher, "schools/school-a/classes/class-a/submit_boxes/box-a/submissions/submission-a")));
    console.log("ok - same-school teacher can access roster and learning results");

    await assertSucceeds(getDoc(doc(unauth, "official_materials/official-a")));
    await assertSucceeds(getDoc(doc(adminClient, "schools/school-a/teachers/teacher-a")));
    console.log("ok - curated official materials remain public");

    await assertSucceeds(getDoc(doc(preview, "schools/school-a/classes/class-a")));
    await assertSucceeds(getDoc(doc(preview, "schools/school-a/classes/class-a/materials/material-a")));
    await denied("teacher preview reads a different class", getDoc(
      doc(preview, "schools/school-a/classes/class-b/materials/material-b"),
    ));
    console.log("ok - teacher preview is restricted to its signed class claim");

    await adminDb.doc("teacherSessions/teacher-auth").set({
      active: true, role: "teacher", schoolId: "school-a", teacherId: "teacher-a",
      expiresAt: AdminTimestamp.fromMillis(Date.now() + 60000),
    });
    const created = await createWritingPerformanceTestForTeacher({
      db: adminDb,
      authUid: "teacher-auth",
      data: { classId: "class-a", title: "Function Test", prompt: "Write.", instructions: "", rubric, isActive: true },
    });
    assert(created.testId);
    console.log("ok - Admin SDK Teacher Callable logic succeeds with deny rules");

    const rows = await listWritingPerformanceSubmissionsForTeacher({
      db: adminDb, authUid: "teacher-auth", data: { classId: "class-a", testId: "test-a" },
    });
    assert.strictEqual(rows.rows.length, 2);
    console.log("ok - Admin SDK Teacher submission list succeeds");

    await saveWritingPerformanceReviewForTeacher({
      db: adminDb, authUid: "teacher-auth",
      data: {
        classId: "class-a", testId: "test-a", studentId: "student-b", teacherComment: "Reviewed",
        teacherScores: {
          content: { score: 4 }, organization: { score: 4 }, accuracy: { score: 4 },
          vocabulary: { score: 4 }, requirements: { score: 4 },
        },
      },
    });
    console.log("ok - Admin SDK Teacher review succeeds");

    await adminDb.doc("studentSessions/student-auth").set({
      active: true, role: "student", schoolId: "school-a", studentId: "student-a", studentInternalUid: "student-a", loginId: "001",
      expiresAt: AdminTimestamp.fromMillis(Date.now() + 60000),
    });
    const listed = await listWritingPerformanceTests({
      db: adminDb, authUid: "student-auth", data: { classId: "class-a" },
    });
    assert(listed.items.some((item) => item.testId === "test-a"));
    console.log("ok - Admin SDK Student list Callable logic succeeds");

    const submitted = await submitWritingPerformanceTest({
      db: adminDb, authUid: "student-auth",
      data: { classId: "class-a", testId: "test-a", submittedText: "I will study English every day." },
      apiKey: "test-key", fetchImpl: async () => scoreResponse(),
    });
    assert.strictEqual(submitted.submitted, true);
    assert.strictEqual(submitted.scoringStatus, "completed");
    console.log("ok - Admin SDK Student submit Callable logic succeeds");
  } finally {
    await env.cleanup();
    await deleteApp(adminApp);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
