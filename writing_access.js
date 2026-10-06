"use strict";

const { HttpsError } = require("firebase-functions/v2/https");
const { FieldValue, Timestamp } = require("firebase-admin/firestore");
const crypto = require("crypto");

const SESSION_COLLECTION = "studentSessions";
const FEATURE_FLAGS_COLLECTION = "writingFeatureFlags";
const SESSION_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_ABSOLUTE_TTL_MS = 60 * 24 * 60 * 60 * 1000;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;

class WritingAccessError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function toHttpsError(error) {
  if (error instanceof WritingAccessError) {
    return new HttpsError(error.code, error.message);
  }
  return new HttpsError("internal", "Writing機能の権限確認に失敗しました。");
}

function cleanId(value, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.includes("/") || !ID_PATTERN.test(text)) {
    throw new WritingAccessError("invalid-argument", `${label}が不正です。`);
  }
  return text;
}

function cleanPassword(value) {
  const text = typeof value === "string" ? value : "";
  if (!text) {
    throw new WritingAccessError("invalid-argument", "パスワードが不正です。");
  }
  if (text.length > 200) {
    throw new WritingAccessError("invalid-argument", "パスワードが不正です。");
  }
  return text;
}

function passwordsMatch(actual, expected) {
  const left = Buffer.from(String(actual || ""));
  const right = Buffer.from(String(expected || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function credentialFingerprint(password) {
  return crypto.createHash("sha256").update(String(password || "")).digest("hex");
}

function timestampMillis(value) {
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (value && Number.isFinite(value._seconds)) return value._seconds * 1000;
  if (value && Number.isFinite(value.seconds)) return value.seconds * 1000;
  return 0;
}

async function loadStudentClasses({ db, schoolId, studentInternalUid, student }) {
  const schoolRef = db.collection("schools").doc(schoolId);
  const joinedSnap = await schoolRef.collection("students").doc(studentInternalUid)
    .collection("joinedClasses").where("active", "==", true).get();
  const memberships = new Map();
  for (const doc of joinedSnap.docs) {
    const value = doc.data();
    const classId = String(value.classId || doc.id).trim();
    if (classId) memberships.set(classId, value);
  }
  if (memberships.size === 0 && Array.isArray(student.joinedClasses)) {
    for (const value of student.joinedClasses) {
      const classId = String(value && value.classId || "").trim();
      if (classId) memberships.set(classId, value);
    }
  }
  for (const classId of [student.classId, student.currentClassId,
    ...(Array.isArray(student.classIds) ? student.classIds : []),
    ...(Array.isArray(student.enrolledClassIds) ? student.enrolledClassIds : [])]) {
    const id = String(classId || "").trim();
    if (id && !memberships.has(id)) memberships.set(id, {});
  }
  const classes = [];
  for (const [classId, membership] of memberships) {
    const classSnap = await schoolRef.collection("classes").doc(classId).get();
    if (!classSnap.exists) continue;
    const value = classSnap.data();
    classes.push({
      classId,
      schoolId,
      className: String(membership.className || value.className || value.name || "クラス名未設定"),
    });
  }
  return classes;
}

async function authenticateStudentSession({ db, authUid, data }) {
  const uid = cleanId(authUid, "認証UID");
  const schoolCode = cleanId(data && data.schoolCode, "学校ID");
  const loginId = cleanId(data && data.loginId, "生徒ID");
  const password = cleanPassword(data && data.password);
  const schools = await db.collection("schools").where("schoolCode", "==", schoolCode).limit(2).get();
  if (schools.empty || schools.docs.length !== 1) {
    throw new WritingAccessError("permission-denied", "学校ID、生徒ID、またはパスワードが正しくありません。");
  }
  const school = schools.docs[0];
  const students = await school.ref.collection("students").where("loginId", "==", loginId).limit(2).get();
  if (students.empty || students.docs.length !== 1) {
    throw new WritingAccessError("permission-denied", "学校ID、生徒ID、またはパスワードが正しくありません。");
  }
  const studentSnap = students.docs[0];
  const student = studentSnap.data();
  const schoolData = school.data() || {};
  if ((student.isDemoStudent === true || student.isDemoData === true) &&
      schoolData.demoDataVisible !== true) {
    throw new WritingAccessError("permission-denied", "現在このデモアカウントは利用できません。");
  }
  if (student.active === false || !passwordsMatch(password, student.password)) {
    throw new WritingAccessError("permission-denied", "学校ID、生徒ID、またはパスワードが正しくありません。");
  }
  const classes = await loadStudentClasses({
    db, schoolId: school.id, studentInternalUid: studentSnap.id, student,
  });
  const now = FieldValue.serverTimestamp();
  const authenticatedAtMillis = Date.now();
  const sessionExpiresAtMillis = authenticatedAtMillis + SESSION_IDLE_TTL_MS;
  const absoluteExpiresAtMillis = authenticatedAtMillis + SESSION_ABSOLUTE_TTL_MS;
  await db.collection(SESSION_COLLECTION).doc(uid).set({
    active: true,
    role: "student",
    schoolId: school.id,
    studentId: studentSnap.id,
    studentInternalUid: studentSnap.id,
    loginId,
    expiresAt: Timestamp.fromMillis(sessionExpiresAtMillis),
    absoluteExpiresAt: Timestamp.fromMillis(absoluteExpiresAtMillis),
    credentialFingerprint: credentialFingerprint(student.password),
    createdAt: now,
    updatedAt: now,
  }, { merge: true });
  return {
    ok: true,
    schoolId: school.id,
    studentId: studentSnap.id,
    studentInternalUid: studentSnap.id,
    loginId,
    name: String(student.name || student.studentName || ""),
    mustChangePassword: student.mustChangePassword === true,
    sessionExpiresAtMillis,
    classes,
  };
}

function isWritingEnabledFromFeatureFlagData(data) {
  return data && data.enabled === true;
}

async function requireOperationAdmin({ db, uid }) {
  const authUid = cleanId(uid, "管理者UID");
  const snap = await db.collection("admins").doc(authUid).get();
  const data = snap.exists ? snap.data() : null;
  if (!data || data.active !== true) {
    throw new WritingAccessError(
      "permission-denied",
      "この操作を行う権限がありません。"
    );
  }
  return data;
}

async function setSchoolWritingFeature({ db, admin, uid, data }) {
  await requireOperationAdmin({ db, uid });

  const schoolId = cleanId(data && data.schoolId, "schoolId");
  if (typeof (data && data.enabled) !== "boolean") {
    throw new WritingAccessError("invalid-argument", "enabledが不正です。");
  }

  const schoolRef = db.collection("schools").doc(schoolId);
  const schoolSnap = await schoolRef.get();
  if (!schoolSnap.exists) {
    throw new WritingAccessError("not-found", "対象の学校が見つかりません。");
  }

  await db.collection(FEATURE_FLAGS_COLLECTION).doc(schoolId).set(
    {
      // Legacy Admin clients may still call this endpoint. Preserve the
      // document shape, but never allow a standard feature to be disabled.
      enabled: true,
      schoolId,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: uid,
    },
    { merge: true }
  );

  return {
    schoolId,
    enabled: true,
  };
}

async function registerWritingStudentSession({ db, admin, authUid, data }) {
  const uid = cleanId(authUid, "認証UID");
  const schoolId = cleanId(data && data.schoolId, "schoolId");
  const studentInternalUid = cleanId(
    data && data.studentInternalUid,
    "studentInternalUid"
  );
  const loginId = cleanId(data && data.loginId, "loginId");
  const password = cleanPassword(data && data.password);

  const studentRef = db
    .collection("schools")
    .doc(schoolId)
    .collection("students")
    .doc(studentInternalUid);
  const studentSnap = await studentRef.get();
  const student = studentSnap.exists ? studentSnap.data() : null;
  const schoolSnap = await db.collection("schools").doc(schoolId).get();
  const school = schoolSnap.exists ? schoolSnap.data() : null;

  if (!school || !student || student.active === false || String(student.loginId || "") !== loginId) {
    throw new WritingAccessError(
      "permission-denied",
      "Writing認証に失敗しました。"
    );
  }
  if (String(student.password || "") !== password) {
    throw new WritingAccessError(
      "permission-denied",
      "Writing認証に失敗しました。"
    );
  }
  if ((student.isDemoStudent === true || student.isDemoData === true) &&
      school.demoDataVisible !== true) {
    throw new WritingAccessError(
      "permission-denied",
      "現在このデモアカウントは利用できません。"
    );
  }

  const now = FieldValue.serverTimestamp();
  await db.collection(SESSION_COLLECTION).doc(uid).set(
    {
      schoolId,
      studentInternalUid,
      loginId,
      role: "student",
      active: true,
      studentId: studentInternalUid,
      expiresAt: Timestamp.fromMillis(Date.now() + SESSION_IDLE_TTL_MS),
      absoluteExpiresAt: Timestamp.fromMillis(Date.now() + SESSION_ABSOLUTE_TTL_MS),
      credentialFingerprint: credentialFingerprint(student.password),
      createdAt: now,
      updatedAt: now,
    },
    { merge: true }
  );

  return {
    ok: true,
    schoolId,
  };
}

async function resolveWritingSession({ db, authUid, allowExpiredIdle = false }) {
  const uid = cleanId(authUid, "認証UID");
  const sessionSnap = await db.collection(SESSION_COLLECTION).doc(uid).get();
  const session = sessionSnap.exists ? sessionSnap.data() : null;
  const expiresAtMillis = timestampMillis(session && session.expiresAt);
  const absoluteExpiresAtMillis = timestampMillis(session && session.absoluteExpiresAt);
  const nowMillis = Date.now();
  const legacySessionTooOld = absoluteExpiresAtMillis <= 0 &&
    expiresAtMillis > 0 &&
    nowMillis - expiresAtMillis > SESSION_ABSOLUTE_TTL_MS;
  if (!session || session.active !== true || session.role !== "student" ||
      (!allowExpiredIdle && expiresAtMillis <= nowMillis) ||
      (allowExpiredIdle && expiresAtMillis <= 0) ||
      legacySessionTooOld ||
      (absoluteExpiresAtMillis > 0 && absoluteExpiresAtMillis <= nowMillis)) {
    throw new WritingAccessError(
      "permission-denied",
      "Writing機能を利用できません。"
    );
  }

  const schoolId = cleanId(session.schoolId, "schoolId");
  const studentInternalUid = cleanId(
    session.studentInternalUid,
    "studentInternalUid"
  );

  const studentSnap = await db
    .collection("schools")
    .doc(schoolId)
    .collection("students")
    .doc(studentInternalUid)
    .get();
  const student = studentSnap.exists ? studentSnap.data() : null;
  const schoolSnap = await db.collection("schools").doc(schoolId).get();
  const school = schoolSnap.exists ? schoolSnap.data() : null;
  if (!school || !student || student.active === false ||
      (session.credentialFingerprint &&
       session.credentialFingerprint !== credentialFingerprint(student.password)) ||
      ((student.isDemoStudent === true || student.isDemoData === true) &&
       school.demoDataVisible !== true)) {
    throw new WritingAccessError(
      "permission-denied",
      "Writing機能を利用できません。"
    );
  }

  return {
    authUid: uid,
    schoolId,
    studentInternalUid,
  };
}

async function refreshStudentSession({ db, authUid }) {
  // refreshではidle期限切れを許容する。Firebase Authと学校・生徒・
  // credential fingerprintを再検証した上で、新しいrolling期限を発行する。
  const session = await resolveWritingSession({
    db,
    authUid,
    allowExpiredIdle: true,
  });
  const sessionRef = db.collection(SESSION_COLLECTION).doc(session.authUid);
  const sessionSnap = await sessionRef.get();
  const current = sessionSnap.data() || {};
  const nowMillis = Date.now();
  const absoluteExpiresAtMillis = nowMillis + SESSION_ABSOLUTE_TTL_MS;
  const sessionExpiresAtMillis = nowMillis + SESSION_IDLE_TTL_MS;
  const studentSnap = await db.collection("schools").doc(session.schoolId)
    .collection("students").doc(session.studentInternalUid).get();
  await sessionRef.set({
    expiresAt: Timestamp.fromMillis(sessionExpiresAtMillis),
    absoluteExpiresAt: Timestamp.fromMillis(absoluteExpiresAtMillis),
    credentialFingerprint: credentialFingerprint(studentSnap.data().password),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return { ok: true, sessionExpiresAtMillis };
}

async function getWritingFeatureStatus({ db, authUid }) {
  const session = await resolveWritingSession({ db, authUid });
  return {
    // Writing is a standard feature. Keep this compatibility endpoint for
    // older clients, but do not gate access on the legacy per-school flag.
    enabled: true,
    schoolId: session.schoolId,
  };
}

async function assertWritingEnabledForAuth({ db, authUid }) {
  const status = await getWritingFeatureStatus({ db, authUid });
  if (status.enabled !== true) {
    throw new WritingAccessError(
      "permission-denied",
      "この学校ではWriting機能を利用できません。"
    );
  }
  return status;
}

async function recordDemoWritingAttempt({ db, admin, authUid, maxAttempts }) {
  const limit = Number(maxAttempts || 0);
  if (!Number.isFinite(limit) || limit <= 0) return null;

  const uid = cleanId(authUid, "認証UID");
  const sessionRef = db.collection(SESSION_COLLECTION).doc(uid);
  const result = await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(sessionRef);
    const session = snap.exists ? snap.data() : null;
    if (!session || session.active !== true) {
      throw new WritingAccessError(
        "permission-denied",
        "Writing機能を利用できません。"
      );
    }

    const used = Number(session.demoCorrectionCount || 0);
    if (used >= limit) {
      throw new WritingAccessError(
        "resource-exhausted",
        `ローカルデモの添削上限（${limit}回）に達しました。Emulatorをseedし直してから再開してください。`
      );
    }

    const nextCount = used + 1;
    transaction.set(
      sessionRef,
      {
        demoCorrectionCount: nextCount,
        demoCorrectionLimit: limit,
        demoLastCorrectionAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return { used: nextCount, limit };
  });

  return result;
}

module.exports = {
  SESSION_COLLECTION,
  SESSION_IDLE_TTL_MS,
  SESSION_ABSOLUTE_TTL_MS,
  FEATURE_FLAGS_COLLECTION,
  WritingAccessError,
  toHttpsError,
  cleanId,
  cleanPassword,
  authenticateStudentSession,
  isWritingEnabledFromFeatureFlagData,
  requireOperationAdmin,
  setSchoolWritingFeature,
  registerWritingStudentSession,
  refreshStudentSession,
  resolveWritingSession,
  getWritingFeatureStatus,
  assertWritingEnabledForAuth,
  recordDemoWritingAttempt,
};
