"use strict";

const crypto = require("crypto");
const { FieldValue, Timestamp } = require("firebase-admin/firestore");
const { WritingAccessError, cleanId, cleanPassword } = require("./writing_access");
const {
  RUBRIC_KEYS,
  publicSpeakingChallenge,
  validatePerformanceTestData,
} = require("./writing_performance");

const TEACHER_SESSION_COLLECTION = "teacherSessions";
const TEACHER_SESSION_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TEACHER_SESSION_ABSOLUTE_TTL_MS = 60 * 24 * 60 * 60 * 1000;
const COPYRIGHT_GUIDANCE_VERSION = "2026-10-09";

function passwordsMatch(actual, expected) {
  const left = Buffer.from(String(actual || ""));
  const right = Buffer.from(String(expected || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function credentialFingerprint(password) {
  return crypto.createHash("sha256").update(String(password || "")).digest("hex");
}

async function authenticateWritingTeacher({ db, authUid, data }) {
  const uid = cleanId(authUid, "認証UID");
  const schoolCode = cleanId(data && data.schoolCode, "学校ID");
  const teacherId = cleanId(data && data.teacherId, "Teacher ID");
  const password = cleanPassword(data && data.password);
  const schools = await db.collection("schools")
    .where("schoolCode", "==", schoolCode).limit(2).get();
  if (schools.empty || schools.docs.length !== 1) {
    throw new WritingAccessError("permission-denied", "学校ID、Teacher ID、またはパスワードが正しくありません。");
  }
  const school = schools.docs[0];
  const teacherSnap = await school.ref.collection("teachers").doc(teacherId).get();
  const teacher = teacherSnap.exists ? teacherSnap.data() : null;
  if (!teacher || teacher.active === false || !passwordsMatch(password, teacher.password)) {
    throw new WritingAccessError("permission-denied", "学校ID、Teacher ID、またはパスワードが正しくありません。");
  }
  const now = FieldValue.serverTimestamp();
  const authenticatedAtMillis = Date.now();
  const sessionExpiresAtMillis = authenticatedAtMillis + TEACHER_SESSION_IDLE_TTL_MS;
  const absoluteExpiresAtMillis = authenticatedAtMillis + TEACHER_SESSION_ABSOLUTE_TTL_MS;
  await db.collection(TEACHER_SESSION_COLLECTION).doc(uid).set({
    active: true,
    role: "teacher",
    schoolId: school.id,
    teacherId,
    expiresAt: Timestamp.fromMillis(sessionExpiresAtMillis),
    absoluteExpiresAt: Timestamp.fromMillis(absoluteExpiresAtMillis),
    credentialFingerprint: credentialFingerprint(teacher.password),
    createdAt: now,
    updatedAt: now,
  }, { merge: true });
  return {
    ok: true,
    schoolId: school.id,
    teacherId,
    teacherName: String(teacher.name || ""),
    sessionExpiresAtMillis,
  };
}

async function resolveWritingTeacherSession({ db, authUid }) {
  const uid = cleanId(authUid, "認証UID");
  const sessionSnap = await db.collection(TEACHER_SESSION_COLLECTION).doc(uid).get();
  const session = sessionSnap.exists ? sessionSnap.data() : null;
  const expiresAt = session && session.expiresAt;
  const expiresAtMillis = expiresAt && typeof expiresAt.toMillis === "function"
    ? expiresAt.toMillis()
    : 0;
  const absoluteExpiresAtMillis = session?.absoluteExpiresAt?.toMillis?.() || 0;
  if (!session || session.active !== true || session.role !== "teacher" ||
      expiresAtMillis <= Date.now() ||
      (absoluteExpiresAtMillis > 0 && absoluteExpiresAtMillis <= Date.now())) {
    throw new WritingAccessError("permission-denied", "教師用Writing操作の権限がありません。");
  }
  const schoolId = cleanId(session.schoolId, "schoolId");
  const teacherId = cleanId(session.teacherId, "teacherId");
  const teacherSnap = await db.collection("schools").doc(schoolId)
    .collection("teachers").doc(teacherId).get();
  if (!teacherSnap.exists || teacherSnap.data().active === false ||
      (session.credentialFingerprint &&
       session.credentialFingerprint !== credentialFingerprint(teacherSnap.data().password))) {
    throw new WritingAccessError("permission-denied", "教師用Writing操作の権限がありません。");
  }
  return { authUid: uid, schoolId, teacherId };
}

async function refreshWritingTeacherSession({ db, authUid }) {
  const session = await resolveWritingTeacherSession({ db, authUid });
  const sessionRef = db.collection(TEACHER_SESSION_COLLECTION).doc(session.authUid);
  const snap = await sessionRef.get();
  const current = snap.data() || {};
  const nowMillis = Date.now();
  const storedAbsolute = current.absoluteExpiresAt?.toMillis?.() || 0;
  const absoluteExpiresAtMillis = storedAbsolute > nowMillis
    ? storedAbsolute
    : nowMillis + TEACHER_SESSION_ABSOLUTE_TTL_MS;
  const sessionExpiresAtMillis = Math.min(
    nowMillis + TEACHER_SESSION_IDLE_TTL_MS,
    absoluteExpiresAtMillis
  );
  const teacherSnap = await db.collection("schools").doc(session.schoolId)
    .collection("teachers").doc(session.teacherId).get();
  await sessionRef.set({
    expiresAt: Timestamp.fromMillis(sessionExpiresAtMillis),
    absoluteExpiresAt: Timestamp.fromMillis(absoluteExpiresAtMillis),
    credentialFingerprint: credentialFingerprint(teacherSnap.data().password),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return { ok: true, sessionExpiresAtMillis };
}

async function getTeacherProfileForTeacher({ db, authUid }) {
  const session = await resolveWritingTeacherSession({ db, authUid });
  const snap = await db.collection("schools").doc(session.schoolId)
    .collection("teachers").doc(session.teacherId).get();
  const teacher = snap.data();
  return {
    schoolId: session.schoolId,
    teacherId: session.teacherId,
    teacherName: String(teacher.name || ""),
    isAdmin: teacher.isAdmin === true,
    copyrightGuidanceAcceptedAtMillis: timestampMillis(
      teacher.copyrightGuidanceAcceptedAt
    ),
    copyrightGuidanceVersion: String(
      teacher.copyrightGuidanceVersion || ""
    ),
    // Kept for compatibility with older Teacher Dashboard builds.
    writingEnabled: true,
  };
}

async function acceptCopyrightGuidanceForTeacher({ db, authUid }) {
  const session = await resolveWritingTeacherSession({ db, authUid });
  const acceptedAtMillis = Date.now();
  await db.collection("schools").doc(session.schoolId)
    .collection("teachers").doc(session.teacherId).set({
      copyrightGuidanceAcceptedAt: FieldValue.serverTimestamp(),
      copyrightGuidanceAcceptedAtMillis: acceptedAtMillis,
      copyrightGuidanceVersion: COPYRIGHT_GUIDANCE_VERSION,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  return {
    ok: true,
    copyrightGuidanceAcceptedAtMillis: acceptedAtMillis,
    copyrightGuidanceVersion: COPYRIGHT_GUIDANCE_VERSION,
  };
}

async function teacherClassRef({ db, session, classId }) {
  const id = cleanId(classId, "classId");
  const ref = db.collection("schools").doc(session.schoolId).collection("classes").doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new WritingAccessError("permission-denied", "対象クラスを利用できません。");
  return { classId: id, classRef: ref };
}

function timestampMillis(value) {
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return null;
}

function teacherTestData(doc) {
  const raw = doc.data();
  const test = validatePerformanceTestData(raw);
  return {
    testId: doc.id,
    ...test,
    aiTeacherInstruction: test.aiTeacherInstruction,
    isActive: raw.isActive === true,
    createdBy: String(raw.createdBy || ""),
    createdAt: timestampMillis(raw.createdAt),
    updatedAt: timestampMillis(raw.updatedAt),
  };
}

async function createWritingPerformanceTestForTeacher({ db, authUid, data }) {
  const session = await resolveWritingTeacherSession({ db, authUid });
  const { classId, classRef } = await teacherClassRef({ db, session, classId: data && data.classId });
  const test = validatePerformanceTestData(data);
  const ref = classRef.collection("writingPerformanceTests").doc();
  await ref.set({
    ...test,
    schoolId: session.schoolId,
    classId,
    isActive: data && data.isActive === true,
    createdBy: session.teacherId,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    schemaVersion: 1,
  });
  return { testId: ref.id };
}

async function listWritingPerformanceTestsForTeacher({ db, authUid, data }) {
  const session = await resolveWritingTeacherSession({ db, authUid });
  const { classRef } = await teacherClassRef({ db, session, classId: data && data.classId });
  const snap = await classRef.collection("writingPerformanceTests").get();
  const items = snap.docs.map(teacherTestData)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return { items };
}

async function listWritingClassesForTeacher({ db, authUid }) {
  const session = await resolveWritingTeacherSession({ db, authUid });
  const snap = await db.collection("schools").doc(session.schoolId)
    .collection("classes").get();
  const items = snap.docs.map((doc) => {
    const value = doc.data() || {};
    return {
      classId: doc.id,
      className: String(value.className || value.name || doc.id),
    };
  }).sort((a, b) => a.className.localeCompare(b.className, "ja", { numeric: true }));
  return { items };
}

async function copyWritingPerformanceTestForTeacher({ db, authUid, data }) {
  const session = await resolveWritingTeacherSession({ db, authUid });
  const { classRef: sourceClassRef } = await teacherClassRef({
    db,
    session,
    classId: data && data.sourceClassId,
  });
  const sourceTestId = cleanId(data && data.testId, "testId");
  const rawTargetIds = data && data.targetClassIds;
  if (!Array.isArray(rawTargetIds) || rawTargetIds.length === 0) {
    throw new WritingAccessError("invalid-argument", "コピー先クラスを選択してください。");
  }
  const targetIds = [...new Set(rawTargetIds.map((id) => cleanId(id, "コピー先classId")))];
  if (targetIds.includes(sourceClassRef.id)) {
    throw new WritingAccessError("invalid-argument", "現在のクラスにはコピーできません。");
  }
  const sourceTestSnap = await sourceClassRef.collection("writingPerformanceTests")
    .doc(sourceTestId).get();
  if (!sourceTestSnap.exists) {
    throw new WritingAccessError("not-found", "コピー元の課題が見つかりません。");
  }
  const sourceTest = validatePerformanceTestData(sourceTestSnap.data());
  const copied = [];
  for (const targetClassId of targetIds) {
    const { classRef } = await teacherClassRef({ db, session, classId: targetClassId });
    const ref = classRef.collection("writingPerformanceTests").doc();
    await ref.set({
      ...sourceTest,
      schoolId: session.schoolId,
      classId: targetClassId,
      isActive: false,
      createdBy: session.teacherId,
      copiedFromClassId: sourceClassRef.id,
      copiedFromTestId: sourceTestId,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      schemaVersion: 1,
    });
    copied.push({ classId: targetClassId, testId: ref.id });
  }
  return { copied };
}

async function setWritingPerformanceTestActiveForTeacher({ db, authUid, data }) {
  const session = await resolveWritingTeacherSession({ db, authUid });
  const { classRef } = await teacherClassRef({ db, session, classId: data && data.classId });
  const testId = cleanId(data && data.testId, "testId");
  if (typeof (data && data.isActive) !== "boolean") {
    throw new WritingAccessError("invalid-argument", "公開状態が不正です。");
  }
  const ref = classRef.collection("writingPerformanceTests").doc(testId);
  const snap = await ref.get();
  if (!snap.exists) throw new WritingAccessError("not-found", "対象テストが見つかりません。");
  await ref.update({ isActive: data.isActive, updatedAt: FieldValue.serverTimestamp() });
  return { testId, isActive: data.isActive };
}

async function deleteWritingPerformanceTestForTeacher({ db, authUid, data }) {
  const session = await resolveWritingTeacherSession({ db, authUid });
  const { classRef } = await teacherClassRef({
    db,
    session,
    classId: data && data.classId,
  });
  const testId = cleanId(data && data.testId, "testId");
  const testRef = classRef.collection("writingPerformanceTests").doc(testId);
  const testSnap = await testRef.get();
  if (!testSnap.exists) {
    throw new WritingAccessError("not-found", "対象テストが見つかりません。");
  }

  // Delete the test and every submission/review beneath it. The Admin SDK
  // bypasses client Rules, so the verified teacher session and class lookup
  // above are mandatory before this destructive operation.
  await db.recursiveDelete(testRef);
  return { testId, deleted: true };
}

function studentFromDocs(id, schoolData, classData) {
  const data = { ...(schoolData || {}), ...(classData || {}) };
  const parsed = String(id).match(/^(\d+)[_-](\d+)[_-](\d+)$/);
  return {
    studentId: id,
    displayId: String(data.loginId || data.studentId || id),
    name: String(data.name || data.studentName || id),
    grade: String(data.grade || (parsed && parsed[1]) || ""),
    class: String(data.class || data.classLabel || (parsed && parsed[2]) || ""),
    number: String(data.number || data.studentNumber || data.seatNo || (parsed && parsed[3]) || ""),
  };
}

async function classRoster({ db, session, classId, classRef }) {
  const [schoolStudents, classStudents] = await Promise.all([
    db.collection("schools").doc(session.schoolId).collection("students").get(),
    classRef.collection("students").get(),
  ]);
  const schoolById = new Map(schoolStudents.docs.map((doc) => [doc.id, doc.data()]));
  if (!classStudents.empty) {
    return classStudents.docs.map((doc) => {
      const id = String(doc.data().studentInternalUid || doc.id);
      return studentFromDocs(id, schoolById.get(id), doc.data());
    });
  }
  return schoolStudents.docs.filter((doc) => {
    const value = doc.data();
    const ids = [value.classId, value.currentClassId,
      ...(Array.isArray(value.classIds) ? value.classIds : []),
      ...(Array.isArray(value.enrolledClassIds) ? value.enrolledClassIds : [])].map(String);
    return ids.includes(classId);
  }).map((doc) => studentFromDocs(doc.id, doc.data(), null));
}

function submissionSummary(student, snap) {
  const value = snap && snap.exists ? snap.data() : null;
  return {
    ...student,
    submitted: Boolean(value),
    wordCount: value ? Number(value.wordCount || 0) : null,
    scoringStatus: value ? String(value.scoringStatus || "pending") : null,
    aiTotalScore: value && Number.isFinite(value.aiTotalScore) ? value.aiTotalScore : null,
    aiScores: value ? value.aiScores || null : null,
    teacherTotalScore: value && Number.isFinite(value.teacherTotalScore) ? value.teacherTotalScore : null,
    teacherScores: value ? value.teacherScores || null : null,
    submittedAt: value ? timestampMillis(value.submittedAt) : null,
    speakingChallenge: value
      ? publicSpeakingChallenge(value.speakingChallenge)
      : null,
  };
}

const EVALUATION_METHODS = new Set([
  "ai_confirmed",
  "teacher_adjusted",
  "manual",
]);

function derivedEvaluationMethod(aiTotalScore, finalScore) {
  if (!Number.isFinite(finalScore)) return null;
  if (!Number.isFinite(aiTotalScore)) return "manual";
  return aiTotalScore === finalScore ? "ai_confirmed" : "teacher_adjusted";
}

function rubricScoresEqual(aiScores, teacherScores) {
  if (!aiScores || !teacherScores) return false;
  return RUBRIC_KEYS.every((key) => {
    const aiScore = Number(aiScores[key]?.score);
    const teacherScore = Number(teacherScores[key]?.score);
    return Number.isInteger(aiScore) && aiScore === teacherScore;
  });
}

function mergedEvaluation(submissionValue, evaluationValue) {
  const oldFinalScore = Number.isFinite(submissionValue?.teacherTotalScore)
    ? submissionValue.teacherTotalScore
    : null;
  const finalScore = Number.isFinite(evaluationValue?.finalScore)
    ? evaluationValue.finalScore
    : oldFinalScore;
  const storedMethod = String(evaluationValue?.evaluationMethod || "");
  const evaluationMethod = EVALUATION_METHODS.has(storedMethod)
    ? storedMethod
    : derivedEvaluationMethod(submissionValue?.aiTotalScore, finalScore);
  return {
    finalScore,
    teacherTotalScore: finalScore,
    teacherScores: evaluationValue?.scoreOnly === true
      ? null
      : (evaluationValue?.teacherScores || submissionValue?.teacherScores || null),
    teacherComment: String(
      evaluationValue?.teacherComment ?? submissionValue?.teacherComment ?? ""
    ),
    evaluationMethod,
    finalizedAt: timestampMillis(
      evaluationValue?.finalizedAt || submissionValue?.reviewedAt
    ),
    finalizedBy: String(
      evaluationValue?.finalizedBy || submissionValue?.reviewedBy || ""
    ),
  };
}

function submissionSummaryWithEvaluation(student, submissionSnap, evaluationSnap) {
  const summary = submissionSummary(student, submissionSnap);
  const submissionValue = submissionSnap?.exists ? submissionSnap.data() : null;
  const evaluationValue = evaluationSnap?.exists ? evaluationSnap.data() : null;
  return {
    ...summary,
    ...mergedEvaluation(submissionValue, evaluationValue),
  };
}

async function listWritingPerformanceSubmissionsForTeacher({ db, authUid, data }) {
  const session = await resolveWritingTeacherSession({ db, authUid });
  const { classId, classRef } = await teacherClassRef({ db, session, classId: data && data.classId });
  const testId = cleanId(data && data.testId, "testId");
  const testRef = classRef.collection("writingPerformanceTests").doc(testId);
  const testSnap = await testRef.get();
  if (!testSnap.exists) throw new WritingAccessError("not-found", "対象テストが見つかりません。");
  const [students, submissions, evaluations] = await Promise.all([
    classRoster({ db, session, classId, classRef }),
    testRef.collection("submissions").get(),
    testRef.collection("evaluations").get(),
  ]);
  const byStudent = new Map(submissions.docs.map((doc) => [doc.id, doc]));
  const evaluationByStudent = new Map(
    evaluations.docs.map((doc) => [doc.id, doc])
  );
  const rows = students.map((student) => submissionSummaryWithEvaluation(
    student,
    byStudent.get(student.studentId),
    evaluationByStudent.get(student.studentId)
  ))
    .sort((a, b) => compareRosterOrder(a, b));
  return { test: teacherTestData(testSnap), rows };
}

function compareRosterOrder(a, b) {
  for (const key of ["grade", "class", "number"]) {
    const aValue = String(a[key] || "");
    const bValue = String(b[key] || "");
    if (!aValue && bValue) return 1;
    if (aValue && !bValue) return -1;
    const result = aValue.localeCompare(bValue, "ja", { numeric: true });
    if (result !== 0) return result;
  }
  return String(a.name || "").localeCompare(String(b.name || ""), "ja");
}

async function getWritingPerformanceSubmissionForTeacher({ db, authUid, data }) {
  const session = await resolveWritingTeacherSession({ db, authUid });
  const { classRef } = await teacherClassRef({ db, session, classId: data && data.classId });
  const testId = cleanId(data && data.testId, "testId");
  const studentId = cleanId(data && data.studentId, "studentId");
  const includeTest = data?.includeTest !== false;
  const testRef = classRef.collection("writingPerformanceTests").doc(testId);
  const [testSnap, submissionSnap, evaluationSnap] = await Promise.all([
    includeTest ? testRef.get() : Promise.resolve(null),
    testRef.collection("submissions").doc(studentId).get(),
    testRef.collection("evaluations").doc(studentId).get(),
  ]);
  if ((includeTest && !testSnap.exists) || !submissionSnap.exists) {
    throw new WritingAccessError("not-found", "対象提出が見つかりません。");
  }
  const value = submissionSnap.data();
  const evaluation = mergedEvaluation(
    value,
    evaluationSnap.exists ? evaluationSnap.data() : null
  );
  return { test: includeTest ? teacherTestData(testSnap) : null, submission: {
    studentId,
    submittedText: String(value.submittedText || ""),
    wordCount: Number(value.wordCount || 0),
    scoringStatus: String(value.scoringStatus || "pending"),
    aiScores: value.aiScores || null,
    aiTotalScore: Number.isFinite(value.aiTotalScore) ? value.aiTotalScore : null,
    aiFeedback: String(value.aiFeedback || ""),
    minimalCorrectedText: String(value.minimalCorrectedText || ""),
    deductions: Array.isArray(value.deductions) ? value.deductions : [],
    strengths: Array.isArray(value.strengths) ? value.strengths : [],
    suggestions: Array.isArray(value.suggestions) ? value.suggestions : [],
    needsTeacherReview: value.needsTeacherReview === true,
    reviewReasonJa: value.reviewReasonJa || null,
    teacherScores: evaluation.teacherScores,
    teacherTotalScore: evaluation.teacherTotalScore,
    teacherComment: evaluation.teacherComment,
    evaluationMethod: evaluation.evaluationMethod,
    finalizedAt: evaluation.finalizedAt,
    finalizedBy: evaluation.finalizedBy,
    submittedAt: timestampMillis(value.submittedAt),
    reviewedAt: timestampMillis(value.reviewedAt),
    speakingChallenge: publicSpeakingChallenge(value.speakingChallenge),
  } };
}

async function saveWritingPerformanceReviewForTeacher({ db, authUid, data }) {
  const session = await resolveWritingTeacherSession({ db, authUid });
  const { classRef } = await teacherClassRef({ db, session, classId: data && data.classId });
  const testId = cleanId(data && data.testId, "testId");
  const studentId = cleanId(data && data.studentId, "studentId");
  const testRef = classRef.collection("writingPerformanceTests").doc(testId);
  const submissionRef = testRef.collection("submissions").doc(studentId);
  const evaluationRef = testRef.collection("evaluations").doc(studentId);
  const [testSnap, submissionSnap] = await Promise.all([testRef.get(), submissionRef.get()]);
  if (!testSnap.exists || !submissionSnap.exists) throw new WritingAccessError("not-found", "対象提出が見つかりません。");
  const test = validatePerformanceTestData(testSnap.data());
  const input = data && data.teacherScores;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new WritingAccessError("invalid-argument", "教員点が不正です。");
  }
  const teacherScores = {};
  let teacherTotalScore = 0;
  for (const key of RUBRIC_KEYS) {
    const score = Number(input[key] && input[key].score);
    const maxScore = test.rubric[key].maxScore;
    if (!Number.isInteger(score) || score < 0 || score > maxScore) {
      throw new WritingAccessError("invalid-argument", `${test.rubric[key].label}の点数が不正です。`);
    }
    teacherScores[key] = { score, maxScore };
    teacherTotalScore += score;
  }
  const teacherComment = String((data && data.teacherComment) || "").trim().slice(0, 2000);
  const submission = submissionSnap.data() || {};
  const evaluationMethod = !Number.isFinite(submission.aiTotalScore)
    ? "manual"
    : (rubricScoresEqual(submission.aiScores, teacherScores)
      ? "ai_confirmed"
      : "teacher_adjusted");
  await evaluationRef.set({
    finalScore: teacherTotalScore,
    teacherScores,
    teacherComment,
    evaluationMethod,
    scoreOnly: false,
    finalizedBy: session.teacherId,
    finalizedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    schemaVersion: 1,
  }, { merge: true });
  return { teacherTotalScore, finalScore: teacherTotalScore, evaluationMethod };
}

async function assertStudentInClass({ db, session, classId, classRef, studentId }) {
  const [memberSnap, studentSnap] = await Promise.all([
    classRef.collection("students").doc(studentId).get(),
    db.collection("schools").doc(session.schoolId)
      .collection("students").doc(studentId).get(),
  ]);
  const member = memberSnap.exists ? memberSnap.data() || {} : null;
  const student = studentSnap.exists ? studentSnap.data() || {} : null;
  const memberMatches = Boolean(
    member && String(member.studentInternalUid || memberSnap.id) === studentId
  );
  const classIds = student ? [
    student.classId,
    student.currentClassId,
    ...(Array.isArray(student.classIds) ? student.classIds : []),
    ...(Array.isArray(student.enrolledClassIds) ? student.enrolledClassIds : []),
  ].map(String) : [];
  if (memberMatches || classIds.includes(classId)) return;

  // Some legacy classes use the login ID as the class-roster document ID and
  // keep the stable internal ID in studentInternalUid. Only query this
  // fallback when neither of the direct lookups above proves membership.
  const matchingMembers = await classRef.collection("students")
    .where("studentInternalUid", "==", studentId)
    .limit(1)
    .get();
  if (matchingMembers.empty) {
    throw new WritingAccessError("not-found", "対象生徒が見つかりません。");
  }
}

async function saveWritingPerformanceQuickEvaluationForTeacher({ db, authUid, data }) {
  const session = await resolveWritingTeacherSession({ db, authUid });
  const { classId, classRef } = await teacherClassRef({
    db,
    session,
    classId: data && data.classId,
  });
  const testId = cleanId(data && data.testId, "testId");
  const studentId = cleanId(data && data.studentId, "studentId");
  const testRef = classRef.collection("writingPerformanceTests").doc(testId);
  const submissionRef = testRef.collection("submissions").doc(studentId);
  const [testSnap, submissionSnap] = await Promise.all([
    testRef.get(),
    submissionRef.get(),
    assertStudentInClass({ db, session, classId, classRef, studentId }),
  ]);
  if (!testSnap.exists) {
    throw new WritingAccessError("not-found", "対象テストが見つかりません。");
  }
  const test = validatePerformanceTestData(testSnap.data());
  const finalScore = Number(data && data.finalScore);
  if (!Number.isInteger(finalScore) || finalScore < 0 || finalScore > test.totalPoints) {
    throw new WritingAccessError(
      "invalid-argument",
      `教員最終点は0〜${test.totalPoints}点の整数で入力してください。`
    );
  }
  const submission = submissionSnap.exists ? submissionSnap.data() || {} : null;
  const evaluationMethod = derivedEvaluationMethod(
    submission?.aiTotalScore,
    finalScore
  );
  await testRef.collection("evaluations").doc(studentId).set({
    finalScore,
    evaluationMethod,
    scoreOnly: true,
    finalizedBy: session.teacherId,
    finalizedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    schemaVersion: 1,
  }, { merge: true });
  return {
    finalScore,
    teacherTotalScore: finalScore,
    evaluationMethod,
    submitted: submissionSnap.exists,
  };
}

module.exports = {
  TEACHER_SESSION_COLLECTION,
  COPYRIGHT_GUIDANCE_VERSION,
  authenticateWritingTeacher,
  refreshWritingTeacherSession,
  resolveWritingTeacherSession,
  getTeacherProfileForTeacher,
  acceptCopyrightGuidanceForTeacher,
  createWritingPerformanceTestForTeacher,
  listWritingPerformanceTestsForTeacher,
  listWritingClassesForTeacher,
  copyWritingPerformanceTestForTeacher,
  setWritingPerformanceTestActiveForTeacher,
  deleteWritingPerformanceTestForTeacher,
  listWritingPerformanceSubmissionsForTeacher,
  getWritingPerformanceSubmissionForTeacher,
  saveWritingPerformanceReviewForTeacher,
  saveWritingPerformanceQuickEvaluationForTeacher,
};
