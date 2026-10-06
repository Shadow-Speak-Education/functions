"use strict";

/* =========================================================
   🔧 Import & Setup (Gen2)
   ========================================================= */
const { setGlobalOptions } = require("firebase-functions/v2");
const { onObjectFinalized } = require("firebase-functions/v2/storage");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");

const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");
const os = require("os");
const fetch = require("node-fetch");
const FormData = require("form-data");
const {
  correctWritingHandler,
  extractWritingTextFromImageHandler,
  WritingFunctionError,
} = require("./writing_helpers");
const {
  WritingAccessError,
  toHttpsError,
  authenticateStudentSession,
  refreshStudentSession,
  registerWritingStudentSession,
  getWritingFeatureStatus,
  setSchoolWritingFeature,
  assertWritingEnabledForAuth,
  recordDemoWritingAttempt,
} = require("./writing_access");
const {
  listWritingPerformanceTests,
  listWritingPerformanceTestsForPreview,
  submitWritingPerformanceTest,
} = require("./writing_performance");
const {
  authenticateWritingTeacher,
  refreshWritingTeacherSession,
  resolveWritingTeacherSession,
  getTeacherProfileForTeacher,
  createWritingPerformanceTestForTeacher,
  copyWritingPerformanceTestForTeacher,
  listWritingPerformanceTestsForTeacher,
  listWritingClassesForTeacher,
  setWritingPerformanceTestActiveForTeacher,
  deleteWritingPerformanceTestForTeacher,
  listWritingPerformanceSubmissionsForTeacher,
  getWritingPerformanceSubmissionForTeacher,
  saveWritingPerformanceReviewForTeacher,
  saveWritingPerformanceQuickEvaluationForTeacher,
} = require("./writing_teacher");
const {
  assertDemoManager,
  assertSuperAdmin,
  deleteDemoEnvironment,
  getDemoCredentials,
  getDemoAuthenticationForAdmin,
  initializeDemoEnvironment,
  setDemoAuthentication,
  setDemoVisibility,
} = require("./demo_environment");

// 🔥 ffmpeg（WebM → WAV 変換）
const ffmpegPath = require("ffmpeg-static");
const ffmpeg = require("fluent-ffmpeg");

// ---- Firebase init
admin.initializeApp({
  projectId: "shadow-speak-school",
  storageBucket: "shadow-speak-school.firebasestorage.app",
});
const db = admin.firestore();
const storage = admin.storage();
const enforceWritingAccess =
  process.env.FUNCTIONS_EMULATOR !== "true" ||
  process.env.WRITING_ENFORCE_ACCESS === "true";

async function assertSimpleWritingAccess(authUid) {
  try {
    return await assertWritingEnabledForAuth({ db, authUid });
  } catch (studentError) {
    try {
      const teacher = await resolveWritingTeacherSession({ db, authUid });
      return { enabled: true, schoolId: teacher.schoolId };
    } catch (_) {
      throw studentError;
    }
  }
}

// ---- Global options
setGlobalOptions({
  region: "asia-northeast1",
  timeoutSeconds: 540,
  memoryMiB: 1024,
});

// ---- Secrets
const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");
const SPEECH_KEY = defineSecret("SPEECH_KEY");
const SPEECH_REGION = defineSecret("SPEECH_REGION");

/* =========================================================
   ✍️ Writing Mode: English correction for local/emulator use
   ========================================================= */
exports.registerWritingStudentSession = onCall(
  {
    region: "asia-northeast1",
    timeoutSeconds: 30,
    memory: "256MiB",
  },
  async (req) => {
    if (!req.auth || !req.auth.uid) {
      throw new HttpsError("unauthenticated", "ログインが必要です。");
    }

    try {
      return await registerWritingStudentSession({
        db,
        admin,
        authUid: req.auth.uid,
        data: req.data,
      });
    } catch (error) {
      if (error instanceof WritingAccessError) throw toHttpsError(error);
      console.error("🚨 registerWritingStudentSession failed", {
        name: error?.name || "Error",
        message: error?.message || String(error),
      });
      throw new HttpsError("internal", "Writing認証に失敗しました。");
    }
  }
);

exports.authenticateStudent = onCall(
  {
    region: "asia-northeast1",
    timeoutSeconds: 30,
    memory: "256MiB",
  },
  async (req) => {
    if (!req.auth?.uid) throw new HttpsError("unauthenticated", "ログインが必要です。");
    try {
      return await authenticateStudentSession({
        db,
        authUid: req.auth.uid,
        data: req.data,
      });
    } catch (error) {
      if (error instanceof WritingAccessError) throw toHttpsError(error);
      console.error("🚨 authenticateStudent failed", {
        message: error?.message || String(error),
      });
      throw new HttpsError("internal", "生徒認証に失敗しました。");
    }
  }
);

exports.refreshStudentSession = onCall(
  { region: "asia-northeast1", timeoutSeconds: 30, memory: "256MiB" },
  async (req) => {
    if (!req.auth?.uid) throw new HttpsError("unauthenticated", "ログインが必要です。");
    try {
      return await refreshStudentSession({ db, authUid: req.auth.uid });
    } catch (error) {
      if (error instanceof WritingAccessError) throw toHttpsError(error);
      console.error("🚨 refreshStudentSession failed", { message: error?.message || String(error) });
      throw new HttpsError("internal", "生徒セッションの更新に失敗しました。");
    }
  }
);

exports.initializeTeacherSalesDemo = onCall(
  {
    region: "asia-northeast1",
    timeoutSeconds: 120,
    memory: "512MiB",
  },
  async (req) => {
    const schoolId = String(req.data && req.data.schoolId || "").trim();
    const actor = await assertDemoManager({
      db,
      request: req,
      requestedSchoolId: schoolId,
    });
    return initializeDemoEnvironment({
      db,
      bucket: storage.bucket(),
      admin,
      schoolId,
      actor,
    });
  }
);

exports.deleteTeacherSalesDemo = onCall(
  {
    region: "asia-northeast1",
    timeoutSeconds: 120,
    memory: "512MiB",
  },
  async (req) => {
    const schoolId = String(req.data && req.data.schoolId || "").trim();
    await assertDemoManager({ db, request: req, requestedSchoolId: schoolId });
    return deleteDemoEnvironment({
      db,
      bucket: storage.bucket(),
      admin,
      schoolId,
    });
  }
);

exports.getTeacherSalesDemoCredentials = onCall(
  {
    region: "asia-northeast1",
    timeoutSeconds: 30,
    memory: "256MiB",
  },
  async (req) => {
    const schoolId = String(req.data && req.data.schoolId || "").trim();
    await assertDemoManager({ db, request: req, requestedSchoolId: schoolId });
    return getDemoCredentials({ db, schoolId });
  }
);

exports.setTeacherSalesDemoAuthentication = onCall(
  {
    region: "asia-northeast1",
    timeoutSeconds: 30,
    memory: "256MiB",
  },
  async (req) => {
    const schoolId = String(req.data && req.data.schoolId || "").trim();
    const actor = await assertSuperAdmin({ db, request: req });
    return setDemoAuthentication({
      db,
      admin,
      schoolId,
      password: req.data && req.data.password,
      actorUid: actor.uid,
    });
  }
);

exports.getTeacherSalesDemoAuthenticationForAdmin = onCall(
  {
    region: "asia-northeast1",
    timeoutSeconds: 30,
    memory: "256MiB",
  },
  async (req) => {
    const schoolId = String(req.data && req.data.schoolId || "").trim();
    await assertSuperAdmin({ db, request: req });
    return getDemoAuthenticationForAdmin({ db, schoolId });
  }
);

exports.setTeacherSalesDemoVisibility = onCall(
  {
    region: "asia-northeast1",
    timeoutSeconds: 60,
    memory: "256MiB",
  },
  async (req) => {
    const schoolId = String(req.data && req.data.schoolId || "").trim();
    await assertDemoManager({ db, request: req, requestedSchoolId: schoolId });
    return setDemoVisibility({
      db,
      admin,
      schoolId,
      visible: req.data && req.data.visible,
    });
  }
);

exports.getWritingFeatureStatus = onCall(
  {
    region: "asia-northeast1",
    timeoutSeconds: 15,
    memory: "256MiB",
  },
  async (req) => {
    if (!req.auth || !req.auth.uid) {
      throw new HttpsError("unauthenticated", "ログインが必要です。");
    }

    try {
      return await getWritingFeatureStatus({
        db,
        authUid: req.auth.uid,
      });
    } catch (error) {
      if (error instanceof WritingAccessError) {
        return { enabled: false };
      }
      console.error("🚨 getWritingFeatureStatus failed", {
        name: error?.name || "Error",
        message: error?.message || String(error),
      });
      return { enabled: false };
    }
  }
);

exports.setSchoolWritingFeature = onCall(
  {
    region: "asia-northeast1",
    timeoutSeconds: 30,
    memory: "256MiB",
  },
  async (req) => {
    if (!req.auth || !req.auth.uid) {
      throw new HttpsError("unauthenticated", "ログインが必要です。");
    }

    try {
      return await setSchoolWritingFeature({
        db,
        admin,
        uid: req.auth.uid,
        data: req.data,
      });
    } catch (error) {
      if (error instanceof WritingAccessError) throw toHttpsError(error);
      console.error("🚨 setSchoolWritingFeature failed", {
        name: error?.name || "Error",
        message: error?.message || String(error),
      });
      throw new HttpsError("internal", "Writing機能設定の更新に失敗しました。");
    }
  }
);

exports.correctWriting = onCall(
  {
    region: "asia-northeast1",
    secrets: [OPENAI_API_KEY],
    timeoutSeconds: 60,
    memory: "512MiB",
  },
  async (req) => {
    if (!req.auth || !req.auth.uid) {
      throw new HttpsError(
        "unauthenticated",
        "ログインが必要です。"
      );
    }

    const textLength =
      typeof req.data?.text === "string" ? req.data.text.trim().length : 0;
    console.log("✍️ correctWriting called", {
      mode: req.data?.mode || null,
      textLength,
    });

    try {
      if (enforceWritingAccess) {
        const writingStatus = await assertSimpleWritingAccess(req.auth.uid);
        const demoSchoolId = process.env.WRITING_DEMO_SCHOOL_ID || "";
        if (
          demoSchoolId &&
          process.env.FUNCTIONS_EMULATOR === "true" &&
          writingStatus.schoolId !== demoSchoolId
        ) {
          throw new HttpsError(
            "permission-denied",
            "このローカルデモ用学校ではありません。"
          );
        }
        const demoUsage = await recordDemoWritingAttempt({
          db,
          admin,
          authUid: req.auth.uid,
          maxAttempts: process.env.WRITING_DEMO_MAX_CORRECTIONS,
        });
        if (demoUsage) {
          console.log("✍️ correctWriting demo usage", {
            schoolId: writingStatus.schoolId,
            used: demoUsage.used,
            limit: demoUsage.limit,
          });
        }
      }

      const result = await correctWritingHandler({
        data: req.data,
        apiKey: process.env.OPENAI_API_KEY,
        fetchImpl: fetch,
      });
      console.log("✍️ correctWriting usage", {
        inputTokens: result.usage?.inputTokens ?? null,
        outputTokens: result.usage?.outputTokens ?? null,
        totalTokens: result.usage?.totalTokens ?? null,
      });
      return result;
    } catch (error) {
      if (error instanceof WritingAccessError) throw toHttpsError(error);
      if (error instanceof WritingFunctionError) {
        console.error("🚨 correctWriting API error", {
          code: error.code,
          message: error.message,
          details: error.details || null,
        });
        throw new HttpsError(error.code, error.message);
      }
      console.error("🚨 correctWriting failed", {
        name: error?.name || "Error",
        message: error?.message || String(error),
      });
      throw new HttpsError(
        "internal",
        "Writing添削に失敗しました。"
      );
    }
  }
);

exports.extractWritingTextFromImage = onCall(
  {
    region: "asia-northeast1",
    secrets: [OPENAI_API_KEY],
    timeoutSeconds: 60,
    memory: "512MiB",
  },
  async (req) => {
    if (!req.auth || !req.auth.uid) {
      throw new HttpsError(
        "unauthenticated",
        "ログインが必要です。"
      );
    }

    const imageLength =
      typeof req.data?.imageBase64 === "string" ? req.data.imageBase64.length : 0;
    console.log("🖼️ extractWritingTextFromImage called", {
      mimeType: req.data?.mimeType || null,
      imageChars: imageLength,
    });

    try {
      if (enforceWritingAccess) {
        await assertSimpleWritingAccess(req.auth.uid);
      }

      const result = await extractWritingTextFromImageHandler({
        data: req.data,
        apiKey: process.env.OPENAI_API_KEY,
        fetchImpl: fetch,
      });
      console.log("🖼️ extractWritingTextFromImage usage", {
        inputTokens: result.usage?.inputTokens ?? null,
        outputTokens: result.usage?.outputTokens ?? null,
        totalTokens: result.usage?.totalTokens ?? null,
      });
      return result;
    } catch (error) {
      if (error instanceof WritingAccessError) throw toHttpsError(error);
      if (error instanceof WritingFunctionError) {
        console.error("🚨 extractWritingTextFromImage API error", {
          code: error.code,
          message: error.message,
          details: error.details || null,
        });
        throw new HttpsError(error.code, error.message);
      }
      console.error("🚨 extractWritingTextFromImage failed", {
        name: error?.name || "Error",
        message: error?.message || String(error),
      });
      throw new HttpsError(
        "internal",
        "Writing OCRに失敗しました。"
      );
    }
  }
);

exports.listWritingPerformanceTests = onCall(
  {
    region: "asia-northeast1",
    timeoutSeconds: 30,
    memory: "256MiB",
  },
  async (req) => {
    if (!req.auth?.uid) throw new HttpsError("unauthenticated", "ログインが必要です。");
    try {
      if (req.auth.token?.role === "teacher_preview") {
        return await listWritingPerformanceTestsForPreview({
          db,
          token: req.auth.token,
          data: req.data,
        });
      }
      await assertWritingEnabledForAuth({ db, authUid: req.auth.uid });
      return await listWritingPerformanceTests({
        db,
        authUid: req.auth.uid,
        data: req.data,
      });
    } catch (error) {
      if (error instanceof WritingAccessError) throw toHttpsError(error);
      if (error instanceof WritingFunctionError) {
        throw new HttpsError(error.code, error.message);
      }
      console.error("🚨 listWritingPerformanceTests failed", {
        message: error?.message || String(error),
      });
      throw new HttpsError("internal", "Writing課題一覧の取得に失敗しました。");
    }
  }
);

exports.submitWritingPerformanceTest = onCall(
  {
    region: "asia-northeast1",
    secrets: [OPENAI_API_KEY],
    timeoutSeconds: 90,
    memory: "512MiB",
  },
  async (req) => {
    if (!req.auth?.uid) throw new HttpsError("unauthenticated", "ログインが必要です。");
    try {
      await assertWritingEnabledForAuth({ db, authUid: req.auth.uid });
      return await submitWritingPerformanceTest({
        db,
        admin,
        authUid: req.auth.uid,
        data: req.data,
        apiKey: process.env.OPENAI_API_KEY,
        fetchImpl: fetch,
      });
    } catch (error) {
      if (error instanceof WritingAccessError) throw toHttpsError(error);
      if (error instanceof WritingFunctionError) {
        throw new HttpsError(error.code, error.message);
      }
      console.error("🚨 submitWritingPerformanceTest failed", {
        message: error?.message || String(error),
      });
      throw new HttpsError("internal", "Writing課題の提出に失敗しました。");
    }
  }
);

function teacherWritingCallable(handler, failureMessage) {
  return onCall(
    { region: "asia-northeast1", timeoutSeconds: 30, memory: "256MiB" },
    async (req) => {
      if (!req.auth?.uid) throw new HttpsError("unauthenticated", "ログインが必要です。");
      try {
        return await handler({ db, authUid: req.auth.uid, data: req.data });
      } catch (error) {
        if (error instanceof WritingAccessError) throw toHttpsError(error);
        if (error instanceof WritingFunctionError) throw new HttpsError(error.code, error.message);
        console.error(`🚨 ${failureMessage}`, { message: error?.message || String(error) });
        throw new HttpsError("internal", failureMessage);
      }
    }
  );
}

exports.authenticateWritingTeacher = teacherWritingCallable(
  authenticateWritingTeacher,
  "教師用Writing認証に失敗しました。"
);
exports.refreshWritingTeacherSession = teacherWritingCallable(
  refreshWritingTeacherSession,
  "教師セッションの更新に失敗しました。"
);
exports.createStudentAppPreviewToken = teacherWritingCallable(
  async ({ db: firestore, authUid, data }) => {
    const session = await resolveWritingTeacherSession({
      db: firestore,
      authUid,
    });
    const classId = String(data?.classId || "").trim();
    if (!classId || classId.includes("/")) {
      throw new WritingAccessError("invalid-argument", "クラス情報が不正です。");
    }
    const classSnap = await firestore
      .collection("schools")
      .doc(session.schoolId)
      .collection("classes")
      .doc(classId)
      .get();
    if (!classSnap.exists) {
      throw new WritingAccessError("not-found", "対象クラスが見つかりません。");
    }
    const token = await admin.auth().createCustomToken(authUid, {
      role: "teacher_preview",
      schoolId: session.schoolId,
      teacherId: session.teacherId,
      classId,
    });
    return { token };
  },
  "生徒アプリのプレビュー認証に失敗しました。"
);
exports.getTeacherProfile = teacherWritingCallable(
  getTeacherProfileForTeacher,
  "教師プロフィールの取得に失敗しました。"
);
exports.createWritingPerformanceTestForTeacher = teacherWritingCallable(
  createWritingPerformanceTestForTeacher,
  "Writing課題の作成に失敗しました。"
);
exports.listWritingPerformanceTestsForTeacher = teacherWritingCallable(
  listWritingPerformanceTestsForTeacher,
  "教師用Writing課題一覧の取得に失敗しました。"
);
exports.listWritingClassesForTeacher = teacherWritingCallable(
  listWritingClassesForTeacher,
  "Writingコピー先クラス一覧の取得に失敗しました。"
);
exports.copyWritingPerformanceTestForTeacher = teacherWritingCallable(
  copyWritingPerformanceTestForTeacher,
  "Writing課題のコピーに失敗しました。"
);
exports.setWritingPerformanceTestActiveForTeacher = teacherWritingCallable(
  setWritingPerformanceTestActiveForTeacher,
  "Writing課題の公開状態更新に失敗しました。"
);
exports.deleteWritingPerformanceTestForTeacher = teacherWritingCallable(
  deleteWritingPerformanceTestForTeacher,
  "Writing課題の削除に失敗しました。"
);
exports.listWritingPerformanceSubmissionsForTeacher = teacherWritingCallable(
  listWritingPerformanceSubmissionsForTeacher,
  "Writing提出一覧の取得に失敗しました。"
);
exports.getWritingPerformanceSubmissionForTeacher = teacherWritingCallable(
  getWritingPerformanceSubmissionForTeacher,
  "Writing提出詳細の取得に失敗しました。"
);
exports.saveWritingPerformanceReviewForTeacher = teacherWritingCallable(
  saveWritingPerformanceReviewForTeacher,
  "Writing最終評価の保存に失敗しました。"
);
exports.saveWritingPerformanceQuickEvaluationForTeacher = teacherWritingCallable(
  saveWritingPerformanceQuickEvaluationForTeacher,
  "Writing教員最終点の保存に失敗しました。"
);

/* =========================================================
   🔧 Path helpers
   ========================================================= */

function isOfficialPath(p) {
  return typeof p === "string" && p.startsWith("official/");
}
function isWebm(p, ct) {
  return (ct && ct.includes("webm")) || (typeof p === "string" && p.toLowerCase().endsWith(".webm"));
}
function isAudioFile(p) {
  return typeof p === "string" && /\.(wav|mp3|m4a|aac|ogg)$/i.test(p);
}
function isSubtitlesJson(p) {
  return typeof p === "string" && p.toLowerCase().endsWith("_subtitles.json");
}
function isDictationJson(p) {
  return isOfficialPath(p) && p.toLowerCase().endsWith("/dictation.json");
}
function isOfficialTxt(p) {
  return isOfficialPath(p) && p.toLowerCase().endsWith(".txt");
}
function toDocIdFromPath(p) {
  return (p || "").replace(/\//g, "__");
}

function extractMetaFromOfficialPath(filePath) {
  const parts = (filePath || "").split("/");

  // official/Level5/Lesson1/A/passage2/xxx
  const level = parts[1] || "";
  const lesson = parts[2] || "";
  const pattern = parts[3] || "";

  const passage = extractPassageNumber(filePath); // null or number
  return { level, lesson, pattern, passage };
}



// passage番号をパスから取る: .../passage3/..._subtitles.json
function extractPassageNumber(filePath) {
  const m = (filePath || "").match(/\/passage(\d+)\//i);
  return m ? Number(m[1]) : null;
}
// =========================================================
// 🎛️ TTS 設定（Level / Pattern で声＆速度を変える）
// =========================================================

const LEVEL_RATE = {
  Level1: "-30%",
  Level2: "-27%",
  Level3: "-21%",
  Level4: "-15%",
  Level5: "-12%",
  Level6: "-3%",
};

// パターンごとに声を変えたいならここで差し替える
const PATTERN_VOICE = {
  A: "en-US-GuyNeural",
  B: "en-US-JennyNeural",
  C: "en-US-AriaNeural",
  D: "en-US-DavisNeural",
  E: "en-US-AmberNeural",
  F: "en-US-BrandonNeural",
  evaluation: "en-US-JennyNeural",
};

function pickVoiceName({ pattern }) {
  return PATTERN_VOICE[pattern] || "en-US-JennyNeural";
}

function pickRate({ level }) {
  return LEVEL_RATE[level] || "0%";
}

// official/Level5/Lesson1/D/passage1/listening.txt -> listening.wav
function toTtsAudioOutPathFromTxt(txtPath) {
  if (typeof txtPath !== "string") return null;
  // 拡張子だけ wav にする（mp3にしたいなら後でffmpegで変換）
  return txtPath.replace(/\.txt$/i, ".wav");
}

function levelToNumber(levelStr) {
  const m = String(levelStr || "").match(/(\d+)/);
  return m ? Number(m[1]) : null;
}
function lessonToNumber(lessonStr) {
  const m = String(lessonStr || "").match(/(\d+)/);
  return m ? Number(m[1]) : null;
}
function legacyDocId(levelStr, lessonStr, pattern) {
  return `Level_${levelToNumber(levelStr)}_Lesson${lessonToNumber(lessonStr)}_${pattern}`;
}
function legacyId(levelStr, lessonStr, pattern) {
  const ln = levelToNumber(levelStr);
  const lesn = lessonToNumber(lessonStr);
  return `L${ln}_${pattern}_${String(lesn).padStart(2, "0")}`;
}

function upsertSortedImagePaths(existing = [], addPath) {
  const set = new Set(Array.isArray(existing) ? existing : []);
  set.add(addPath);
  const arr = Array.from(set);

  // img_..._a.png の a,b,c,d 順
  arr.sort((p1, p2) => {
    const a1 = (p1.match(/_([a-d])\.(png|jpg|jpeg)$/i) || [])[1] || "z";
    const a2 = (p2.match(/_([a-d])\.(png|jpg|jpeg)$/i) || [])[1] || "z";
    return a1.localeCompare(a2);
  });

  return arr;
}

exports.buildLegacyMaterialsOnOfficialUpload = onObjectFinalized(async (event) => {
  const filePath = event.data.name;
  if (!filePath) return;

  // 公式教材だけ対象
  if (!isOfficialPath(filePath)) return;

  // evaluation は対象外（必要なら別扱い）
  const { level, lesson, pattern, passage } = extractMetaFromOfficialPath(filePath);
  if (!level || !lesson || !pattern) return;
  if (pattern === "evaluation") return;

    // ✅ レッスン単位 dictation.json（passage外）を拾う
  if (!Number.isFinite(passage)) {
    const filename = filePath.split("/").pop() || "";
    if (filename.toLowerCase() === "dictation.json") {
      const docId = legacyDocId(level, lesson, pattern);
      await db.collection("materials").doc(docId).set(
        {
          dictationPath: filePath,
          mode: admin.firestore.FieldValue.arrayUnion("dictation"),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      console.log(`✅ set top-level dictationPath: ${docId} -> ${filePath}`);
    }
    return;
  }

  
  // passage 配下のみ対象（A-F の passageN）
  if (!Number.isFinite(passage)) return;

  // 例: official/Level5/Lesson1/A/passage2/img_L5_L01_02_a.png
  const filename = filePath.split("/").pop() || "";

  const docId = legacyDocId(level, lesson, pattern);
  const ref = db.collection("materials").doc(docId);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : {};

    const passages = Array.isArray(data.passages) ? data.passages : [];

    // passageを取得/作成
    let p = passages.find((x) => Number(x.id) === passage);
    if (!p) {
      p = { id: passage, order: passage, durationSec: 0 };
      passages.push(p);
    }

    // どのファイルかで埋める
    if (/\.(mp3|wav)$/i.test(filename) && filename.includes("listening")) {
      p.audioPath = filePath;

    } else if (filename.toLowerCase().includes("subtitles") && filename.toLowerCase().endsWith(".json")) {
      p.subtitlePath = filePath;

    } else if (filename.toLowerCase().endsWith("listening.txt")) {
      p.scriptPath = filePath;  } 
      
      else if (
  filename.toLowerCase().endsWith("listening_questions.json") ||
  filename.toLowerCase().endsWith("listening_question.json")
) {
  p.questionsPath = filePath;

    } else if (filename.toLowerCase().endsWith("dictation.json") || filename.toLowerCase().endsWith("_dictation.json")) {
      p.dictationPath = filePath;
    } else if (/^img_.*_([a-d])\.(png|jpg|jpeg)$/i.test(filename)) {
      p.imagePaths = upsertSortedImagePaths(p.imagePaths, filePath);
      p.imagePath = p.imagePaths[0]; // 互換用
    }

    // mode
    const modeSet = new Set(Array.isArray(data.mode) ? data.mode : ["listening", "overlapping"]);
    if (p.dictationPath) modeSet.add("dictation");

    // top-level
    const legacy = {
  title: data.title ?? `${lesson}`, // 例: "Lesson1"
  level: data.level ?? level,
  lesson: data.lesson ?? lessonToNumber(lesson),
  pattern: data.pattern ?? pattern,
  id: data.id ?? legacyId(level, lesson, pattern),
  mode: Array.from(modeSet),
  passages,
  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
};


    tx.set(ref, legacy, { merge: true });
  });

  console.log(`✅ materials updated: ${docId} passage=${passage} file=${filename}`);
});

/* =========================================================
   🎧 1) ffmpeg: WebM → WAV 自動変換
   ========================================================= */
exports.convertWebmToWav = onObjectFinalized(
  {
    region: "asia-northeast1",
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  async (event) => {
    const object = event.data;
    const filePath = object.name;
    const type = object.contentType;

    if (!filePath) return;
    if (!isWebm(filePath, type)) return;

    const bucket = storage.bucket(object.bucket);
    const fileName = path.basename(filePath);
    const tmpIn = path.join(os.tmpdir(), fileName);
    const wavName = fileName.replace(/\.webm$/i, ".wav");
    const tmpOut = path.join(os.tmpdir(), wavName);

    await bucket.file(filePath).download({ destination: tmpIn });
    console.log("⬇️ Downloaded:", tmpIn);

    ffmpeg.setFfmpegPath(ffmpegPath);

    await new Promise((resolve, reject) => {
      ffmpeg(tmpIn)
        .toFormat("wav")
        .on("end", () => resolve())
        .on("error", reject)
        .save(tmpOut);
    });

    const wavStoragePath = filePath.replace(/\.webm$/i, ".wav");
    await bucket.upload(tmpOut, {
      destination: wavStoragePath,
      metadata: { contentType: "audio/wav" },
    });
    console.log("⬆️ Uploaded WAV:", wavStoragePath);

    fs.unlinkSync(tmpIn);
    fs.unlinkSync(tmpOut);
  }
);

/* =========================================================
   🧠 2) Whisper 呼び出し
   ========================================================= */
async function callWhisperVerboseJson(tmpPath, { wantWords = true } = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY missing");

  const form = new FormData();
  form.append("file", fs.createReadStream(tmpPath));
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  if (wantWords) form.append("timestamp_granularities[]", "word");
  form.append("timestamp_granularities[]", "segment");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, ...form.getHeaders() },
    body: form,
  });

  const json = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(json));
  return json;
}

/* =========================================================
   🪄 3) Whisper → アプリ用 JSON（words fallback付き）
   ========================================================= */
function formatWhisperToAppJson(result) {
  const out = {
    text: result.text || "",
    segments: [],
    language: result.language || "en",
  };

  if (!Array.isArray(result.segments)) return out;

  const globalWords = Array.isArray(result.words)
    ? result.words.map((w) => ({
        word: (w.word || "").trim(),
        start: Number(w.start || 0),
        end: Number(w.end || 0),
        probability: w.probability ?? 1,
      }))
    : [];

  out.segments = result.segments.map((seg, idx) => {
    const start = Number(seg.start || 0);
    const end = Number(seg.end || 0);
    const dur = Math.max(0, end - start);

    let segWords = [];

    if (Array.isArray(seg.words) && seg.words.length > 0) {
      segWords = seg.words.map((w) => ({
        word: (w.word || "").trim(),
        start: Number(w.start || start),
        end: Number(w.end || start),
        probability: w.probability ?? 1,
      }));
    } else if (globalWords.length > 0) {
      segWords = globalWords.filter((w) => w.start >= start - 0.05 && w.start < end + 0.05);
    }

    if (segWords.length === 0) {
      const tokens = (seg.text || "").split(/\s+/).filter(Boolean);

      const rawDur = dur;
      let headPad = 0.2;
      let tailPad = 0.6;

      const maxPad = rawDur * 0.4;
      let totalPad = headPad + tailPad;
      if (totalPad > maxPad && totalPad > 0) {
        const scale = maxPad / totalPad;
        headPad *= scale;
        tailPad *= scale;
      }

      const usableStart = start + headPad;
      const usableDur = Math.max(0, rawDur - headPad - tailPad);
      const slice = tokens.length > 0 ? usableDur / Math.max(tokens.length, 1) : 0;

      segWords = tokens.map((t, i) => ({
        word: t,
        start: usableStart + i * slice,
        end: usableStart + (i + 1) * slice,
        probability: 1,
      }));
    }

    return {
      id: idx,
      seek: 0,
      start,
      end,
      text: seg.text || "",
      tokens: seg.tokens || [],
      temperature: seg.temperature || 0,
      avg_logprob: seg.avg_logprob || 0,
      compression_ratio: seg.compression_ratio || 1,
      no_speech_prob: seg.no_speech_prob || 0,
      words: segWords,
    };
  });

  return out;
}

/* =========================================================
   🎧 4) Storage: 音声 → _subtitles.json 生成
   ========================================================= */
exports.generateSubtitleJson = onObjectFinalized(
  { region: "asia-northeast1", secrets: [OPENAI_API_KEY] },
  async (event) => {
    const object = event.data;
    const filePath = object.name;
    const contentType = object.contentType;
    if (!filePath) return;

    console.log("🟢 generateSubtitleJson:", filePath);

    // WebMは convertWebmToWav に任せる
    if (isWebm(filePath, contentType)) {
      console.log("⏭ Skip: handled by convertWebmToWav");
      return;
    }

    // 音声だけ
    if (!isAudioFile(filePath)) return;

    const bucket = storage.bucket(object.bucket);
    const tmpIn = path.join(os.tmpdir(), path.basename(filePath));
    await bucket.file(filePath).download({ destination: tmpIn });

    const transcriptPath = filePath.replace(/\.(wav|mp3|m4a|aac|ogg)$/i, "_subtitles.json");

    try {
      let res = await callWhisperVerboseJson(tmpIn, { wantWords: true });
      if (!res.segments?.some((s) => s.words?.length)) {
        res = await callWhisperVerboseJson(tmpIn, { wantWords: false });
      }

      const formatted = formatWhisperToAppJson(res);
      const tmpJson = path.join(os.tmpdir(), path.basename(transcriptPath));
      fs.writeFileSync(tmpJson, JSON.stringify(formatted, null, 2));

      await bucket.upload(tmpJson, {
        destination: transcriptPath,
        metadata: { contentType: "application/json" },
      });

      console.log("📄 Uploaded JSON:", transcriptPath);
      fs.unlinkSync(tmpJson);
    } catch (e) {
      console.error("❌ Whisper failed:", e);
    } finally {
      fs.unlinkSync(tmpIn);
    }
  }
);

/* =========================================================
   🏫 5) Firestore: クラス作成 → 公式教材コピー
   ========================================================= */
exports.copyOfficialMaterialsOnClassCreate = onDocumentCreated(
  { document: "schools/{schoolId}/classes/{classId}", region: "asia-northeast1" },
  async (event) => {
    const { schoolId, classId } = event.params;

    const snap = await db
      .collection("schools")
      .doc(schoolId)
      .collection("materials")
      .where("type", "==", "Official")
      .get();

    if (snap.empty) return;

    const batch = db.batch();
    snap.forEach((doc) => {
      batch.set(
        db.collection("schools").doc(schoolId).collection("classes").doc(classId).collection("materials").doc(doc.id),
        {
          ...doc.data(),
          visible: true,
          copiedAt: new Date(),
          sourceType: "Official",
        }
      );
    });

    await batch.commit();
  }
);

/* =========================================================
   ☎️ 6) Callable: URL → Whisper 即時解析
   ========================================================= */
exports.transcribeFromUrl = onCall(
  { region: "asia-northeast1", secrets: [OPENAI_API_KEY] },
  async (req) => {
    const audioUrl = req.data.audioUrl || req.data.sourceUrl;
    if (!audioUrl) throw new Error("audioUrl required");

    const audioResp = await fetch(audioUrl);
    if (!audioResp.ok) throw new Error(`Failed to fetch audio: ${audioResp.status} ${audioResp.statusText}`);
    const buf = Buffer.from(await audioResp.arrayBuffer());

    const form = new FormData();
    form.append("file", buf, { filename: "audio.wav", contentType: "audio/wav" });
    form.append("model", "whisper-1");
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "word");
    form.append("timestamp_granularities[]", "segment");

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, ...form.getHeaders() },
      body: form,
    });

    const text = await res.text();
    if (!res.ok) throw new Error(text);

    return JSON.parse(text);
  }
);

/* =========================================================
   📚 7) Storage: _subtitles.json → Firestore(official_materials) 自動登録
   ========================================================= */
exports.registerOfficialMaterialOnSubtitleCreated = onObjectFinalized(
  { region: "asia-northeast1" },
  async (event) => {
    const object = event.data;
    const filePath = object.name;
    if (!filePath) return;
    if (!isOfficialPath(filePath)) return;
    if (!isSubtitlesJson(filePath)) return;

    const bucket = storage.bucket(object.bucket);

    // 対になる音声を探す（base = ".../xxxx"）
    const base = filePath.replace(/_subtitles\.json$/i, "");
    const candidates = [`${base}.mp3`, `${base}.wav`, `${base}.m4a`, `${base}.aac`, `${base}.ogg`];
    let audioPath = null;

    for (const c of candidates) {
      const [exists] = await bucket.file(c).exists();
      if (exists) {
        audioPath = c;
        break;
      }
    }
    if (!audioPath) {
      console.log("⚠️ audio not found for:", filePath);
      return;
    }

    // 字幕本文
    const [buf] = await bucket.file(filePath).download();
    const subtitleJson = JSON.parse(buf.toString("utf-8"));
    const text = subtitleJson.text || "";
    const language = subtitleJson.language || "en";

    // ✅ Level/Lesson/Pattern（evaluationはLesson直下でもpattern="evaluation"になる）
    const { level, lesson, pattern } = extractMetaFromOfficialPath(filePath);
    if (!level || !lesson || !pattern) {
      console.log("⚠️ meta missing:", filePath, { level, lesson, pattern });
      return;
    }

    // ✅ docIdは “pattern単位” に統一
    const patternDocId = toDocIdFromPath(`official/${level}/${lesson}/${pattern}`);

    // ✅ ja字幕が既にあるならパスも持たせる（なくてもnullでOK）
    const jaSubtitlePath = toJaSubtitlesPath(filePath);
    let subtitleJaPath = null;
    if (jaSubtitlePath) {
      const [jaExists] = await bucket.file(jaSubtitlePath).exists();
      if (jaExists) subtitleJaPath = jaSubtitlePath;
    }

    const title =
      pattern === "evaluation"
        ? `${level}-${lesson}-evaluation`
        : `${level}-${lesson}-${pattern}`;

    await db.collection("official_materials").doc(patternDocId).set(
      {
        type: "Official",
        level,
        lesson,
        pattern,
        title,
        audioPath,
        subtitlePath: filePath,
        subtitleJaPath,
        text,
        language,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    console.log("✅ registered official_materials:", patternDocId);
  }
);


/* =========================================================
   🔊 8) Azure TTS (SSML) -> WAV buffer
   ========================================================= */
async function azureTtsToWavBuffer({ text, voiceName, rate }, { key, region }) {
  const ssml = `
<speak version="1.0" xml:lang="en-US">
  <voice xml:lang="en-US" name="${voiceName}">
    <prosody rate="${rate}">
      ${escapeXml(text)}
    </prosody>
  </voice>
</speak>`.trim();

  // token
  const tokenRes = await fetch(`https://${region}.api.cognitive.microsoft.com/sts/v1.0/issuetoken`, {
    method: "POST",
    headers: { "Ocp-Apim-Subscription-Key": key },
  });
  if (!tokenRes.ok) {
    const t = await tokenRes.text();
    throw new Error(`Azure token failed: ${tokenRes.status} ${t}`);
  }
  const token = await tokenRes.text();

  const ttsRes = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "riff-16khz-16bit-mono-pcm",
      "User-Agent": "shadow-speak-functions",
    },
    body: ssml,
  });

  if (!ttsRes.ok) {
    const t = await ttsRes.text();
    throw new Error(`Azure TTS failed: ${ttsRes.status} ${t}`);
  }

  const arrayBuf = await ttsRes.arrayBuffer();
  return Buffer.from(arrayBuf);
}

function escapeXml(s) {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
/* =========================================================
   ✅ 9) Storage: official/*.txt → WAV 自動生成（Level/Patternで声&速度）
   ========================================================= */
exports.generateMp3FromOfficialTxt = onObjectFinalized(
  {
    region: "asia-northeast1",
    timeoutSeconds: 540,
    memory: "1GiB",
    secrets: [SPEECH_KEY, SPEECH_REGION],
  },
  async (event) => {
    const object = event.data;
    const filePath = object.name;
    if (!filePath) return;

    // official の txt だけ
    if (!isOfficialTxt(filePath)) return;

    // evaluation を Lesson直下に置く運用でも拾えるように
    const { level, lesson, pattern } = extractMetaFromOfficialPath(filePath);
    if (!level || !lesson || !pattern) return;

    const bucket = storage.bucket(object.bucket);

    // 出力先（.txt → .wav）
    const outPath = toTtsAudioOutPathFromTxt(filePath);
    if (!outPath) return;

    // 既に音声があるならスキップ（作り直したいならwav消す）
    const [exists] = await bucket.file(outPath).exists();
    if (exists) {
      console.log("⏭ TTS audio exists. skip:", outPath);
      return;
    }

    // txt を読む
    const [buf] = await bucket.file(filePath).download();
    const text = buf.toString("utf-8").replace(/\s+/g, " ").trim();
    if (!text) {
      console.log("⚠️ empty txt:", filePath);
      return;
    }

    // 設定（pattern→voice, level→rate）
    const voiceName = pickVoiceName({ pattern });
    const rate = pickRate({ level });

    const key = process.env.SPEECH_KEY;
    const region = process.env.SPEECH_REGION;
    if (!key || !region) throw new Error("SPEECH_KEY / SPEECH_REGION missing");

    console.log("🎙 TTS:", { filePath, outPath, level, lesson, pattern, voiceName, rate });

    const wavBuf = await azureTtsToWavBuffer({ text, voiceName, rate }, { key, region });

    await bucket.file(outPath).save(wavBuf, {
      contentType: "audio/wav",
      resumable: false,
      metadata: { cacheControl: "no-cache" },
    });

    console.log("✅ TTS wav uploaded:", outPath);
  }
);


/* =========================================================
   ✅ 10) Dictation（Lesson/Pattern 統一1本）
   - trigger: official/**/


const STOPWORDS = new Set([
  "the","a","an","and","or","but","so","to","of","in","on","at","for","from","with","as",
  "is","are","was","were","be","been","being","am",
  "i","you","he","she","it","we","they","me","him","her","them","my","your","his","their","our",
  "this","that","these","those",
  "not","no","yes","do","does","did","done",
  "have","has","had",
  "will","would","can","could","may","might","should","must"
]);

function normalizeWord(w) {
  return (w || "")
    .toString()
    .trim()
    .replace(/^[^\w']+|[^\w']+$/g, "")
    .toLowerCase();
}

function tokenize(text) {
  return (text || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(/\s+/)
    .map(normalizeWord)
    .filter(Boolean);
}

function splitSentences(text) {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (!t) return [];
  return t.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
}

function uniqueWordsInText(text) {
  const seen = new Set();
  const out = [];
  for (const w of tokenize(text)) {
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

function pickAnswerWordsFromSnippet(snippet, n) {
  const candidates = uniqueWordsInText(snippet)
    .filter(w => w.length >= 4)
    .filter(w => !STOPWORDS.has(w))
    .filter(w => !/^\d+$/.test(w));
  return candidates.slice(0, n);
}

function replaceOnceWholeWord(text, word, replacement) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\b${escaped}\\b`, "i");
  return text.replace(re, replacement);
}

function firstIndexOfWholeWord(text, word) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\b${escaped}\\b`, "i");
  const m = re.exec(text);
  return m ? m.index : Number.POSITIVE_INFINITY;
}

// ✅ answers順＝空所順 を保証
function buildClozeFromSnippet(snippet, blankCount) {
  let out = (snippet || "").replace(/\s+/g, " ").trim();
  if (!out) return { sentence: "", answers: [] };

  // まず候補語を作る（ユニーク語）
  const pool = uniqueWordsInText(out)
    .filter(w => w.length >= 4)
    .filter(w => !STOPWORDS.has(w))
    .filter(w => !/^\d+$/.test(w));

  const picked = [];
  let working = out;

  // ✅ 文の左から順に「見つかった語」を採用していく
  // これで answers の順番＝空所の順番 が100%一致する
  while (picked.length < blankCount) {
    let best = null; // { w, idx }
    for (const w of pool) {
      if (picked.includes(w)) continue;
      const idx = firstIndexOfWholeWord(working, w);
      if (!Number.isFinite(idx)) continue;
      if (best == null || idx < best.idx) best = { w, idx };
    }
    if (!best) break;

    picked.push(best.w);
    working = replaceOnceWholeWord(working, best.w, "________");
  }

  const blanks = (working.match(/_{3,}/g) || []).length;
  const answers = picked.slice(0, blanks);

  return { sentence: working, answers };
}

function stableSortPassageMap(entries) {
  return entries.sort((a, b) => (a.passage || 999) - (b.passage || 999));
}

function jaccard(a, b) {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  const uni = A.size + B.size - inter;
  return uni ? inter / uni : 0;
}

function pickDistinctSnippets(snippets, count, { maxSim = 0.45 } = {}) {
  const picked = [];
  for (const s of snippets) {
    if (!s) continue;
    const ok = picked.every(p => jaccard(p, s) <= maxSim);
    if (ok) picked.push(s);
    if (picked.length >= count) break;
  }
  for (const s of snippets) {
    if (picked.length >= count) break;
    if (!picked.includes(s)) picked.push(s);
  }
  return picked.slice(0, count);
}

// ✅ “長め”を狙って 2文取る（C用）
function pickSnippetNSentences(mergedText, n) {
  const sents = splitSentences(mergedText);
  if (sents.length === 0) return "";
  if (n <= 1) return sents[0].trim();

  // なるべく自然な2文（長すぎたら1文に落とす）
  const two = `${sents[0]} ${sents[1] || ""}`.trim();
  if (two.length <= 260 && (sents[1] || "").length > 0) return two;
  return sents[0].trim();
}

exports.generateDictationForLessonPattern = onObjectFinalized(
  { region: "asia-northeast1", timeoutSeconds: 540, memory: "1GiB" },
  async (event) => {
    const object = event.data;
    const filePath = object.name;
    if (!filePath) return;

    if (!isOfficialPath(filePath)) return;
    if (!isSubtitlesJson(filePath)) return;

    if (filePath.includes("/evaluation/")) return;
    if (filePath.includes("/dictation_audio/")) return;

    const { level, lesson, pattern } = extractMetaFromOfficialPath(filePath);
    if (!level || !lesson || !pattern) return;

    const bucket = storage.bucket(object.bucket);
    const dictPath = `official/${level}/${lesson}/${pattern}/dictation.json`;

    console.log("♻️ rebuild dictation.json:", dictPath);

    const prefix = `official/${level}/${lesson}/${pattern}/`;
    const [files] = await bucket.getFiles({ prefix });

    const subtitleFiles = files
      .map(f => f.name)
      .filter(p => isSubtitlesJson(p))
      .filter(p => !p.includes("/evaluation/"))
      .filter(p => !p.includes("/dictation_audio/"));

    if (subtitleFiles.length === 0) {
      console.log("⚠️ no subtitles found under:", prefix);
      return;
    }

    // passageごとに集める
    const byPassage = new Map();
    for (const p of subtitleFiles) {
      const passage = extractPassageNumber(p) ?? 999;
      const [buf] = await bucket.file(p).download();
      const sub = JSON.parse(buf.toString("utf-8"));
      const t = (sub.text || "").replace(/\s+/g, " ").trim();
      if (!t) continue;

      if (!byPassage.has(passage)) byPassage.set(passage, { passage, texts: [] });
      byPassage.get(passage).texts.push(t);
    }

    const passages = stableSortPassageMap(Array.from(byPassage.values()));
    if (passages.length === 0) {
      console.log("⚠️ no valid passage text:", prefix);
      return;
    }

    // ✅ passageごとに merged を作り、そこから「文リスト」を作る
    const mergedList = passages
      .map(p => ({
        passage: p.passage,
        merged: p.texts.join(" ").replace(/\s+/g, " ").trim(),
      }))
      .filter(x => x.merged.length >= 20);

    if (mergedList.length === 0) {
      console.log("⚠️ no usable merged text:", prefix);
      return;
    }

    // ✅ 候補スニペットを作る
    // - passageが複数あるなら基本は別passageから取れる
    // - 1つしかなくても、文をバラして複数候補を作る
    let candidates = [];

    for (const m of mergedList) {
      const sents = splitSentences(m.merged);

      // 1文候補（A/B用）
      for (const s of sents) {
        const ss = s.trim();
        if (ss.length >= 20) candidates.push(ss);
      }

      // 2文候補（C用に長め）
      if (sents.length >= 2) {
        const two = `${sents[0]} ${sents[1]}`.trim();
        if (two.length >= 40) candidates.push(two);
      }
    }

    candidates = candidates
      .map(s => s.replace(/\s+/g, " ").trim())
      .filter(Boolean);

    // ✅ 似すぎ回避で A/B/C を選ぶ（候補が少なくても補充される）
    const [sA, sB, sCraw] = pickDistinctSnippets(candidates, 3, { maxSim: 0.45 });

    // ✅ Cは「長め優先」に寄せる（2文候補があればそっちを使う）
    // sCraw が短ければ、merged先頭2文を使う
    let sC = sCraw;
    if (!sC || sC.length < 80) {
      // 一番長くなりそうな merged から2文取る
      const longest = mergedList.slice().sort((a, b) => b.merged.length - a.merged.length)[0];
      sC = pickSnippetNSentences(longest.merged, 2);
    }

    const A1 = buildClozeFromSnippet(sA, 2);
    const B1 = buildClozeFromSnippet(sB, 3);

    // Cは長いなら4、短いなら3
    const wantC = (sC.length >= 120) ? 4 : 3;
    const C1 = buildClozeFromSnippet(sC, wantC);

    // text は採用した3問の元文（デバッグにも使える）
    const textForDebug = [sA, sB, sC].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();

    const out = {
      type: "dictation",
      lessonId: `${level}_${lesson}_${pattern}`,
      sourcePrefix: prefix,
      text: textForDebug,
      parts: {
        A: [{ id: "A1", sentence: A1.sentence, answers: A1.answers }],
        B: [{ id: "B1", sentence: B1.sentence, answers: B1.answers }],
        C: [{ id: "C1", sentence: C1.sentence, answers: C1.answers }],
      },
      createdAt: new Date().toISOString(),
    };

    await bucket.file(dictPath).save(JSON.stringify(out, null, 2), {
      contentType: "application/json",
      resumable: false,
      metadata: { cacheControl: "no-cache" },
    });

    console.log("✅ dictation.json created:", dictPath);

    const patternDocId = toDocIdFromPath(`official/${level}/${lesson}/${pattern}`);
    await db.collection("official_materials").doc(patternDocId).set(
      {
        type: "Official",
        level,
        lesson,
        pattern,
        dictationPath: dictPath,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }
);



/* =========================================================
   ✅ 11) Dictation音声 自動生成（dictation.json → dictation_audio/**.wav）
   - trigger: official/**/

function fillBlanks(template, answers) {
  let idx = 0;
  return (template || "")
    .replace(/_{3,}/g, () => {
      const w = answers && idx < answers.length ? answers[idx] : "____";
      idx += 1;
      return w;
    })
    .replace(/\s+/g, " ")
    .trim();
}

function buildQuestionText(group, q) {
  const answers = q.answers || [];

  // A/C: sentence を埋め戻した完全文
  if (group === "A" || group === "B" || group === "C") {
    return fillBlanks(q.sentence || "", answers);
  }



  return "";
}

exports.generateDictationAudioFromDictationJson = onObjectFinalized(
  { region: "asia-northeast1", timeoutSeconds: 540, memory: "1GiB", secrets: [SPEECH_KEY, SPEECH_REGION] },
  async (event) => {
    const object = event.data;
    const filePath = object.name;
    if (!filePath) return;
    if (!isDictationJson(filePath)) return;

    const bucket = storage.bucket(object.bucket);

    const [buf] = await bucket.file(filePath).download();
    const dict = JSON.parse(buf.toString("utf-8"));

    const parts = dict.parts || {};
    const baseDir = filePath.replace(/\/dictation\.json$/i, ""); // official/Level5/Lesson3/D

    const key = process.env.SPEECH_KEY;
    const region = process.env.SPEECH_REGION;
    const voiceName = "en-US-JennyNeural";
    const rate = "0.85";

    const jobs = [];
    for (const group of ["A", "B", "C"]) {
      const qs = Array.isArray(parts[group]) ? parts[group] : [];
      for (const q of qs) {
        const id = q.id;
        if (!id) continue;
        const outPath = `${baseDir}/dictation_audio/${group}/${id}.wav`;
        jobs.push({ group, id, outPath, q });
      }
    }

    if (jobs.length === 0) {
      console.log("⚠️ no dictation questions:", filePath);
      return;
    }

    // 既存チェック（全部あるなら終了）
    let allExist = true;
    for (const j of jobs) {
      const [ex] = await bucket.file(j.outPath).exists();
      if (!ex) { allExist = false; break; }
    }
    if (allExist) {
      console.log("⏭ all dictation audio exists. skip.");
      return;
    }

    // 生成
    for (const j of jobs) {
      const [ex] = await bucket.file(j.outPath).exists();
      if (ex) continue;

      try {
        const text = buildQuestionText(j.group, j.q);
        if (!text) continue;

        const wavBuf = await azureTtsToWavBuffer(
          { text, voiceName, rate },
          { key, region }
        );

        await bucket.file(j.outPath).save(wavBuf, {
          contentType: "audio/wav",
          resumable: false,
          metadata: { cacheControl: "no-cache" },
        });

        console.log("✅ dictation wav uploaded:", j.outPath);
      } catch (e) {
        console.error("❌ dictation audio failed:", j.outPath, e);
      }
    }
  }
);
function toJaSubtitlesPath(p) {
  if (typeof p !== "string") return null;

  const lower = p.toLowerCase();

  // ✅ 変な旧ルールが来たら正規化して返す
  if (lower.endsWith("_subtitles_ja.json")) {
    return p.replace(/_subtitles_ja\.json$/i, "_ja.json");
  }

  // ✅ すでに正しい ja なら何もしない
  if (lower.endsWith("_ja.json")) return null;

  // ✅ 英語字幕（Whisper生成）: xxx_subtitles.json → xxx_ja.json
  if (lower.endsWith("_subtitles.json")) {
    return p.replace(/_subtitles\.json$/i, "_ja.json");
  }

  // 念のため
  if (lower.endsWith(".json")) {
    return p.replace(/\.json$/i, "_ja.json");
  }

  return null;
}


exports.generateJaSubtitleJson = onObjectFinalized(
  { region: "asia-northeast1", timeoutSeconds: 540, memory: "1GiB", secrets: [OPENAI_API_KEY] },
  async (event) => {
    const object = event.data;
    const filePath = object.name;
    if (!filePath) return;

    // ✅ 対象は「Whisperで作った字幕JSON」だけ
    if (!isSubtitlesJson(filePath)) return;

    // ✅ evaluationは要件次第：作りたいなら外さない。作りたくないなら return;
    // if (filePath.includes("/evaluation/")) return;

    // ✅ すでにjaは無限ループ防止
    const jaPath = toJaSubtitlesPath(filePath);
    if (!jaPath) return;

    const bucket = storage.bucket(object.bucket);

    // 既に存在するならスキップ
    const [exists] = await bucket.file(jaPath).exists();
    if (exists) {
      console.log("⏭ ja subtitles exists. skip:", jaPath);
      return;
    }

    // 元JSONを読む
    const [buf] = await bucket.file(filePath).download();
    const src = JSON.parse(buf.toString("utf-8"));

    if (!Array.isArray(src.segments)) return;
    // languageがenでなくても翻訳したいならこの判定は外してOK
    // if (src.language && src.language !== "en") return;

    const jaJson = await translateSegmentsToJa(src, process.env.OPENAI_API_KEY);

    // 保存（UTF-8）
    await bucket.file(jaPath).save(JSON.stringify(jaJson, null, 2), {
      contentType: "application/json; charset=utf-8",
      resumable: false,
      metadata: { cacheControl: "no-cache" },
    });

    console.log("✅ created ja subtitles:", jaPath);
  }
);

async function translateSegmentsToJa(src, apiKey) {
  if (!apiKey) throw new Error("OPENAI_API_KEY missing");

  // segmentsだけ送る（トークン節約）
  const input = {
    language: "ja",
    segments: src.segments.map((s) => ({
      id: s.id,
      start: s.start,
      end: s.end,
      text: s.text,
    })),
  };

  const payload = {
    model: "gpt-4.1-mini",
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "Translate English subtitle segments to natural Japanese. Keep id/start/end unchanged. Output JSON only." },
      { role: "user", content: JSON.stringify(input) },
    ],
  };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(text);

  const data = JSON.parse(text);
  const content = data.choices?.[0]?.message?.content;
  const out = JSON.parse(content);

  // 念のため timing は元を強制採用（ズレ防止）
  return {
    language: "ja",
    text: "", // 必要なら後で segments 連結で作ってもOK
    segments: src.segments.map((s, i) => ({
      id: s.id,
      start: s.start,
      end: s.end,
      text: out.segments?.[i]?.text ?? "",
    })),
  };
}
