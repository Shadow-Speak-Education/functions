"use strict";

const { HttpsError } = require("firebase-functions/v2/https");
const { FieldValue } = require("firebase-admin/firestore");

const SESSION_COLLECTION = "writingAuthSessions";
const FEATURE_FLAGS_COLLECTION = "writingFeatureFlags";
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

  if (!student || String(student.loginId || "") !== loginId) {
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

  const now = FieldValue.serverTimestamp();
  await db.collection(SESSION_COLLECTION).doc(uid).set(
    {
      schoolId,
      studentInternalUid,
      loginId,
      active: true,
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

async function resolveWritingSession({ db, authUid }) {
  const uid = cleanId(authUid, "認証UID");
  const sessionSnap = await db.collection(SESSION_COLLECTION).doc(uid).get();
  const session = sessionSnap.exists ? sessionSnap.data() : null;
  if (!session || session.active !== true) {
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
  if (!studentSnap.exists) {
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
  FEATURE_FLAGS_COLLECTION,
  WritingAccessError,
  toHttpsError,
  cleanId,
  isWritingEnabledFromFeatureFlagData,
  requireOperationAdmin,
  setSchoolWritingFeature,
  registerWritingStudentSession,
  resolveWritingSession,
  getWritingFeatureStatus,
  assertWritingEnabledForAuth,
  recordDemoWritingAttempt,
};
