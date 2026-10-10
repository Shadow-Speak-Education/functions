"use strict";

const fs = require("fs");
const path = require("path");
const { HttpsError } = require("firebase-functions/v2/https");
const { FieldValue } = require("firebase-admin/firestore");
const {
  credentialRef,
  writeCredential,
} = require("./credential_security");

const DATASET_ID = "teacher_sales_demo_v1";
const DEMO_CLASS_ID = "demo_class_teacher_sales_demo_v1";
const EXAMPLE_MATERIAL_ID = "demo_original_example_v1";
const TEMPLATE_ROOT = path.join(__dirname, "demo_templates");

const EXAMPLE_FILES = Object.freeze({
  audio: "example/example_normalized.wav",
  subtitles: "example/example_subtitles.json",
  translation: "example/example_ja.json",
  waveform: "example/example_waveform.json",
  questions: "example/example_questions.json",
});

function cleanId(value, label) {
  const text = String(value || "").trim();
  if (!text || !/^[A-Za-z0-9._:-]+$/.test(text)) {
    throw new HttpsError("invalid-argument", `${label}が不正です。`);
  }
  return text;
}

function timestampMillis(value) {
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return 0;
}

async function assertDemoManager({ db, request, requestedSchoolId }) {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "ログインが必要です。");
  const schoolId = cleanId(requestedSchoolId, "schoolId");

  const adminSnap = await db.collection("admins").doc(uid).get();
  const adminData = adminSnap.exists ? adminSnap.data() : null;
  if (adminData && adminData.active === true && adminData.role === "superAdmin") {
    return { uid, schoolId, teacherId: "demo_teacher", teacherName: "デモ担当", role: "superAdmin" };
  }

  const sessionSnap = await db.collection("teacherSessions").doc(uid).get();
  const session = sessionSnap.exists ? sessionSnap.data() : null;
  if (!session || session.active !== true || session.role !== "teacher" ||
      String(session.schoolId || "") !== schoolId || timestampMillis(session.expiresAt) <= Date.now()) {
    throw new HttpsError("permission-denied", "この学校のデモ環境を変更する権限がありません。");
  }
  const teacherId = cleanId(session.teacherId, "teacherId");
  const teacherSnap = await db.collection("schools").doc(schoolId)
    .collection("teachers").doc(teacherId).get();
  if (!teacherSnap.exists || teacherSnap.data().active === false) {
    throw new HttpsError("permission-denied", "教師情報を確認できません。");
  }
  return {
    uid,
    schoolId,
    teacherId,
    teacherName: String(teacherSnap.data().name || "デモ担当"),
    role: "teacher",
  };
}

function demoStudents() {
  const names = [
    "山田 太郎", "田中 花子", "佐藤 蓮", "鈴木 美咲", "高橋 陽斗",
    "伊藤 結衣", "渡辺 大翔", "中村 葵", "小林 悠真", "加藤 咲良",
  ];
  return names.map((name, index) => {
    const number = String(index + 1).padStart(2, "0");
    const id = `demo_student_${number}`;
    return {
      id,
      data: {
        id,
        internalUid: id,
        studentInternalUid: id,
        name,
        grade: "1",
        class: "A",
        className: "デモクラス",
        number,
        loginId: `demo${number}`,
        mustChangePassword: false,
        active: true,
        status: "active",
        isCurrent: true,
        classId: DEMO_CLASS_ID,
        currentClassId: DEMO_CLASS_ID,
        currentClassName: "デモクラス",
        joinedClasses: [{ classId: DEMO_CLASS_ID, className: "デモクラス", active: true }],
        isDemoStudent: true,
        isDemoData: true,
        demoDatasetId: DATASET_ID,
      },
    };
  });
}

function demoAuthenticationRef(db, schoolId) {
  return db.collection("schools").doc(schoolId)
    .collection("demoSettings").doc("authentication");
}

async function assertSuperAdmin({ db, request }) {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "ログインが必要です。");
  const adminSnap = await db.collection("admins").doc(uid).get();
  const data = adminSnap.exists ? adminSnap.data() : null;
  if (!data || data.active !== true || data.role !== "superAdmin") {
    throw new HttpsError("permission-denied", "運営管理者のみ変更できます。");
  }
  return { uid };
}

async function demoCredentialConfigured({ db, schoolId }) {
  const snap = await credentialRef({
    db,
    schoolId,
    principalType: "student",
    principalId: "demo_student_01",
  }).get();
  return snap.exists;
}

async function getConfiguredDemoPassword({ db, schoolId }) {
  // Compatibility-only reader for legacy deployments. The returned plaintext
  // is used solely to perform a one-time server-side migration and is never
  // returned to a client or written to a new profile.
  const snap = await demoAuthenticationRef(db, schoolId).get();
  const password = String(snap.exists && snap.data().password || "").trim();
  if (!password && !await demoCredentialConfigured({ db, schoolId })) {
    throw new HttpsError(
      "failed-precondition",
      "Adminでデモ生徒用の初期パスワードを設定してください。",
    );
  }
  return password || null;
}

async function readConfiguredDemoPassword({ db, schoolId }) {
  const snap = await demoAuthenticationRef(db, schoolId).get();
  const password = String(snap.exists && snap.data().password || "").trim();
  return password || null;
}

async function setDemoAuthentication({ db, admin, schoolId, password, actorUid }) {
  const id = cleanId(schoolId, "schoolId");
  const schoolRef = db.collection("schools").doc(id);
  const schoolSnap = await schoolRef.get();
  if (!schoolSnap.exists) throw new HttpsError("not-found", "学校が存在しません。");
  const value = String(password || "").trim();
  if (value.length < 8 || value.length > 128) {
    throw new HttpsError("invalid-argument", "初期パスワードは8〜128文字で設定してください。");
  }
  for (const student of demoStudents()) {
    await writeCredential({
      db,
      schoolId: id,
      principalType: "student",
      principalId: student.id,
      password: value,
      metadata: {
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        changedByAuthUid: actorUid,
        demoDatasetId: DATASET_ID,
      },
    });
  }
  await demoAuthenticationRef(db, id).set({
    password: FieldValue.delete(),
    configured: true,
    updatedBy: actorUid,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  const passwordWrites = [];
  for (const student of demoStudents()) {
    const schoolStudentRef = schoolRef.collection("students").doc(student.id);
    const classStudentRef = schoolRef.collection("classes").doc(DEMO_CLASS_ID)
      .collection("students").doc(student.id);
    const [schoolStudentSnap, classStudentSnap] = await Promise.all([
      schoolStudentRef.get(),
      classStudentRef.get(),
    ]);
    if (schoolStudentSnap.exists && schoolStudentSnap.data().demoDatasetId === DATASET_ID) {
      passwordWrites.push({
        ref: schoolStudentRef,
        data: { password: FieldValue.delete() },
      });
    }
    if (classStudentSnap.exists && classStudentSnap.data().demoDatasetId === DATASET_ID) {
      passwordWrites.push({
        ref: classStudentRef,
        data: { password: FieldValue.delete() },
      });
    }
  }
  const updatedDemoStudentDocuments = await commitWrites(db, passwordWrites);
  const revokedSessionCount = await revokeDemoStudentSessions({ db, admin, schoolId: id });
  return { ok: true, schoolId: id, updatedDemoStudentDocuments, revokedSessionCount };
}

async function getDemoAuthenticationForAdmin({ db, schoolId }) {
  const id = cleanId(schoolId, "schoolId");
  const schoolSnap = await db.collection("schools").doc(id).get();
  if (!schoolSnap.exists) throw new HttpsError("not-found", "学校が存在しません。");
  const snap = await demoAuthenticationRef(db, id).get();
  return {
    configured: await demoCredentialConfigured({ db, schoolId: id }) ||
      (snap.exists && String(snap.data().password || "").trim().length > 0),
    password: "",
    passwordStoredSecurely: await demoCredentialConfigured({ db, schoolId: id }),
  };
}

function scoreFor(index, base, spread = 10) {
  return Math.max(20, Math.min(100, base + ((index % 5) - 2) * spread));
}

function loadDemoWords() {
  return JSON.parse(fs.readFileSync(path.join(TEMPLATE_ROOT, "vocab_junior_english_30.json"), "utf8"));
}

async function ensureExampleAssets({ bucket, schoolId }) {
  const base = `school_materials/${schoolId}/demo/example`;
  const destinations = {
    audio: `${base}/audio/example_normalized.wav`,
    subtitles: `${base}/subtitles/example_subtitles.json`,
    translation: `${base}/subtitles/example_ja.json`,
    waveform: `${base}/waveforms/example_waveform.json`,
    questions: `${base}/questions/example_questions.json`,
  };
  let uploaded = 0;
  for (const [key, relativePath] of Object.entries(EXAMPLE_FILES)) {
    const target = bucket.file(destinations[key]);
    const [exists] = await target.exists();
    if (exists) continue;
    const localPath = path.join(TEMPLATE_ROOT, relativePath);
    const contentType = relativePath.endsWith(".wav") ? "audio/wav" : "application/json; charset=utf-8";
    await bucket.upload(localPath, {
      destination: destinations[key],
      resumable: false,
      metadata: {
        contentType,
        metadata: { demoDatasetId: DATASET_ID, demoTemplateVersion: "1" },
      },
    });
    uploaded += 1;
  }
  return { paths: destinations, uploaded };
}

async function commitWrites(db, writes) {
  let committed = 0;
  for (let index = 0; index < writes.length; index += 450) {
    const batch = db.batch();
    for (const write of writes.slice(index, index + 450)) {
      batch.set(write.ref, write.data, { merge: true });
    }
    await batch.commit();
    committed += Math.min(450, writes.length - index);
  }
  return committed;
}

async function revokeDemoStudentSessions({ db, admin, schoolId }) {
  const sessionsSnap = await db.collection("studentSessions").where("schoolId", "==", schoolId).get();
  const demoStudentIds = new Set(demoStudents().map((student) => student.id));
  const revokedAt = admin.firestore.FieldValue.serverTimestamp();
  const writes = [];
  for (const sessionDoc of sessionsSnap.docs) {
    const data = sessionDoc.data();
    if (data.active === true && demoStudentIds.has(String(data.studentId || ""))) {
      writes.push({ ref: sessionDoc.ref, data: { active: false, revokedAt } });
    }
  }
  return commitWrites(db, writes);
}

async function initializeDemoEnvironment({ db, bucket, admin, schoolId, actor }) {
  const id = cleanId(schoolId, "schoolId");
  const schoolRef = db.collection("schools").doc(id);
  const schoolSnap = await schoolRef.get();
  if (!schoolSnap.exists) throw new HttpsError("not-found", "学校が存在しません。");

  const now = admin.firestore.FieldValue.serverTimestamp();
  const classRef = schoolRef.collection("classes").doc(DEMO_CLASS_ID);
  const existingClassSnap = await classRef.get();
  const existingClass = existingClassSnap.exists ? existingClassSnap.data() : null;
  if (existingClass && existingClass.demoDatasetId !== DATASET_ID) {
    throw new HttpsError("failed-precondition", "デモ用クラスIDと既存クラスが競合しています。");
  }
  const assets = await ensureExampleAssets({ bucket, schoolId: id });
  const legacyDemoPassword = await readConfiguredDemoPassword({ db, schoolId: id });
  if (legacyDemoPassword) {
    await setDemoAuthentication({
      db,
      admin,
      schoolId: id,
      password: legacyDemoPassword,
      actorUid: actor.uid,
    });
  }
  const hasDemoCredential = await demoCredentialConfigured({ db, schoolId: id });
  const materialPaths = assets.paths;
  const materialData = {
    id: EXAMPLE_MATERIAL_ID,
    schoolMaterialId: EXAMPLE_MATERIAL_ID,
    title: "Example",
    description: "営業デモ用の短いオリジナル英語教材です。",
    level: "",
    category: "General",
    type: "TeacherUpload",
    sourceType: "teacherOriginal",
    visible: true,
    audio: materialPaths.audio,
    audioPath: materialPaths.audio,
    storagePath: materialPaths.audio,
    subtitlesPath: materialPaths.subtitles,
    translationPath: materialPaths.translation,
    questionsPath: materialPaths.questions,
    waveformJsonPath: materialPaths.waveform,
    paths: {
      audio: materialPaths.audio,
      subtitles: materialPaths.subtitles,
      translation: materialPaths.translation,
      questions: materialPaths.questions,
      waveform: materialPaths.waveform,
    },
    waveformSamplesPerSecond: 100,
    sttStatus: "completed",
    wordCount: 11,
    isDemoData: true,
    demoDatasetId: DATASET_ID,
    demoTemplateVersion: 1,
    createdBy: actor.teacherId,
    createdAt: now,
    updatedAt: now,
  };

  const writes = [
    { ref: schoolRef, data: { demoDataVisible: true, demoDatasetId: DATASET_ID, updatedAt: now } },
    { ref: classRef, data: {
      name: "デモクラス", className: "デモクラス", grade: 1, gradeKey: "1", gradeLabel: "1年",
      classCode: "DEMO01", teacherId: actor.teacherId, teacherName: actor.teacherName,
      visible: true, status: "active", isDemoData: true, isDemoClass: true,
      demoDatasetId: DATASET_ID,
      ...(existingClass && existingClass.createdAt ? {} : { createdAt: now }),
      updatedAt: now,
    } },
    { ref: schoolRef.collection("materials").doc(EXAMPLE_MATERIAL_ID), data: materialData },
    { ref: classRef.collection("materials").doc(EXAMPLE_MATERIAL_ID), data: materialData },
  ];

  const students = demoStudents();
  for (const student of students) {
    writes.push(
      { ref: schoolRef.collection("students").doc(student.id), data: { ...student.data, schoolId: id, updatedAt: now } },
      { ref: classRef.collection("students").doc(student.id), data: { ...student.data, schoolId: id, joinedAt: now, updatedAt: now } },
      { ref: schoolRef.collection("students").doc(student.id).collection("joinedClasses").doc(DEMO_CLASS_ID), data: {
        schoolId: id, classId: DEMO_CLASS_ID, className: "デモクラス", active: true,
        isDemoData: true, demoDatasetId: DATASET_ID, joinedAt: now, updatedAt: now,
      } },
    );
  }

  const words = loadDemoWords();
  for (let testIndex = 0; testIndex < 3; testIndex += 1) {
    const testNumber = String(testIndex + 1).padStart(2, "0");
    const testId = `demo_vocab_test_${testNumber}`;
    const selected = words.slice(testIndex * 10, (testIndex + 1) * 10);
    const testRef = classRef.collection("vocabTests").doc(testId);
    const existingTestSnap = await testRef.get();
    const existingTest = existingTestSnap.exists ? existingTestSnap.data() : null;
    writes.push({ ref: testRef, data: {
      title: `デモ単語テスト${testIndex + 1}`,
      description: "日本語を見て英語を入力します。",
      vocabListId: "junior_english_1800",
      vocabListTitle: "中学英単語1800",
      vocabListScope: "standardVocabulary",
      sourceType: "standardVocabulary",
      standardCourseId: "junior_english_1800",
      rangeStart: testIndex * 10 + 1,
      rangeEnd: (testIndex + 1) * 10,
      questionCount: selected.length,
      randomMode: "sameForAll",
      selectedNumbers: selected.map((word) => word.number),
      sourceWordIds: selected.map((word) => word.id),
      words: selected,
      hintEnabled: true,
      isActive: true,
      isDemoTest: true,
      isDemoData: true,
      demoDatasetId: DATASET_ID,
      ...(existingTest && existingTest.createdAt ? {} : { createdAt: now }),
      updatedAt: now,
    } });
    for (const word of selected) {
      writes.push({ ref: testRef.collection("words").doc(word.id), data: word });
    }
    students.forEach((student, studentIndex) => {
      if (studentIndex === 3 || studentIndex === 8) return;
      const percent = scoreFor(studentIndex, 78);
      writes.push({ ref: testRef.collection("results").doc(student.id), data: {
        score: Math.round(percent / 10), total: 10, percent,
        reviewCompleted: studentIndex % 3 === 0,
        isDemoData: true, demoDatasetId: DATASET_ID, submittedAt: now, updatedAt: now,
      } });
    });
  }

  const boxes = [
    ["demo_submit_box_01", "デモBOX1", 88, 10],
    ["demo_submit_box_02", "デモBOX2", 72, 8],
    ["demo_submit_box_03", "デモBOX3", 58, 6],
  ];
  for (const [boxId, title, base, submitted] of boxes) {
    const boxRef = classRef.collection("submit_boxes").doc(boxId);
    writes.push({ ref: boxRef, data: {
      title, description: "営業デモ用の音読提出BOXです。", isDemoBox: true,
      isDemoData: true, demoDatasetId: DATASET_ID, createdAt: now, updatedAt: now,
    } });
    students.slice(0, submitted).forEach((student, index) => {
      const score = scoreFor(index, base);
      writes.push({ ref: boxRef.collection("submissions").doc(student.id), data: {
        internalUid: student.id, studentInternalUid: student.id, name: student.data.name,
        score, aiScore: score, prosodyScore: Math.max(0, score - 5),
        wordRecognitionScore: Math.min(100, score + 3),
        recordingPath: materialPaths.audio,
        recordingMimeType: "audio/wav", isDemoData: true, demoDatasetId: DATASET_ID,
        createdAt: now, submittedAt: now, updatedAt: now,
      } });
    });
  }

  const exampleRef = classRef.collection("materials").doc(EXAMPLE_MATERIAL_ID);
  students.forEach((student, index) => {
    if (index === 4 || index === 9) return;
    const listening = scoreFor(index, 80);
    const aiScore = scoreFor(index + 1, 82);
    writes.push({ ref: exampleRef.collection("results").doc(student.id), data: {
      listening, listeningPercent: listening, listeningScore: listening,
      listeningCompleted: true, listeningCorrectCount: Math.round(listening / 50),
      listeningTotalQuestions: 2, aiScore, aiPercent: aiScore,
      createdAt: now, lastSubmittedAt: now, submittedAt: now,
      isDemoData: true, demoDatasetId: DATASET_ID, updatedAt: now,
    } });
  });

  const committedWrites = await commitWrites(db, writes);
  return {
    ok: true,
    datasetId: DATASET_ID,
    demoClassId: DEMO_CLASS_ID,
    demoStudentCount: students.length,
    vocabTestCount: 3,
    exampleMaterialId: EXAMPLE_MATERIAL_ID,
    uploadedAssetCount: assets.uploaded,
    committedWrites,
    demoLogin: hasDemoCredential
      ? {
        schoolCode: String(schoolSnap.data().schoolCode || id),
        loginId: "demo09",
        password: "",
        passwordConfigured: true,
        passwordStoredSecurely: true,
      }
      : null,
  };
}

async function getDemoCredentials({ db, schoolId }) {
  const id = cleanId(schoolId, "schoolId");
  const schoolRef = db.collection("schools").doc(id);
  const [schoolSnap, classSnap] = await Promise.all([
    schoolRef.get(),
    schoolRef.collection("classes").doc(DEMO_CLASS_ID).get(),
  ]);
  if (!schoolSnap.exists || !classSnap.exists || classSnap.data().demoDatasetId !== DATASET_ID) {
    throw new HttpsError("not-found", "デモ環境がまだ作成されていません。");
  }
  await getConfiguredDemoPassword({ db, schoolId: id });
  return {
    schoolCode: String(schoolSnap.data().schoolCode || id),
    loginId: "demo09",
    password: "",
    passwordConfigured: true,
    passwordStoredSecurely: await demoCredentialConfigured({ db, schoolId: id }),
  };
}

async function setDemoVisibility({ db, admin, schoolId, visible }) {
  const id = cleanId(schoolId, "schoolId");
  const schoolRef = db.collection("schools").doc(id);
  const schoolSnap = await schoolRef.get();
  if (!schoolSnap.exists) throw new HttpsError("not-found", "学校が存在しません。");
  if (visible !== false) {
    throw new HttpsError("invalid-argument", "ONへの変更はデモ環境初期化を使用してください。");
  }

  const revokedAt = admin.firestore.FieldValue.serverTimestamp();
  const revokedSessionCount = await revokeDemoStudentSessions({ db, admin, schoolId: id });
  await schoolRef.set({ demoDataVisible: false, updatedAt: revokedAt }, { merge: true });
  return { ok: true, visible: false, revokedSessionCount };
}

async function deleteDemoEnvironment({ db, bucket, admin, schoolId }) {
  const id = cleanId(schoolId, "schoolId");
  const schoolRef = db.collection("schools").doc(id);
  const revokedSessionCount = await revokeDemoStudentSessions({ db, admin, schoolId: id });
  const classRef = schoolRef.collection("classes").doc(DEMO_CLASS_ID);
  let deletedDocuments = 0;
  const classSnap = await classRef.get();
  if (classSnap.exists) {
    if (classSnap.data().isDemoClass !== true || classSnap.data().demoDatasetId !== DATASET_ID) {
      throw new HttpsError("failed-precondition", "通常クラスの可能性があるため削除を中止しました。");
    }
    await db.recursiveDelete(classRef);
    deletedDocuments += 1;
  }
  for (const student of demoStudents()) {
    const ref = schoolRef.collection("students").doc(student.id);
    const snap = await ref.get();
    if (snap.exists && snap.data().demoDatasetId === DATASET_ID) {
      await db.recursiveDelete(ref);
      deletedDocuments += 1;
    }
  }
  const materialRef = schoolRef.collection("materials").doc(EXAMPLE_MATERIAL_ID);
  const materialSnap = await materialRef.get();
  if (materialSnap.exists && materialSnap.data().demoDatasetId === DATASET_ID) {
    await db.recursiveDelete(materialRef);
    deletedDocuments += 1;
  }
  const [files] = await bucket.getFiles({ prefix: `school_materials/${id}/demo/example/` });
  for (const file of files) await file.delete({ ignoreNotFound: true });
  await schoolRef.set({ demoDataVisible: false }, { merge: true });
  return { ok: true, deletedDocuments, deletedStorageFiles: files.length, revokedSessionCount };
}

module.exports = {
  DATASET_ID,
  DEMO_CLASS_ID,
  EXAMPLE_MATERIAL_ID,
  assertSuperAdmin,
  assertDemoManager,
  demoAuthenticationRef,
  demoStudents,
  deleteDemoEnvironment,
  ensureExampleAssets,
  getDemoCredentials,
  getDemoAuthenticationForAdmin,
  getConfiguredDemoPassword,
  initializeDemoEnvironment,
  loadDemoWords,
  readConfiguredDemoPassword,
  setDemoAuthentication,
  setDemoVisibility,
};
