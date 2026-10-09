"use strict";

const assert = require("assert");
const {
  authenticateWritingTeacher,
  acceptCopyrightGuidanceForTeacher,
  createWritingPerformanceTestForTeacher,
  copyWritingPerformanceTestForTeacher,
  deleteWritingPerformanceTestForTeacher,
  getTeacherProfileForTeacher,
  getWritingPerformanceSubmissionForTeacher,
  listWritingPerformanceSubmissionsForTeacher,
  resolveWritingTeacherSession,
  saveWritingPerformanceQuickEvaluationForTeacher,
  saveWritingPerformanceReviewForTeacher,
  setWritingPerformanceTestActiveForTeacher,
} = require("../writing_teacher");

class FakeSnap {
  constructor(ref, value) { this.ref = ref; this.id = ref.path.split("/").pop(); this.value = value; this.exists = value != null; }
  data() { return this.value; }
}
class FakeRef {
  constructor(db, path) { this.db = db; this.path = path; this.id = path.split("/").pop(); }
  collection(name) { return new FakeCollection(this.db, `${this.path}/${name}`); }
  async get() { return new FakeSnap(this, this.db.docs.get(this.path)); }
  async set(value, options) {
    this.db.docs.set(this.path, options && options.merge ? { ...(this.db.docs.get(this.path) || {}), ...value } : value);
  }
  async update(value) {
    if (!this.db.docs.has(this.path)) throw new Error("missing");
    this.db.docs.set(this.path, { ...this.db.docs.get(this.path), ...value });
  }
}
class FakeQuery {
  constructor(collection, filters = [], limitValue = null) { this.collection = collection; this.filters = filters; this.limitValue = limitValue; }
  where(key, op, value) { return new FakeQuery(this.collection, [...this.filters, [key, op, value]], this.limitValue); }
  limit(value) { return new FakeQuery(this.collection, this.filters, value); }
  async get() {
    let docs = this.collection.directDocs().filter((snap) => this.filters.every(([key, op, value]) => op === "==" && snap.data()[key] === value));
    if (this.limitValue != null) docs = docs.slice(0, this.limitValue);
    return { docs, empty: docs.length === 0 };
  }
}
class FakeCollection extends FakeQuery {
  constructor(db, path) { super(null); this.db = db; this.path = path; this.collection = this; }
  doc(id) { return new FakeRef(this.db, `${this.path}/${id || `auto-${++this.db.autoId}`}`); }
  directDocs() {
    const prefix = `${this.path}/`;
    return [...this.db.docs.entries()].filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
      .map(([path, value]) => new FakeSnap(new FakeRef(this.db, path), value));
  }
  async get() { const docs = this.directDocs(); return { docs, empty: docs.length === 0 }; }
}
class FakeDb {
  constructor(entries) { this.docs = new Map(entries); this.autoId = 0; }
  collection(name) { return new FakeCollection(this, name); }
  async recursiveDelete(ref) {
    const prefix = `${ref.path}/`;
    for (const path of [...this.docs.keys()]) {
      if (path === ref.path || path.startsWith(prefix)) this.docs.delete(path);
    }
  }
}

const rubric = {
  content: { maxScore: 4 }, organization: { maxScore: 4 }, accuracy: { maxScore: 4 },
  vocabulary: { maxScore: 4 }, requirements: { maxScore: 4 },
};
const testData = { title: "Lesson 4", prompt: "Write.", instructions: "", minWords: 10, maxWords: 30, rubric, aiTeacherInstruction: "", isActive: true };

function fixture() {
  return new FakeDb([
    ["schools/school-a", { schoolCode: "SCHOOL-A" }],
    ["writingFeatureFlags/school-a", { enabled: true }],
    ["schools/school-a/teachers/teacher-a", { name: "A先生", password: "secret", active: true }],
    ["schools/school-a/classes/class-a", { name: "1A" }],
    ["schools/school-a/classes/class-c", { className: "1C" }],
    ["schools/school-a/students/student-a", { name: "生徒A", loginId: "001", grade: "1", class: "2", number: "1", classIds: ["class-a"] }],
    ["schools/school-a/classes/class-a/students/student-a", { studentInternalUid: "student-a", grade: "1", class: "2", number: "1" }],
    ["schools/school-b", { schoolCode: "SCHOOL-B" }],
    ["schools/school-b/teachers/teacher-b", { name: "B先生", password: "secret-b", active: true }],
    ["schools/school-b/classes/class-b", { name: "2B" }],
  ]);
}

function teacherSession() {
  return { active: true, role: "teacher", schoolId: "school-a", teacherId: "teacher-a", expiresAt: { toMillis: () => Date.now() + 60000 } };
}

async function test(name, fn) {
  try { await fn(); console.log(`ok - ${name}`); }
  catch (error) { console.error(`not ok - ${name}`); throw error; }
}

(async () => {
  await test("unauthenticated or sessionless teacher operation is rejected", async () => {
    await assert.rejects(() => resolveWritingTeacherSession({ db: fixture(), authUid: "anonymous-no-session" }), /権限/);
  });

  await test("teacher authentication creates a server-verified school session", async () => {
    const db = fixture();
    const result = await authenticateWritingTeacher({ db, authUid: "auth-a", data: { schoolCode: "SCHOOL-A", teacherId: "teacher-a", password: "secret" } });
    assert.strictEqual(result.schoolId, "school-a");
    assert.strictEqual(db.docs.get("teacherSessions/auth-a").teacherId, "teacher-a");
    await assert.rejects(() => authenticateWritingTeacher({ db, authUid: "bad", data: { schoolCode: "SCHOOL-A", teacherId: "teacher-a", password: "wrong" } }), /正しくありません/);
  });

  await test("teacher profile exposes Writing as a standard feature", async () => {
    const db = fixture();
    db.docs.set("teacherSessions/auth-a", teacherSession());
    const result = await getTeacherProfileForTeacher({ db, authUid: "auth-a" });
    assert.strictEqual(result.schoolId, "school-a");
    assert.strictEqual(result.writingEnabled, true);
  });

  await test("teacher profile ignores a legacy disabled Writing flag", async () => {
    const db = fixture();
    db.docs.set("writingFeatureFlags/school-a", { enabled: false });
    db.docs.set("teacherSessions/auth-a", teacherSession());
    const result = await getTeacherProfileForTeacher({ db, authUid: "auth-a" });
    assert.strictEqual(result.writingEnabled, true);
  });

  await test("teacher accepts versioned copyright guidance once per policy", async () => {
    const db = fixture();
    db.docs.set("teacherSessions/auth-a", teacherSession());
    const accepted = await acceptCopyrightGuidanceForTeacher({
      db,
      authUid: "auth-a",
    });
    const stored = db.docs.get("schools/school-a/teachers/teacher-a");
    assert.strictEqual(accepted.copyrightGuidanceVersion, "2026-10-09");
    assert.strictEqual(stored.copyrightGuidanceVersion, "2026-10-09");
    assert.ok(Number.isFinite(stored.copyrightGuidanceAcceptedAtMillis));
    const profile = await getTeacherProfileForTeacher({
      db,
      authUid: "auth-a",
    });
    assert.strictEqual(profile.copyrightGuidanceVersion, "2026-10-09");
  });

  await test("same-school teacher creates and publishes a test", async () => {
    const db = fixture();
    await authenticateWritingTeacher({ db, authUid: "auth-a", data: { schoolCode: "SCHOOL-A", teacherId: "teacher-a", password: "secret" } });
    const created = await createWritingPerformanceTestForTeacher({ db, authUid: "auth-a", data: { classId: "class-a", ...testData, evaluationLevel: "advanced", showEvaluationToStudents: true, showProvisionalEvaluationToStudents: false } });
    const path = `schools/school-a/classes/class-a/writingPerformanceTests/${created.testId}`;
    assert.strictEqual(db.docs.get(path).schoolId, "school-a");
    assert.strictEqual(db.docs.get(path).createdBy, "teacher-a");
    assert.strictEqual(db.docs.get(path).evaluationLevel, "advanced");
    assert.strictEqual(db.docs.get(path).showEvaluationToStudents, true);
    assert.strictEqual(db.docs.get(path).showProvisionalEvaluationToStudents, false);
    await setWritingPerformanceTestActiveForTeacher({ db, authUid: "auth-a", data: { classId: "class-a", testId: created.testId, isActive: false } });
    assert.strictEqual(db.docs.get(path).isActive, false);
  });

  await test("same-school teacher deletes a test and all of its submissions", async () => {
    const db = fixture();
    db.docs.set("teacherSessions/auth-a", teacherSession());
    const testPath = "schools/school-a/classes/class-a/writingPerformanceTests/test-delete";
    db.docs.set(testPath, testData);
    db.docs.set(`${testPath}/submissions/student-a`, { submittedText: "I write." });
    const result = await deleteWritingPerformanceTestForTeacher({
      db,
      authUid: "auth-a",
      data: { classId: "class-a", testId: "test-delete" },
    });
    assert.strictEqual(result.deleted, true);
    assert.strictEqual(db.docs.has(testPath), false);
    assert.strictEqual(db.docs.has(`${testPath}/submissions/student-a`), false);
  });

  await test("same-school teacher copies only test settings as an unpublished test", async () => {
    const db = fixture();
    db.docs.set("teacherSessions/auth-a", teacherSession());
    const sourcePath = "schools/school-a/classes/class-a/writingPerformanceTests/test-copy";
    db.docs.set(sourcePath, { ...testData, evaluationLevel: "standard", showEvaluationToStudents: false, showProvisionalEvaluationToStudents: true });
    db.docs.set(`${sourcePath}/submissions/student-a`, { submittedText: "Do not copy." });
    const result = await copyWritingPerformanceTestForTeacher({
      db,
      authUid: "auth-a",
      data: { sourceClassId: "class-a", testId: "test-copy", targetClassIds: ["class-c"] },
    });
    assert.strictEqual(result.copied.length, 1);
    const copiedPath = `schools/school-a/classes/class-c/writingPerformanceTests/${result.copied[0].testId}`;
    assert.strictEqual(db.docs.get(copiedPath).title, testData.title);
    assert.strictEqual(db.docs.get(copiedPath).isActive, false);
    assert.strictEqual(db.docs.get(copiedPath).copiedFromTestId, "test-copy");
    assert.strictEqual(db.docs.get(copiedPath).showEvaluationToStudents, false);
    assert.strictEqual(db.docs.get(copiedPath).showProvisionalEvaluationToStudents, false);
    assert.strictEqual(db.docs.has(`${copiedPath}/submissions/student-a`), false);
  });

  await test("teacher cannot copy a Writing test to another school's class", async () => {
    const db = fixture();
    db.docs.set("teacherSessions/auth-a", teacherSession());
    db.docs.set("schools/school-a/classes/class-a/writingPerformanceTests/test-copy", testData);
    await assert.rejects(
      () => copyWritingPerformanceTestForTeacher({
        db,
        authUid: "auth-a",
        data: { sourceClassId: "class-a", testId: "test-copy", targetClassIds: ["class-b"] },
      }),
      /対象クラス/,
    );
  });

  await test("teacher cannot delete another school's Writing test", async () => {
    const db = fixture();
    db.docs.set("teacherSessions/auth-a", teacherSession());
    db.docs.set("schools/school-b/classes/class-b/writingPerformanceTests/test-b", testData);
    await assert.rejects(
      () => deleteWritingPerformanceTestForTeacher({
        db,
        authUid: "auth-a",
        data: { classId: "class-b", testId: "test-b" },
      }),
      /対象クラス/,
    );
  });

  await test("teacher cannot access another school's class or submission", async () => {
    const db = fixture();
    await authenticateWritingTeacher({ db, authUid: "auth-a", data: { schoolCode: "SCHOOL-A", teacherId: "teacher-a", password: "secret" } });
    await assert.rejects(() => getWritingPerformanceSubmissionForTeacher({ db, authUid: "auth-a", data: { classId: "class-b", testId: "test-b", studentId: "student-b" } }), /対象クラス/);
  });

  await test("teacher detail exposes saved evaluation explanations without rescoring", async () => {
    const db = fixture();
    db.docs.set("teacherSessions/auth-a", teacherSession());
    const testPath = "schools/school-a/classes/class-a/writingPerformanceTests/test-a";
    db.docs.set(testPath, testData);
    db.docs.set(`${testPath}/submissions/student-a`, {
      submittedText: "I want be a teacher.",
      wordCount: 5,
      scoringStatus: "completed",
      aiTotalScore: 15,
      deductions: [{ criterion: "accuracy", pointsLost: 1 }],
      strengths: [{ criterion: "content", textJa: "課題に答えています。" }],
      suggestions: [{ suggestion: "I want to become a teacher.", scoreImpact: false }],
    });

    const result = await getWritingPerformanceSubmissionForTeacher({
      db,
      authUid: "auth-a",
      data: { classId: "class-a", testId: "test-a", studentId: "student-a" },
    });

    assert.strictEqual(result.submission.deductions.length, 1);
    assert.strictEqual(result.submission.strengths.length, 1);
    assert.strictEqual(result.submission.suggestions[0].scoreImpact, false);
  });

  await test("submission list includes roster non-submitters and submitted students", async () => {
    const db = fixture();
    db.docs.set("teacherSessions/auth-a", teacherSession());
    db.docs.set("schools/school-a/classes/class-a/writingPerformanceTests/test-a", testData);
    db.docs.set("schools/school-a/classes/class-a/writingPerformanceTests/test-a/submissions/student-a", {
      submittedText: "I write.",
      wordCount: 2,
      scoringStatus: "completed",
      aiTotalScore: 15,
      speakingChallenge: {
        sourceType: "writingPerformance",
        referenceScript: "I write.",
        completed: true,
        relearningCompleted: true,
        attemptCount: 2,
        schemaVersion: 2,
        latest: {
          recognizedText: "I",
          accuracy: 50,
          wpm: 30,
          durationMs: 2000,
          performedAtMillis: 2000,
        },
        best: {
          recognizedText: "I write",
          accuracy: 100,
          wpm: 60,
          durationMs: 2000,
          performedAtMillis: 1000,
        },
        updatedAtMillis: 2000,
      },
    });
    const result = await listWritingPerformanceSubmissionsForTeacher({ db, authUid: "auth-a", data: { classId: "class-a", testId: "test-a" } });
    assert.strictEqual(result.rows.length, 1);
    assert.strictEqual(result.rows[0].submitted, true);
    assert.strictEqual(result.rows[0].aiTotalScore, 15);
    assert.strictEqual(result.rows[0].grade, "1");
    assert.strictEqual(result.rows[0].class, "2");
    assert.strictEqual(result.rows[0].number, "1");
    assert.strictEqual(result.rows[0].speakingChallenge.accuracy, 50);
    assert.strictEqual(result.rows[0].speakingChallenge.recognizedText, "I");
    assert.strictEqual(result.rows[0].speakingChallenge.best.accuracy, 100);
    assert.strictEqual(result.rows[0].speakingChallenge.best.wpm, 60);
    assert.strictEqual(result.rows[0].speakingChallenge.best.recognizedText, "I write");
  });

  await test("submission list uses current grade class and number instead of stale internal IDs", async () => {
    const db = fixture();
    db.docs.set("teacherSessions/auth-a", teacherSession());
    db.docs.set("schools/school-a/classes/class-a/writingPerformanceTests/test-a", testData);
    db.docs.delete("schools/school-a/classes/class-a/students/student-a");
    for (const student of [
      { id: "1_1_12", grade: "2", class: "3", number: "5" },
      { id: "1_3_01", grade: "2", class: "2", number: "30" },
      { id: "1_2_02", grade: "2", class: "2", number: "4" },
    ]) {
      db.docs.set(`schools/school-a/students/${student.id}`, {
        name: student.id,
        grade: student.grade,
        class: student.class,
        number: student.number,
        classIds: ["class-a"],
      });
      db.docs.set(`schools/school-a/classes/class-a/students/${student.id}`, {
        studentInternalUid: student.id,
        grade: student.grade,
        class: student.class,
        number: student.number,
      });
    }

    const result = await listWritingPerformanceSubmissionsForTeacher({
      db,
      authUid: "auth-a",
      data: { classId: "class-a", testId: "test-a" },
    });

    assert.deepStrictEqual(
      result.rows.map((row) => row.studentId),
      ["1_2_02", "1_3_01", "1_1_12"],
    );
  });

  await test("teacher review preserves AI and submission fields and only saves teacher evaluation", async () => {
    const db = fixture();
    db.docs.set("teacherSessions/auth-a", teacherSession());
    db.docs.set("schools/school-a/classes/class-a/writingPerformanceTests/test-a", testData);
    const path = "schools/school-a/classes/class-a/writingPerformanceTests/test-a/submissions/student-a";
    db.docs.set(path, { submittedText: "I write.", aiScores: { content: { score: 3 } }, aiTotalScore: 15, scoringStatus: "completed" });
    const scores = { content: { score: 4 }, organization: { score: 3 }, accuracy: { score: 2 }, vocabulary: { score: 3 }, requirements: { score: 4 } };
    const result = await saveWritingPerformanceReviewForTeacher({ db, authUid: "auth-a", data: { classId: "class-a", testId: "test-a", studentId: "student-a", teacherScores: scores, teacherComment: "確認済み", aiScores: { content: { score: 0 } } } });
    const saved = db.docs.get(path);
    const evaluation = db.docs.get("schools/school-a/classes/class-a/writingPerformanceTests/test-a/evaluations/student-a");
    assert.strictEqual(result.teacherTotalScore, 16);
    assert.strictEqual(saved.aiTotalScore, 15);
    assert.strictEqual(saved.aiScores.content.score, 3);
    assert.strictEqual(saved.submittedText, "I write.");
    assert.strictEqual(saved.teacherScores, undefined);
    assert.strictEqual(evaluation.teacherScores.content.score, 4);
    assert.strictEqual(evaluation.teacherComment, "確認済み");
    assert.strictEqual(evaluation.evaluationMethod, "teacher_adjusted");
  });

  await test("teacher can save an independent manual final score for a non-submitter", async () => {
    const db = fixture();
    db.docs.set("teacherSessions/auth-a", teacherSession());
    const testPath = "schools/school-a/classes/class-a/writingPerformanceTests/test-a";
    db.docs.set(testPath, { ...testData, totalPoints: 20 });

    const saved = await saveWritingPerformanceQuickEvaluationForTeacher({
      db,
      authUid: "auth-a",
      data: {
        classId: "class-a",
        testId: "test-a",
        studentId: "student-a",
        finalScore: 6,
      },
    });

    assert.strictEqual(saved.submitted, false);
    assert.strictEqual(saved.evaluationMethod, "manual");
    assert.strictEqual(db.docs.has(`${testPath}/submissions/student-a`), false);
    assert.strictEqual(
      db.docs.get(`${testPath}/evaluations/student-a`).finalScore,
      6,
    );
    const list = await listWritingPerformanceSubmissionsForTeacher({
      db,
      authUid: "auth-a",
      data: { classId: "class-a", testId: "test-a" },
    });
    assert.strictEqual(list.rows[0].submitted, false);
    assert.strictEqual(list.rows[0].teacherTotalScore, 6);
    assert.strictEqual(list.rows[0].evaluationMethod, "manual");
  });

  await test("manual final score accepts a legacy roster keyed by login ID", async () => {
    const db = fixture();
    db.docs.set("teacherSessions/auth-a", teacherSession());
    const testPath = "schools/school-a/classes/class-a/writingPerformanceTests/test-a";
    db.docs.set(testPath, { ...testData, totalPoints: 20 });
    db.docs.delete("schools/school-a/classes/class-a/students/student-a");
    db.docs.set("schools/school-a/classes/class-a/students/001", {
      studentInternalUid: "student-a",
      grade: "1",
      class: "2",
      number: "1",
    });
    db.docs.set("schools/school-a/students/student-a", {
      name: "生徒A",
      loginId: "001",
    });

    const saved = await saveWritingPerformanceQuickEvaluationForTeacher({
      db,
      authUid: "auth-a",
      data: {
        classId: "class-a",
        testId: "test-a",
        studentId: "student-a",
        finalScore: 6,
      },
    });

    assert.strictEqual(saved.submitted, false);
    assert.strictEqual(saved.evaluationMethod, "manual");
  });

  await test("quick final score derives AI confirmed and teacher adjusted methods", async () => {
    const db = fixture();
    db.docs.set("teacherSessions/auth-a", teacherSession());
    const testPath = "schools/school-a/classes/class-a/writingPerformanceTests/test-a";
    db.docs.set(testPath, { ...testData, totalPoints: 20 });
    db.docs.set(`${testPath}/submissions/student-a`, {
      submittedText: "I write.",
      aiTotalScore: 7,
    });

    const confirmed = await saveWritingPerformanceQuickEvaluationForTeacher({
      db,
      authUid: "auth-a",
      data: { classId: "class-a", testId: "test-a", studentId: "student-a", finalScore: 7 },
    });
    assert.strictEqual(confirmed.evaluationMethod, "ai_confirmed");
    const adjusted = await saveWritingPerformanceQuickEvaluationForTeacher({
      db,
      authUid: "auth-a",
      data: { classId: "class-a", testId: "test-a", studentId: "student-a", finalScore: 6 },
    });
    assert.strictEqual(adjusted.evaluationMethod, "teacher_adjusted");

    const reloadedList = await listWritingPerformanceSubmissionsForTeacher({
      db,
      authUid: "auth-a",
      data: { classId: "class-a", testId: "test-a" },
    });
    assert.strictEqual(reloadedList.rows[0].teacherTotalScore, 6);
    assert.strictEqual(reloadedList.rows[0].evaluationMethod, "teacher_adjusted");
    assert.strictEqual(reloadedList.rows[0].aiTotalScore, 7);

    const reloadedDetail = await getWritingPerformanceSubmissionForTeacher({
      db,
      authUid: "auth-a",
      data: { classId: "class-a", testId: "test-a", studentId: "student-a" },
    });
    assert.strictEqual(reloadedDetail.submission.teacherTotalScore, 6);
    assert.strictEqual(reloadedDetail.submission.evaluationMethod, "teacher_adjusted");
    assert.strictEqual(reloadedDetail.submission.aiTotalScore, 7);
  });

  await test("quick final score rejects out-of-range values", async () => {
    const db = fixture();
    db.docs.set("teacherSessions/auth-a", teacherSession());
    db.docs.set(
      "schools/school-a/classes/class-a/writingPerformanceTests/test-a",
      { ...testData, totalPoints: 20 },
    );
    await assert.rejects(
      () => saveWritingPerformanceQuickEvaluationForTeacher({
        db,
        authUid: "auth-a",
        data: { classId: "class-a", testId: "test-a", studentId: "student-a", finalScore: 21 },
      }),
      /0〜20点/,
    );
  });

  console.log("All writing teacher tests passed.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
