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
  SecureAudioAccessError,
  assertPathPrefix,
  assertTeacherOutputPath,
  enforceRateLimit,
  requireStudentSession,
  requireTeacherSession,
  resolveStoragePath,
  validateAudioObject,
} = require("./secure_audio_access");

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
function toJaSubtitlesPath(filePath) {
  if (typeof filePath !== "string") return null;
  if (!filePath.toLowerCase().endsWith("_subtitles.json")) return null;
  return filePath.replace(/_subtitles\.json$/i, "_ja.json");
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
function buildSubtitleJsonPath(filePath) {
  if (typeof filePath !== "string") return null;

  // school_materials/.../audio/xxx.mp3
  // → school_materials/.../subtitles/xxx_subtitles.json
  if (filePath.startsWith("school_materials/")) {
    return filePath
      .replace(/\/audio\//i, "/subtitles/")
      .replace(/\.(wav|mp3|m4a|aac|ogg)$/i, "_subtitles.json");
  }

  // uploads/.../audio/xxx.mp3
  // → uploads/.../subtitles/xxx_subtitles.json
  if (filePath.startsWith("uploads/")) {
    return filePath
      .replace(/\/audio\//i, "/subtitles/")
      .replace(/\.(wav|mp3|m4a|aac|ogg)$/i, "_subtitles.json");
  }

  // official は従来どおり
  return filePath.replace(
    /\.(wav|mp3|m4a|aac|ogg)$/i,
    "_subtitles.json"
  );
}
function buildWaveformJsonPath(filePath) {
  if (typeof filePath !== "string") return null;

  // school_materials/.../audio/xxx.wav
  // → school_materials/.../waveforms/xxx_waveform.json
  if (filePath.startsWith("school_materials/")) {
    return filePath
      .replace(/\/audio\//i, "/waveforms/")
      .replace(/\.(wav|mp3|m4a|aac|ogg)$/i, "_waveform.json");
  }

  // uploads/.../audio/xxx.wav
  // → uploads/.../waveforms/xxx_waveform.json
  if (filePath.startsWith("uploads/")) {
    return filePath
      .replace(/\/audio\//i, "/waveforms/")
      .replace(/\.(wav|mp3|m4a|aac|ogg)$/i, "_waveform.json");
  }

  // official は音声と同じ場所に作る
  return filePath.replace(
    /\.(wav|mp3|m4a|aac|ogg)$/i,
    "_waveform.json"
  );
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
  A: "en-US-DavisNeural",
  B: "en-US-BrandonNeural",
  C: "en-US-JennyNeural",
  D: "en-US-GuyNeural",
  E: "en-US-AriaNeural",
  F: "en-US-BrandonNeural",
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

exports.buildLegacyMaterialsOnOfficialUpload = onObjectFinalized(
  { region: "asia-northeast1", timeoutSeconds: 540, memory: "1GiB" },
  async (event) =>{
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
       .audioCodec("pcm_s16le")
    .audioChannels(1)
       .audioFrequency(16000)
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

async function convertTo16kMonoWav(inputPath, outputPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);

  await new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioCodec("pcm_s16le")
      .audioChannels(1)
      .audioFrequency(16000)
      .toFormat("wav")
      .on("end", resolve)
      .on("error", reject)
      .save(outputPath);
  });
}


function findWavChunk(buffer, chunkName) {
  if (buffer.length < 12) return null;
  if (buffer.toString("ascii", 0, 4) !== "RIFF") return null;
  if (buffer.toString("ascii", 8, 12) !== "WAVE") return null;

  let offset = 12;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;

    if (id === chunkName) {
      return { start, size };
    }

    offset = start + size + (size % 2);
  }

  return null;
}

function createWaveformJsonFromWavFile(
  wavPath,
  { samplesPerSecond = 100 } = {}
) {
  const buffer = fs.readFileSync(wavPath);

  const fmt = findWavChunk(buffer, "fmt ");
  const data = findWavChunk(buffer, "data");

  if (!fmt || !data) {
    throw new Error("Invalid WAV: fmt/data chunk not found");
  }

  const audioFormat = buffer.readUInt16LE(fmt.start);
  const channels = buffer.readUInt16LE(fmt.start + 2);
  const sampleRate = buffer.readUInt32LE(fmt.start + 4);
  const bitsPerSample = buffer.readUInt16LE(fmt.start + 14);

  // 1 = PCM, 65534 = WAVE_FORMAT_EXTENSIBLE
  if (audioFormat !== 1 && audioFormat !== 65534) {
    throw new Error(`Unsupported WAV format: ${audioFormat}`);
  }

  if (bitsPerSample !== 16) {
    throw new Error(`Unsupported bitsPerSample: ${bitsPerSample}`);
  }

  if (channels <= 0 || sampleRate <= 0) {
    throw new Error(
      `Invalid WAV info: channels=${channels}, sampleRate=${sampleRate}`
    );
  }

  const bytesPerSample = bitsPerSample / 8;
  const frameSize = channels * bytesPerSample;
  const totalFrames = Math.floor(data.size / frameSize);
  const windowFrames = Math.max(1, Math.floor(sampleRate / samplesPerSecond));

  const raw = [];

  for (let frameStart = 0; frameStart < totalFrames; frameStart += windowFrames) {
    const frameEnd = Math.min(totalFrames, frameStart + windowFrames);

    let sumSq = 0;
    let count = 0;

    for (let frame = frameStart; frame < frameEnd; frame++) {
      const base = data.start + frame * frameSize;
      let peak = 0;

      for (let ch = 0; ch < channels; ch++) {
        const pos = base + ch * bytesPerSample;
        if (pos + 2 > buffer.length) continue;

        const sample = buffer.readInt16LE(pos);
        const amp = Math.abs(sample) / 32768;
        if (amp > peak) peak = amp;
      }

      sumSq += peak * peak;
      count++;
    }

    const rms = Math.sqrt(sumSq / Math.max(1, count));
    raw.push(rms);
  }

  let maxRms = 0.00001;
  for (const v of raw) {
    if (v > maxRms) maxRms = v;
  }

  const values = raw.map((v) => {
    const normalized = Math.round((v / maxRms) * 255);
    return Math.max(0, Math.min(255, normalized));
  });

  const durationMs = Math.round((totalFrames / sampleRate) * 1000);

  return {
    version: 1,
    durationMs,
    samplesPerSecond,
    values,
  };
}

async function saveWaveformJsonFromWav({
  bucket,
  wavPath,
  waveformStoragePath,
  samplesPerSecond = 100,
}) {
  if (!waveformStoragePath) return null;

  const [exists] = await bucket.file(waveformStoragePath).exists();
  if (exists) {
    console.log("⏭ waveform json already exists. skip:", waveformStoragePath);

    const [existingBuf] = await bucket.file(waveformStoragePath).download();
    return JSON.parse(existingBuf.toString("utf-8"));
  }

  const waveform = createWaveformJsonFromWavFile(wavPath, {
    samplesPerSecond,
  });

  await bucket.file(waveformStoragePath).save(
    JSON.stringify(waveform),
    {
      resumable: false,
      metadata: {
        contentType: "application/json; charset=utf-8",
        cacheControl: "no-cache",
      },
    }
  );

  console.log("✅ waveform json saved:", waveformStoragePath);

  return waveform;
}

/* =========================================================
   🎵 1.5) uploads / school_materials の mp3/m4a/aac/ogg → WAV 自動変換
   ========================================================= */
exports.convertUploadedAudioToWav = onObjectFinalized(
  {
    region: "asia-northeast1",
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  async (event) => {
    const object = event.data;
    const filePath = object.name;
    const contentType = object.contentType || "";

    if (!filePath) return;

    const isTeacherUpload =
      typeof filePath === "string" && filePath.startsWith("uploads/");
    const isSchoolMaterialAudio =
      typeof filePath === "string" && filePath.startsWith("school_materials/");

    if (!isTeacherUpload && !isSchoolMaterialAudio) return;

    // wav / webm はここでは対象外
    if (/\.wav$/i.test(filePath)) return;
    if (isWebm(filePath, contentType)) return;

    // mp3 / m4a / aac / ogg のみ変換
    if (!/\.(mp3|m4a|aac|ogg)$/i.test(filePath)) return;

    const bucket = storage.bucket(object.bucket);
    const wavPath = filePath.replace(/\.(mp3|m4a|aac|ogg)$/i, ".wav");

    const [wavExists] = await bucket.file(wavPath).exists();
    if (wavExists) {
      console.log("⏭ wav already exists:", wavPath);
      return;
    }

    const tmpIn = path.join(os.tmpdir(), path.basename(filePath));
    const tmpOut = path.join(
      os.tmpdir(),
      `${path.parse(filePath).name}.wav`
    );

    try {
      await bucket.file(filePath).download({ destination: tmpIn });
      console.log("⬇️ Downloaded source audio:", tmpIn);

      await convertTo16kMonoWav(tmpIn, tmpOut);

      await bucket.upload(tmpOut, {
        destination: wavPath,
        metadata: { contentType: "audio/wav" },
      });

      console.log("✅ converted uploaded audio to wav:", wavPath);

      // TeacherUpload ドキュメントが mp3 を指しているなら wav に切り替える
      const q = await db
        .collectionGroup("materials")
        .where("type", "==", "TeacherUpload")
        .get();

      const matchedDocs = q.docs.filter((doc) => {
        const data = doc.data() || {};
        return data.storagePath === filePath;
      });

      if (matchedDocs.length > 0) {
        const batch = db.batch();
        matchedDocs.forEach((doc) => {
          batch.set(
            doc.ref,
            {
              originalStoragePath: filePath,
              storagePath: wavPath,
              convertedWavPath: wavPath,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        });
        await batch.commit();
        console.log("✅ TeacherUpload storagePath switched to wav:", wavPath);
      } else {
        console.log("ℹ️ no TeacherUpload material matched for wav switch:", filePath);
      }
    } catch (e) {
      console.error("❌ convertUploadedAudioToWav failed:", e);
    } finally {
      try {
        if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn);
      } catch (_) {}
      try {
        if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
      } catch (_) {}
    }
  }
);


/* =========================================================
   🧠 2) Whisper 呼び出し
   ========================================================= */
async function callWhisperVerboseJson(filePath, { wantWords }) {
  const file = fs.createReadStream(filePath);

  const form = new FormData();
  form.append("file", file);
  form.append("model", "whisper-1");          // ✅ こっちに戻す
  form.append("language", "en");
  form.append("response_format", "verbose_json"); // ✅ whisper-1ならOK

  if (wantWords) {
    form.append("timestamp_granularities[]", "word");
    form.append("timestamp_granularities[]", "segment");
  } else {
    form.append("timestamp_granularities[]", "segment");
  }

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, ...form.getHeaders() },
    body: form,
  });

  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}


/* =========================================================
   🪄 3) Whisper → アプリ用 JSON（ルール1：一切補完しない）
   ========================================================= */
function formatWhisperToAppJson(result) {
  const out = {
    text: result.text || "",
    language: result.language || "en",
    segments: [],
  };

  if (!Array.isArray(result.segments)) return out;

  out.segments = result.segments.map((seg, idx) => {
    const start = Number(seg.start);
    const end = Number(seg.end);

    // ✅ Whisperが返した words だけを使う
    const words = Array.isArray(seg.words)
      ? seg.words
          .filter(w => w.start != null && w.end != null)
          .map(w => ({
            word: (w.word || "").trim(),
            start: Number(w.start),
            end: Number(w.end),
            probability: w.probability ?? 1,
          }))
      : [];

    return {
      id: idx,
      start,
      end,
      text: seg.text || "",
      words,          // ← 空配列あり得る（それでOK）
    };
  });

  return out;
}/* =========================================================
   🎧 4) Storage: 音声 → _subtitles.json 生成（Azure STT版）
      + ✅ TXTから sentenceSegments を復元（句読点・改行）
      + ✅ A案：segments を「文単位」に置換して互換維持
      + ✅ TeacherUpload (uploads/) / school_materials に対応
      + ✅ 空結果は保存せず error に落とす
   ========================================================= */
exports.generateSubtitleJson = onObjectFinalized(
  {
    region: "asia-northeast1",
    timeoutSeconds: 540,
    memory: "1GiB",
    secrets: [SPEECH_KEY, SPEECH_REGION],
  },
  async (event) => {
    const object = event.data;
    const filePath = object.name;
    const contentType = object.contentType;
    if (!filePath) return;

    console.log("🟢 generateSubtitleJson:", filePath);
    console.log("contentType =", contentType);

    // WebMは convertWebmToWav に任せる
    if (isWebm(filePath, contentType)) {
      console.log("⏭ Skip: handled by convertWebmToWav");
      return;
    }

    // 音声だけ
    if (!isAudioFile(filePath)) {
      console.log("⏭ Skip: not audio file", filePath);
      return;
    }

    // official / uploads / school_materials の音声を対象にする
    const isOfficial = isOfficialPath(filePath);
    const isTeacherUpload =
      typeof filePath === "string" && filePath.startsWith("uploads/");
    const isSchoolMaterialAudio =
      typeof filePath === "string" &&
      filePath.startsWith("school_materials/") &&
      filePath.includes("/audio/");

    console.log("isOfficial =", isOfficial);
    console.log("isTeacherUpload =", isTeacherUpload);
    console.log("isSchoolMaterialAudio =", isSchoolMaterialAudio);

    if (!isOfficial && !isTeacherUpload && !isSchoolMaterialAudio) {
      console.log("⏭ Skip: unsupported path", filePath);
      return;
    }

    if ((isTeacherUpload || isSchoolMaterialAudio) && !/\.wav$/i.test(filePath)) {
      console.log("⏭ Skip non-wav teacher audio. waiting for wav conversion:", filePath);
      return;
    }

    const bucket = storage.bucket(object.bucket);
    const transcriptPath = buildSubtitleJsonPath(filePath);
    const waveformPath = buildWaveformJsonPath(filePath);

    console.log("transcriptPath =", transcriptPath);
    console.log("waveformPath =", waveformPath);

    const [subtitleExists] = await bucket.file(transcriptPath).exists();
    const [waveformExists] = waveformPath
      ? await bucket.file(waveformPath).exists()
      : [true];

    console.log("subtitleExists =", subtitleExists);
    console.log("waveformExists =", waveformExists);

    if (subtitleExists && waveformExists) {
      console.log("⏭ subtitles and waveform json exist. skip:", {
        transcriptPath,
        waveformPath,
      });
      return;
    }

    const tmpIn = path.join(os.tmpdir(), path.basename(filePath));
    await bucket.file(filePath).download({ destination: tmpIn });
    console.log("⬇️ Downloaded audio:", tmpIn);

    let sttInputPath = tmpIn;
    let tmpWavForStt = null;
    let tmpJson = null;

    try {
      // =====================================================
      // official は今まで通り
      // uploads / school_materials は必ず STT 用に正規化する
      // =====================================================
      const needsStrictNormalization = isTeacherUpload || isSchoolMaterialAudio;

      if (needsStrictNormalization) {
        tmpWavForStt = path.join(
          os.tmpdir(),
          `${path.parse(filePath).name}_for_stt.wav`
        );

        await convertTo16kMonoWav(tmpIn, tmpWavForStt);

        sttInputPath = tmpWavForStt;
        console.log("🎧 normalized for teacher STT:", sttInputPath);
      } else if (!/\.wav$/i.test(filePath)) {
        // official 側の従来挙動は残す
        tmpWavForStt = path.join(
          os.tmpdir(),
          `${path.parse(filePath).name}_for_stt.wav`
        );

        await convertTo16kMonoWav(tmpIn, tmpWavForStt);

        sttInputPath = tmpWavForStt;
        console.log("🎧 converted for official/non-wav STT:", sttInputPath);
      } else {
        // official の wav は従来通りそのまま使う
        sttInputPath = tmpIn;
        console.log("🎧 using original wav for STT:", sttInputPath);
      }
      try {
        const stat = fs.statSync(sttInputPath);
        console.log("📦 STT input size(bytes) =", stat.size);
      } catch (e) {
        console.log("⚠ failed to stat sttInputPath:", e);
      }

      if (!waveformExists && waveformPath) {
        try {
          console.log("🌊 about to save waveform json:", waveformPath);
          await saveWaveformJsonFromWav({
            bucket,
            wavPath: sttInputPath,
            waveformStoragePath: waveformPath,
            samplesPerSecond: 100,
          });
        } catch (waveformErr) {
          console.error("⚠ waveform json generation failed:", waveformErr);
          // 字幕生成は止めない
        }
      } else {
        console.log("⏭ waveform json exists or path is missing. skip waveform generation:", waveformPath);
      }

      if (subtitleExists) {
        console.log("⏭ subtitle exists. waveform generation checked. skip Azure STT:", transcriptPath);
        return;
      }

      const key = SPEECH_KEY.value();
      const region = SPEECH_REGION.value();
      if (!key || !region) throw new Error("SPEECH_KEY / SPEECH_REGION missing");

      // Azure STT。REST short audio は長尺に弱いため、必要なら分割して結合する。
      const formatted = await transcribeWavToAppJsonWithChunking(sttInputPath, {
        key,
        region,
      });
      console.log(
        "🧠 formatted words length =",
        formatted?.segments?.[0]?.words?.length || 0
      );

      // =====================================================
      // official のみ TXT（同名 .txt）から文単位 segments を再構成
      // uploads / school_materials は txt が無い前提なのでスキップ
      // =====================================================
      if (isOfficial) {
        try {
          const scriptPath = guessScriptPathFromAudioPath(filePath);
          const [exists] = await bucket.file(scriptPath).exists();

          if (exists && formatted?.segments?.[0]?.words?.length) {
            const tmpScript = path.join(os.tmpdir(), path.basename(scriptPath));
            await bucket.file(scriptPath).download({ destination: tmpScript });

            const scriptText = fs.readFileSync(tmpScript, "utf8");
            try {
              fs.unlinkSync(tmpScript);
            } catch (_) {}

            const words = formatted.segments[0].words;

            const sentenceSegments = buildSentenceSegmentsFromScript({
              scriptText,
              words,
            });

            formatted.words = words;

            formatted.segments = sentenceSegments.map((s) => ({
              id: s.id,
              start: s.start,
              end: s.end,
              text: s.text,
              words: words.filter((w) => w.start >= s.start && w.end <= s.end),
            }));

            formatted.text = (scriptText || "").trim();
            formatted.sentenceSegments = sentenceSegments;

            console.log("✅ A-mode segments replaced:", formatted.segments.length);
            console.log("📄 script loaded:", scriptPath);
          } else {
            console.log("⚠ script not found OR no words:", scriptPath);
          }
        } catch (e) {
          console.log("⚠ sentence/segments step failed:", e);
        }
      }

      // JSON出力
      tmpJson = path.join(os.tmpdir(), path.basename(transcriptPath));
      fs.writeFileSync(tmpJson, JSON.stringify(formatted, null, 2));
      console.log("💾 tmp json written:", tmpJson);

      await bucket.upload(tmpJson, {
        destination: transcriptPath,
        metadata: { contentType: "application/json" },
      });

      console.log("📄 Uploaded JSON:", transcriptPath);

      // TeacherUpload / school_materials の場合は Firestore 更新
      // ここは失敗しても subtitle json 保存自体は成功扱いにする
    /*  if (isTeacherUpload || isSchoolMaterialAudio) {
        try {
          const q = await db
            .collectionGroup("materials")
            .where("type", "==", "TeacherUpload")
            .get();

          console.log("🔍 filePath:", filePath);
          q.docs.forEach((doc) => {
            const data = doc.data() || {};
            console.log("🔍 candidate storagePath:", data.storagePath);
          });

          const matchedDocs = q.docs.filter((doc) => {
            const data = doc.data() || {};
            return data.storagePath === filePath;
          });

          if (matchedDocs.length > 0) {
            const batch = db.batch();
            matchedDocs.forEach((doc) => {
              batch.set(
                doc.ref,
                {
                  subtitlePath: transcriptPath,
                  sttStatus: "completed",
                  sttError: admin.firestore.FieldValue.delete(),
                  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                },
                { merge: true }
              );
            });
            await batch.commit();
            console.log("✅ TeacherUpload materials updated:", filePath);
          } else {
            console.log("⚠ No TeacherUpload material matched storagePath:", filePath);
          }
        } catch (firestoreErr) {
          console.error("⚠ Firestore update failed after subtitle upload:", firestoreErr);
        }
      }
    } catch (e) {
      console.error("❌ generateSubtitleJson failed:", e);
*/
      // uploads / school_materials の場合は Firestore を error に更新
      // いったん切り分けのため停止
      /*
      if (isTeacherUpload || isSchoolMaterialAudio) {
        try {
          const q = await db
            .collectionGroup("materials")
            .where("type", "==", "TeacherUpload")
            .get();

          const matchedDocs = q.docs.filter((doc) => {
            const data = doc.data() || {};
            return data.storagePath === filePath;
          });

          if (matchedDocs.length > 0) {
            const batch = db.batch();
            matchedDocs.forEach((doc) => {
              batch.set(
                doc.ref,
                {
                  sttStatus: "error",
                  sttError: String(e?.message || e),
                  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                },
                { merge: true }
              );
            });
            await batch.commit();
            console.log("❌ TeacherUpload materials marked as error:", filePath);
          } else {
            console.log("⚠ No TeacherUpload material matched storagePath on error:", filePath);
          }
        } catch (firestoreErr) {
          console.error("⚠ Firestore error-status update failed:", firestoreErr);
        }
      }
        */
    } finally {
      try {
        if (tmpJson && fs.existsSync(tmpJson)) fs.unlinkSync(tmpJson);
      } catch (_) {}

      try {
        if (tmpIn && fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn);
      } catch (_) {}

      try {
        if (tmpWavForStt && fs.existsSync(tmpWavForStt)) fs.unlinkSync(tmpWavForStt);
      } catch (_) {}
    }
  }
);

// =========================================================
// Azure STT
// =========================================================
async function azureSpeechToTextWithWords(wavPath, { key, region }) {
  const audioBuf = fs.readFileSync(wavPath);

  const url =
    `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1` +
    `?language=en-US&format=detailed&wordLevelTimestamps=true`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": key,
      "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000",
      "Accept": "application/json",
    },
    body: audioBuf,
  });

  const text = await res.text();
  console.log("🟦 Azure raw status =", res.status);

  if (!res.ok) {
    throw new Error(`Azure STT failed: ${res.status} ${text}`);
  }

  const parsed = JSON.parse(text);
  const best = parsed?.NBest?.[0] || null;
  console.log("🟦 Azure raw summary =", {
    status: parsed?.RecognitionStatus || null,
    textLen: String(best?.Display || best?.DisplayText || parsed?.DisplayText || "").length,
    wordsLen: Array.isArray(best?.Words) ? best.Words.length : 0,
  });
  return parsed;
}

const AZURE_STT_CHUNK_SECONDS = 55;

async function splitWavForShortAzureStt(wavPath, chunkSeconds = AZURE_STT_CHUNK_SECONDS) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azure_stt_chunks_"));
  const pattern = path.join(dir, "chunk_%03d.wav");

  await new Promise((resolve, reject) => {
    ffmpeg.setFfmpegPath(ffmpegPath);
    ffmpeg(wavPath)
      .outputOptions([
        "-f segment",
        `-segment_time ${chunkSeconds}`,
        "-reset_timestamps 1",
        "-acodec pcm_s16le",
        "-ar 16000",
        "-ac 1",
      ])
      .output(pattern)
      .on("end", resolve)
      .on("error", reject)
      .run();
  });

  const files = fs
    .readdirSync(dir)
    .filter((name) => /^chunk_\d+\.wav$/i.test(name))
    .sort()
    .map((name, index) => ({
      path: path.join(dir, name),
      offsetSec: index * chunkSeconds,
    }));

  return { dir, files };
}

function offsetAzureAppJson(formatted, offsetSec, segmentIdStart) {
  const out = {
    text: formatted?.text || "",
    language: formatted?.language || "english",
    segments: [],
  };
  const segments = Array.isArray(formatted?.segments) ? formatted.segments : [];
  out.segments = segments.map((segment, index) => {
    const words = Array.isArray(segment.words)
      ? segment.words.map((word) => ({
          ...word,
          start: Number(word.start || 0) + offsetSec,
          end: Number(word.end || 0) + offsetSec,
        }))
      : [];
    return {
      ...segment,
      id: segmentIdStart + index,
      start: Number(segment.start || 0) + offsetSec,
      end: Number(segment.end || 0) + offsetSec,
      words,
    };
  });
  return out;
}

async function transcribeWavToAppJsonWithChunking(wavPath, { key, region }) {
  const { dir, files } = await splitWavForShortAzureStt(wavPath);
  if (!files.length) {
    throw new Error("Audio chunking failed: no chunks created");
  }

  console.log("🧩 Azure STT chunks =", files.length);
  const allSegments = [];
  const texts = [];

  try {
    for (let i = 0; i < files.length; i += 1) {
      const chunk = files[i];
      const stat = fs.statSync(chunk.path);
      if (stat.size <= 44) {
        console.log("⏭ skip empty STT chunk:", i);
        continue;
      }

      console.log("🧩 Azure STT chunk start:", {
        index: i + 1,
        total: files.length,
        offsetSec: chunk.offsetSec,
        bytes: stat.size,
      });
      const azureRes = await azureSpeechToTextWithWords(chunk.path, {
        key,
        region,
      });
      const formatted = formatAzureToAppJson(azureRes);
      const offset = offsetAzureAppJson(
        formatted,
        chunk.offsetSec,
        allSegments.length
      );
      if (offset.text.trim()) texts.push(offset.text.trim());
      allSegments.push(...offset.segments);
      console.log("🧩 Azure STT chunk done:", {
        index: i + 1,
        textLen: formatted.text.length,
        wordsLen: formatted.segments?.[0]?.words?.length || 0,
      });
    }
  } finally {
    try {
      for (const chunk of files) {
        if (fs.existsSync(chunk.path)) fs.unlinkSync(chunk.path);
      }
      fs.rmdirSync(dir);
    } catch (e) {
      console.log("⚠ failed to clean STT chunks:", e);
    }
  }

  const text = texts.join(" ").replace(/\s+/g, " ").trim();
  const wordCount = allSegments.reduce(
    (sum, segment) => sum + (Array.isArray(segment.words) ? segment.words.length : 0),
    0
  );
  if (!text || wordCount === 0) {
    throw new Error(`Azure STT returned empty chunked result. textLen=${text.length}, wordsLen=${wordCount}`);
  }

  return {
    text,
    language: "english",
    segments: allSegments,
  };
}

// =========================================================
// ✅ Azure detailed → app json（まずは “単一segments” を作る）
// =========================================================
function formatAzureToAppJson(azure) {
  const best = azure?.NBest?.[0];

  const display =
    best?.Display ??
    best?.DisplayText ??
    azure?.DisplayText ??
    "";

  const wordsRaw = Array.isArray(best?.Words) ? best.Words : [];

  const words = wordsRaw
    .filter((w) => w.Offset != null && w.Duration != null && w.Word)
    .map((w) => {
      const start = Number(w.Offset) / 10_000_000;
      const end = (Number(w.Offset) + Number(w.Duration)) / 10_000_000;
      return {
        word: String(w.Word).trim(),
        start,
        end,
        probability: w.Confidence ?? 1,
      };
    });

  const segStart = words.length ? words[0].start : 0;
  const segEnd = words.length ? words[words.length - 1].end : 0;

  return {
    text: display,
    language: "english",
    segments: [
      {
        id: 0,
        start: segStart,
        end: segEnd,
        text: display,
        words,
      },
    ],
  };
}

// =========================================================
// ✅ audio と同名のTXTを取る（拡張子だけ .txt）
// =========================================================
function guessScriptPathFromAudioPath(filePath) {
  return filePath.replace(/\.(wav|mp3|m4a|aac|ogg)$/i, ".txt");
}

// =========================================================
// ✅ normalize / sentence split / tokenize / build segments
// =========================================================
function normalizeToken(s) {
  return (s || "")
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[\u2019’]/g, "'")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[^a-z0-9']/g, "");
}

function splitIntoSentences(scriptText) {
  const text = (scriptText || "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{2,}/g, "\n\n")
    .trim();
  if (!text) return [];

  const paras = text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);

  const out = [];
  for (const p of paras) {
    const pp = p.replace(/\n/g, " ").replace(/\s+/g, " ").trim();

    const sentences = pp
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (sentences.length) out.push(...sentences);
    else out.push(pp);
  }
  return out;
}

function tokenizeSentence(sentence) {
  const raw = (sentence || "").split(/\s+/).filter(Boolean);
  const out = [];

  for (const r of raw) {
    if (/[’']s\b/i.test(r)) {
      const baseRaw = r.replace(/[’']s\b/i, "");
      const base = normalizeToken(baseRaw);
      if (base) out.push(base);
      out.push("s");
      continue;
    }

    const n = normalizeToken(r);
    if (!n) continue;
    out.push(n);
  }
  return out;
}

function buildSentenceSegmentsFromScript({ scriptText, words }) {
  const sentences = splitIntoSentences(scriptText);
  if (!sentences.length || !Array.isArray(words) || words.length === 0) return [];

  const wordNorm = words.map((w) => normalizeToken(w.word));
  let wi = 0;

  const segments = [];
  let sid = 0;

  const SKIP = new Set(["a", "an", "the"]);

  for (const s of sentences) {
    const stoks0 = tokenizeSentence(s);
    const stoks = stoks0.filter((t) => !SKIP.has(t));
    if (stoks.length === 0) continue;

    let startIdx = null;
    let endIdx = null;
    let matched = 0;

    const WINDOW = 30;

    for (let si = 0; si < stoks.length; si++) {
      const target = stoks[si];
      let found = -1;

      const limit = Math.min(wordNorm.length, wi + WINDOW);
      for (let k = wi; k < limit; k++) {
        if (wordNorm[k] === target) {
          found = k;
          break;
        }
      }

      if (found === -1) continue;

      if (startIdx === null) startIdx = found;
      endIdx = found;
      matched++;
      wi = found + 1;
    }

    const minMatch = Math.max(2, Math.floor(stoks.length * 0.35));
    if (startIdx === null || endIdx === null || matched < minMatch) {
      continue;
    }

    segments.push({
      id: sid++,
      start: words[startIdx].start,
      end: words[endIdx].end,
      text: s,
    });
  }

  if (segments.length === 0) {
    return [
      {
        id: 0,
        start: words[0].start,
        end: words[words.length - 1].end,
        text: (scriptText || "").trim(),
      },
    ];
  }

  return segments;
}

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
   ☎️ 6) Callable: URL → Azure STT 即時解析（WAV統一版・正規化WAV保存対応）
   ========================================================= */
exports.transcribeFromUrlV2 = onCall(
  {
    region: "asia-northeast1",
    secrets: [SPEECH_KEY, SPEECH_REGION],
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  async (req) => {
    let tmpIn = null;
    let tmpWav = null;

    try {
      const teacher = await requireTeacherSession({ db, authUid: req.auth?.uid });
      const bucket = storage.bucket();
      const storagePath = resolveStoragePath({
        data: req.data,
        expectedBucket: bucket.name,
      });
      assertPathPrefix(storagePath, [`school_materials/${teacher.schoolId}/`]);
      const subtitleStoragePath = assertTeacherOutputPath(
        req.data.subtitleStoragePath,
        teacher.schoolId,
        [".json"]
      );
      const normalizedAudioStoragePath = assertTeacherOutputPath(
        req.data.normalizedAudioStoragePath,
        teacher.schoolId,
        [".wav"]
      );
      const waveformStoragePath = assertTeacherOutputPath(
        req.data.waveformStoragePath,
        teacher.schoolId,
        [".json"]
      );
      await enforceRateLimit({
        db,
        authUid: teacher.authUid,
        operation: "teacherStt",
        limit: 30,
        windowMs: 60 * 60 * 1000,
      });

      console.log("🟦 transcribeFromUrlV2 called");
      console.log("storagePath =", storagePath);
      console.log("subtitleStoragePath =", subtitleStoragePath);
      console.log("normalizedAudioStoragePath =", normalizedAudioStoragePath);
      console.log("waveformStoragePath =", waveformStoragePath);

      // =====================================================
      // ① 既存JSON確認
      // - subtitleだけ既にある場合でも、waveformが無ければ音声を取得してwaveformだけ生成する
      // - 両方ある場合だけ即returnする
      // =====================================================
      let subtitleExists = false;
      let existingSubtitle = null;
      let waveformExists = waveformStoragePath ? false : true;

      if (subtitleStoragePath) {
        [subtitleExists] = await bucket.file(subtitleStoragePath).exists();
        if (subtitleExists) {
          console.log("⏭ subtitle already exists:", subtitleStoragePath);
          const [existingBuf] = await bucket.file(subtitleStoragePath).download();
          existingSubtitle = JSON.parse(existingBuf.toString("utf-8"));
        }
      }

      if (waveformStoragePath) {
        [waveformExists] = await bucket.file(waveformStoragePath).exists();
        console.log("waveformExists =", waveformExists);
      }

      if (subtitleExists && waveformExists) {
        console.log("⏭ subtitle and waveform already exist. skip Azure STT:", {
          subtitleStoragePath,
          waveformStoragePath,
        });

        return {
          success: true,
          skipped: true,
          reason: "subtitle_and_waveform_already_exist",
          normalizedAudioStoragePath,
          subtitleStoragePath,
          waveformStoragePath,
          subtitle: existingSubtitle,
        };
      }

      tmpIn = path.join(os.tmpdir(), `input_${Date.now()}.wav`);
      const source = await validateAudioObject({
        bucket,
        storagePath,
        maxBytes: 50 * 1024 * 1024,
      });
      await source.file.download({ destination: tmpIn });
      console.log("💾 tmp input written:", tmpIn);
      console.log("tmpIn exists =", fs.existsSync(tmpIn));

      tmpWav = path.join(os.tmpdir(), `stt_${Date.now()}.wav`);
      console.log("🎛️ about to normalize wav");
      await convertTo16kMonoWav(tmpIn, tmpWav);
      console.log("✅ wav normalized");
      console.log("tmpWav exists =", fs.existsSync(tmpWav));

      const sttInputPath = tmpWav;
      console.log("🎧 normalized for STT:", sttInputPath);

      if (waveformStoragePath && !waveformExists) {
        console.log("🌊 about to save waveform json");
        await saveWaveformJsonFromWav({
          bucket,
          wavPath: sttInputPath,
          waveformStoragePath,
          samplesPerSecond: 100,
        });
      } else {
        console.log("⏭ waveform json exists or path is missing. skip waveform generation:", waveformStoragePath);
      }

      if (subtitleExists) {
        console.log("⏭ subtitle exists. waveform generation checked. skip Azure STT:", subtitleStoragePath);
        return {
          success: true,
          skipped: true,
          reason: "subtitle_exists_waveform_checked",
          normalizedAudioStoragePath,
          subtitleStoragePath,
          waveformStoragePath,
          subtitle: existingSubtitle,
        };
      }

      // =====================================================
      // ② normalized wav も既にあるなら再アップしない
      // =====================================================
      if (normalizedAudioStoragePath) {
        const [normalizedExists] = await bucket
          .file(normalizedAudioStoragePath)
          .exists();

        if (normalizedExists) {
          console.log(
            "⏭ normalized wav already exists. skip upload:",
            normalizedAudioStoragePath
          );
        } else {
          console.log("☁️ about to upload normalized wav");
          await bucket.upload(sttInputPath, {
            destination: normalizedAudioStoragePath,
            metadata: {
              contentType: "audio/wav",
              cacheControl: "no-cache",
            },
          });
          console.log("✅ normalized wav saved:", normalizedAudioStoragePath);
        }
      }

      const key = SPEECH_KEY.value();
      const region = SPEECH_REGION.value();
      if (!key || !region) {
        throw new Error("SPEECH_KEY / SPEECH_REGION missing");
      }

      console.log("🧠 about to call Azure STT");
      const formatted = await transcribeWavToAppJsonWithChunking(sttInputPath, {
        key,
        region,
      });
      console.log("🟦 Azure STT response received");
      console.log("parsed.text length =", formatted?.text?.length || 0);
      console.log("parsed.segments length =", formatted?.segments?.length || 0);
      console.log(
        "first segment =",
        JSON.stringify(formatted?.segments?.[0] || null)
      );

      if (subtitleStoragePath) {
        console.log("☁️ about to save subtitle json");
        await bucket.file(subtitleStoragePath).save(
          JSON.stringify(formatted, null, 2),
          {
            metadata: {
              contentType: "application/json; charset=utf-8",
              cacheControl: "no-cache",
            },
          }
        );
        console.log("✅ subtitle json saved:", subtitleStoragePath);
      }

      return {
        success: true,
        skipped: false,
        normalizedAudioStoragePath,
        subtitleStoragePath,
        waveformStoragePath,
        subtitle: formatted,
      };
    } catch (e) {
      console.error("🚨 transcribeFromUrlV2 failed:", e);
      if (e instanceof SecureAudioAccessError) {
        throw new HttpsError(e.code, e.message);
      }
      throw new HttpsError("internal", "音声解析に失敗しました。");
    } finally {
      try {
        if (tmpIn && fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn);
      } catch (_) {}
      try {
        if (tmpWav && fs.existsSync(tmpWav)) fs.unlinkSync(tmpWav);
      } catch (_) {}
    }
  }
);

/* =========================================================
   ☎️ 生徒AI採点用: URL → OpenAI Whisper STT
   - Azure Speech ではなく OpenAI whisper-1 を使用
   - 生徒録音の文字起こし専用
   ========================================================= */
exports.transcribeStudentRecording = onCall(
  {
    region: "asia-northeast1",
    secrets: [OPENAI_API_KEY],
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  async (req) => {
    let tmpIn = null;

    try {
      const student = await requireStudentSession({ db, authUid: req.auth?.uid });
      const bucket = storage.bucket();
      const storagePath = resolveStoragePath({
        data: req.data,
        expectedBucket: bucket.name,
      });
      assertPathPrefix(storagePath, [
        `users/${student.authUid}/recordings/`,
        `tempSttUploads/${student.authUid}/`,
      ]);
      await enforceRateLimit({
        db,
        authUid: student.authUid,
        operation: "studentStt",
        limit: 30,
        windowMs: 10 * 60 * 1000,
      });

      console.log("🟢 transcribeStudentRecording called");
      console.log("storagePath =", storagePath);

      tmpIn = path.join(os.tmpdir(), `student_recording_${Date.now()}.wav`);
      const source = await validateAudioObject({
        bucket,
        storagePath,
        maxBytes: 24 * 1024 * 1024,
      });
      await source.file.download({ destination: tmpIn });

      console.log("💾 student tmp audio written:", tmpIn);
      console.log("audio bytes =", source.size);

      const whisperResult = await callWhisperVerboseJson(tmpIn, {
        wantWords: false,
      });

      const text = (whisperResult.text || "").trim();
      console.log("📝 OpenAI Whisper completed", {
        textLength: text.length,
        segmentCount: Array.isArray(whisperResult.segments)
          ? whisperResult.segments.length
          : 0,
      });
      return {
        success: true,
        provider: "openai_whisper",
        text,
        subtitle: {
          text,
          language: whisperResult.language || "en",
          segments: Array.isArray(whisperResult.segments)
            ? whisperResult.segments
            : [],
        },
      };
    } catch (e) {
      console.error("🚨 transcribeStudentRecording failed:", e);
      if (e instanceof SecureAudioAccessError) {
        throw new HttpsError(e.code, e.message);
      }
      throw new HttpsError("internal", "音声解析に失敗しました。");
    } finally {
      try {
        if (tmpIn && fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn);
      } catch (_) {}
    }
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
   🔊 8) Azure TTS (SSML) -> WAV buffer  ✅ token cache + 429 retry
   ========================================================= */

// インスタンス内キャッシュ（Cloud Functionsは同一インスタンス内で再利用される）
let _azureTokenCache = { token: null, expiresAt: 0 };

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// "retry after 31 seconds" みたいな文字列が body に入ってても拾えるようにする（保険）
function parseRetryAfterSecondsFromText(t) {
  const m = String(t || "").match(/retry after\s+(\d+)\s+seconds/i);
  return m ? Number(m[1]) : null;
}

async function getAzureToken({ key, region }) {
  const now = Date.now();
  if (_azureTokenCache.token && now < _azureTokenCache.expiresAt) {
    return _azureTokenCache.token;
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const tokenRes = await fetch(
      `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issuetoken`,
      { method: "POST", headers: { "Ocp-Apim-Subscription-Key": key } }
    );

    if (tokenRes.ok) {
      const token = await tokenRes.text();
      // トークンTTLは短めなので、保守的に 9分だけキャッシュ
      _azureTokenCache = { token, expiresAt: Date.now() + 9 * 60 * 1000 };
      return token;
    }

    const body = await tokenRes.text();

    if (tokenRes.status === 429) {
      const retrySec = parseRetryAfterSecondsFromText(body);
      const waitSec = retrySec ?? (31 + attempt * 5);
      console.log(`⏳ Azure token 429. wait ${waitSec}s then retry...`);
      await sleep(waitSec * 1000);
      continue;
    }

    throw new Error(`Azure token failed: ${tokenRes.status} ${body}`);
  }

  throw new Error("Azure token failed: too many retries");
}

async function azureTtsToWavBuffer({ text, voiceName, rate }, { key, region }) {
  const ssml = `
<speak version="1.0" xml:lang="en-US">
  <voice xml:lang="en-US" name="${voiceName}">
    <prosody rate="${rate}">
      ${escapeXml(text)}
    </prosody>
  </voice>
</speak>`.trim();

  const token = await getAzureToken({ key, region });

  const ttsRes = await fetch(
    `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "riff-16khz-16bit-mono-pcm",
        "User-Agent": "shadow-speak-functions",
      },
      body: ssml,
    }
  );

  if (!ttsRes.ok) {
    const t = await ttsRes.text();

    // tokenが切れてた/無効になってた場合は1回だけ取り直して再試行（保険）
    if (ttsRes.status === 401 || ttsRes.status === 403) {
      _azureTokenCache = { token: null, expiresAt: 0 };
      const token2 = await getAzureToken({ key, region });

      const ttsRes2 = await fetch(
        `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token2}`,
            "Content-Type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": "riff-16khz-16bit-mono-pcm",
            "User-Agent": "shadow-speak-functions",
          },
          body: ssml,
        }
      );

      if (!ttsRes2.ok) {
        const t2 = await ttsRes2.text();
        throw new Error(`Azure TTS failed(after refresh): ${ttsRes2.status} ${t2}`);
      }

      return Buffer.from(await ttsRes2.arrayBuffer());
    }

    throw new Error(`Azure TTS failed: ${ttsRes.status} ${t}`);
  }

  return Buffer.from(await ttsRes.arrayBuffer());
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
    const passage = extractPassageNumber(filePath);
    if (passage !== null && passage !== 1) return;
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
    if (!isDictationJson(filePath)) return;

    const bucket = storage.bucket(object.bucket);

    // ============================
    // 1) dictation.json 読み込み
    // ============================
    const [buf] = await bucket.file(filePath).download();
    const dict = JSON.parse(buf.toString("utf-8"));
    const parts = dict.parts || {};

    const baseDir = filePath.replace(/\/dictation\.json$/i, "");
    const audioBase = `${baseDir}/dictation_audio/`;

    const { level, lesson, pattern } = extractMetaFromOfficialPath(filePath);

    const key = process.env.SPEECH_KEY;
    const region = process.env.SPEECH_REGION;
    const voiceName = pickVoiceName({ pattern });
    const rate = pickRate({ level });

    console.log("🎙 dictation TTS:", { filePath, level, lesson, pattern, voiceName, rate });

    // ============================
    // 2) 生成ジョブ作成
    // ============================
    const jobs = [];
    for (const group of ["A", "B", "C"]) {
      const qs = Array.isArray(parts[group]) ? parts[group] : [];
      for (const q of qs) {
        if (!q?.id) continue;
        jobs.push({ group, id: q.id, q });
      }
    }

    if (jobs.length === 0) {
      console.log("⚠️ no dictation questions:", filePath);
      return;
    }

// ============================
// 3) ✅ tmp に生成（全部成功したら置き換える）
// ============================
const runId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
const tmpBase = `${baseDir}/dictation_audio_tmp/${runId}/`;

const failed = [];

for (let i = 0; i < jobs.length; i++) {
  const j = jobs[i];
  const tmpOutPath = `${tmpBase}${j.group}/${j.id}.wav`;

  try {
    const text = buildQuestionText(j.group, j.q);
    if (!text) {
      failed.push({ id: j.id, reason: "empty text" });
      continue;
    }

    // ✅ 429対策：2回目以降、TTSの前に待つ（間隔が保証される）
    if (i > 0) {
      await sleep(300); // まずは300ms。まだ429出るなら 500〜1000へ
      // await sleep(250 + Math.floor(Math.random() * 200)); // 乱数版でもOK
    }

    const wavBuf = await azureTtsToWavBuffer(
      { text, voiceName, rate },
      { key, region }
    );

    await bucket.file(tmpOutPath).save(wavBuf, {
      contentType: "audio/wav",
      resumable: false,
      metadata: { cacheControl: "no-cache" },
    });

    console.log("✅ tmp dictation wav uploaded:", tmpOutPath);
  } catch (e) {
    console.error("❌ tmp dictation audio failed:", tmpOutPath, e);
    failed.push({ id: j.id, reason: String(e?.message || e) });
  }
}


    // ============================
    // 4) 失敗があれば：既存は触らず tmp を掃除して終了
    // ============================
    if (failed.length > 0) {
      console.log("🛑 dictation generation failed. keep existing audio. failed=", failed);

      // tmp掃除
      const [tmpFiles] = await bucket.getFiles({ prefix: tmpBase });
      await Promise.all(tmpFiles.map(f => f.delete().catch(() => null)));
      console.log("🧹 cleaned tmp:", tmpBase);

      return;
    }

// ============================
// 5) ✅ 全部成功：tmp → 本番へコピー（先に上書き）→ 不要な旧ファイルだけ削除 → tmp掃除
// ============================

// (1) tmp → 本番コピー（先に全部コピーして上書き）
for (const j of jobs) {
  const src = `${tmpBase}${j.group}/${j.id}.wav`;
  const dst = `${audioBase}${j.group}/${j.id}.wav`;
  await bucket.file(src).copy(bucket.file(dst));
  console.log("📦 copied:", src, "->", dst);
}

// (2) 任意：今回生成しなかった「古い wav」だけ削除（IDが減った時の掃除）
const keep = new Set(jobs.map(j => `${audioBase}${j.group}/${j.id}.wav`));
for (const group of ["A", "B", "C"]) {
  const [oldFiles] = await bucket.getFiles({ prefix: `${audioBase}${group}/` });
  await Promise.all(
    oldFiles.map(async (f) => {
      if (!keep.has(f.name)) {
        await f.delete().catch(() => null);
        console.log("🗑 removed stale:", f.name);
      }
    })
  );
}

// (3) tmp 削除
const [tmpFiles2] = await bucket.getFiles({ prefix: tmpBase });
await Promise.all(tmpFiles2.map(f => f.delete().catch(() => null)));
console.log("🧹 cleaned tmp:", tmpBase);

console.log("✅ dictation_audio replace complete:", audioBase);

  }
);


exports.generateJaSubtitleJson = onObjectFinalized(
  { region: "asia-northeast1", timeoutSeconds: 540, memory: "1GiB", secrets: [OPENAI_API_KEY] },
  async (event) => {
    const object = event.data;
    const filePath = object.name;
    if (!filePath) return;

// ✅ 自分が作った ja を再トリガーしない（無限ループ防止）
if (/_ja(_subtitles)?\.json$/i.test(filePath)) return;

// ✅ 字幕JSONだけ（それ以外は触らない）
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
try {
  exports.createReviewAccount =
    require("./create_review_account").createReviewAccount;
} catch (error) {
  if (error && error.code !== "MODULE_NOT_FOUND") throw error;
  console.warn("⚠ createReviewAccount module not found. export skipped.");
}

async function assertStudentDataAdmin(request, schoolId, teacherId) {
  const uid = request.auth && request.auth.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "ログインが必要です。");
  }

  const superAdminSnap = await db.collection("admins").doc(uid).get();
  const superAdminData = superAdminSnap.data() || {};
  const isSuperAdmin =
    superAdminSnap.exists &&
    superAdminData.active === true &&
    superAdminData.role === "superAdmin";
  if (isSuperAdmin) return { uid, role: "superAdmin" };

  if (!teacherId) {
    throw new HttpsError("permission-denied", "管理者権限を確認できません。");
  }

  const teacherSnap = await db
    .collection("schools")
    .doc(schoolId)
    .collection("teachers")
    .doc(teacherId)
    .get();
  const teacherData = teacherSnap.data() || {};
  const isSchoolAdmin =
    teacherSnap.exists &&
    teacherData.active !== false &&
    (teacherData.isAdmin === true ||
      teacherData.schoolAdmin === true ||
      teacherData.role === "schoolAdmin");
  const linkedUid =
    teacherData.authUid ||
    teacherData.firebaseUid ||
    teacherData.uid ||
    null;

  if (!isSchoolAdmin || linkedUid !== uid) {
    throw new HttpsError(
      "permission-denied",
      "完全削除はFirebase Authに紐づいた学校管理者のみ実行できます。"
    );
  }

  return { uid, role: "schoolAdmin", teacherId };
}

async function deleteIfExists(ref) {
  const snap = await ref.get();
  if (!snap.exists) return false;
  await db.recursiveDelete(ref);
  return true;
}

exports.hardDeleteStudentData = onCall(async (request) => {
  const schoolId = String(request.data.schoolId || "").trim();
  const teacherId = String(request.data.teacherId || "").trim();
  const studentDocId = String(request.data.studentDocId || "").trim();
  const internalUid = String(request.data.internalUid || "").trim() || studentDocId;
  const loginId = String(request.data.loginId || "").trim();
  const confirmLoginId = String(request.data.confirmLoginId || "").trim();
  const confirmText = String(request.data.confirmText || "").trim();

  if (!schoolId || !studentDocId || !internalUid || !loginId) {
    throw new HttpsError("invalid-argument", "必要な生徒情報が不足しています。");
  }
  if (loginId !== confirmLoginId || confirmText !== "完全削除する") {
    throw new HttpsError("invalid-argument", "確認情報が一致しません。");
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(schoolId)) {
    throw new HttpsError("invalid-argument", "schoolIdの形式が不正です。");
  }

  const actor = await assertStudentDataAdmin(request, schoolId, teacherId);

  const schoolRef = db.collection("schools").doc(schoolId);
  const studentRef = schoolRef.collection("students").doc(internalUid);
  const studentSnap = await studentRef.get();
  if (!studentSnap.exists) {
    throw new HttpsError("not-found", "対象生徒が存在しません。");
  }

  const studentData = studentSnap.data() || {};
  const storedLoginId = String(studentData.loginId || "").trim();
  const status = String(studentData.status || "").trim();
  const enrollmentStatus = String(studentData.enrollmentStatus || "").trim();
  const isEnded =
    enrollmentStatus === "ended" ||
    status === "enrollmentEnded" ||
    status === "graduated" ||
    status === "withdrawn" ||
    status === "transferred" ||
    status === "left";

  if (storedLoginId !== loginId) {
    throw new HttpsError("failed-precondition", "ログインIDが現在の生徒データと一致しません。");
  }
  if (!isEnded) {
    throw new HttpsError("failed-precondition", "先に在籍終了にしてください。");
  }

  const deletedPaths = [];

  await db.collection("admin_delete_logs").add({
    action: "hardDeleteStudentData",
    schoolId,
    studentDocId,
    internalUid,
    loginId,
    studentName: studentData.name || null,
    requestedBy: actor.uid,
    requestedRole: actor.role,
    teacherId: actor.teacherId || null,
    requestedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const classesSnap = await schoolRef.collection("classes").get();
  for (const classDoc of classesSnap.docs) {
    for (const id of new Set([studentDocId, internalUid, loginId])) {
      const classStudentRef = classDoc.ref.collection("students").doc(id);
      if (await deleteIfExists(classStudentRef)) {
        deletedPaths.push(classStudentRef.path);
      }
    }

    const materialsSnap = await classDoc.ref.collection("materials").get();
    for (const materialDoc of materialsSnap.docs) {
      for (const id of new Set([studentDocId, internalUid, loginId])) {
        const resultRef = materialDoc.ref.collection("results").doc(id);
        if (await deleteIfExists(resultRef)) {
          deletedPaths.push(resultRef.path);
        }
      }
    }
  }

  if (await deleteIfExists(studentRef)) {
    deletedPaths.push(studentRef.path);
  }

  const authUid = String(studentData.uid || studentData.authUid || "").trim();
  if (authUid) {
    const userRef = db.collection("users").doc(authUid);
    if (await deleteIfExists(userRef)) {
      deletedPaths.push(userRef.path);
    }
    await admin.auth().deleteUser(authUid).catch((error) => {
      if (error && error.code !== "auth/user-not-found") throw error;
    });
    deletedPaths.push(`auth/${authUid}`);
  }

  const bucket = storage.bucket();
  const storagePrefixes = [
    `users/${authUid}/`,
    `recordings/${authUid}/`,
    `test/temp_recordings/${authUid}/`,
    `schools/${schoolId}/students/${internalUid}/`,
    `school_materials/${schoolId}/students/${internalUid}/`,
  ].filter((prefix) => !prefix.includes("//"));

  for (const prefix of storagePrefixes) {
    const [files] = await bucket.getFiles({ prefix });
    for (const file of files) {
      await file.delete({ ignoreNotFound: true });
      deletedPaths.push(`storage/${file.name}`);
    }
  }

  return {
    ok: true,
    deletedCount: deletedPaths.length,
    deletedPaths,
  };
});

  exports.hardDeleteSchool = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "ログインが必要です。");
  }

  const adminSnap = await db.collection("admins").doc(uid).get();
  const adminData = adminSnap.data();

  const isSuperAdmin =
    adminSnap.exists &&
    adminData &&
    adminData.active === true &&
    adminData.role === "superAdmin";

  if (!isSuperAdmin) {
    throw new HttpsError(
      "permission-denied",
      "完全削除はsuperAdminのみ実行できます。"
    );
  }

  const schoolId = String(request.data.schoolId || "").trim();
  const confirmSchoolId = String(request.data.confirmSchoolId || "").trim();
  const confirmText = String(request.data.confirmText || "").trim();

  if (!schoolId || schoolId !== confirmSchoolId || confirmText !== "完全削除") {
    throw new HttpsError("invalid-argument", "確認情報が一致しません。");
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(schoolId)) {
    throw new HttpsError("invalid-argument", "schoolIdの形式が不正です。");
  }

  const schoolRef = db.collection("schools").doc(schoolId);
  const schoolSnap = await schoolRef.get();

  if (!schoolSnap.exists) {
    throw new HttpsError("not-found", "学校が存在しません。");
  }

  const schoolData = schoolSnap.data() || {};
  const isSoftDeleted =
    schoolData.deletedAt != null ||
    schoolData.status === "deleted" ||
    schoolData.contractStatus === "deleted";

  if (!isSoftDeleted) {
    throw new HttpsError(
      "failed-precondition",
      "先にAdmin画面で削除扱いにしてください。"
    );
  }

  await db.collection("admin_delete_logs").add({
    action: "hardDeleteSchool",
    schoolId,
    schoolName: schoolData.schoolName || null,
    requestedBy: uid,
    requestedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await db.recursiveDelete(schoolRef);

  return {
    ok: true,
    deletedPath: `schools/${schoolId}`,
  };
});
Object.assign(exports, require("./hard_delete_school_http"));
