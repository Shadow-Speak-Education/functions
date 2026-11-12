"use strict";

const crypto = require("crypto");
const { FieldValue } = require("firebase-admin/firestore");
const { WritingAccessError } = require("./writing_access");
const {
  requireSchoolTeacherAdmin,
} = require("./writing_teacher");

function text(value) {
  return String(value == null ? "" : value).trim();
}

function normalizeClass(value) {
  return text(value).replace(/組$/, "").toUpperCase();
}

function normalizeNumber(value) {
  const raw = text(value);
  if (!/^\d{1,2}$/.test(raw)) return "";
  const number = Number(raw);
  return number >= 1 && number <= 99 ? String(number).padStart(2, "0") : "";
}

function normalizeRows(data) {
  const input = Array.isArray(data && data.rows) ? data.rows : [];
  if (input.length === 0 || input.length > 500) {
    throw new WritingAccessError("invalid-argument", "年度更新の対象件数が不正です。");
  }
  const seenStudents = new Set();
  const seenTargets = new Set();
  return input.map((raw, index) => {
    const internalUid = text(raw && raw.internalUid);
    const loginId = text(raw && raw.loginId);
    const currentGrade = text(raw && raw.currentGrade);
    const currentClass = normalizeClass(raw && raw.currentClass);
    const currentNumber = normalizeNumber(raw && raw.currentNumber);
    const nextGrade = text(raw && raw.nextGrade);
    const nextClass = normalizeClass(raw && raw.nextClass);
    const nextNumber = normalizeNumber(raw && raw.nextNumber);
    if (!internalUid || internalUid.includes("/") || !loginId ||
        !/^[1-3]$/.test(nextGrade) || !/^([1-9]|[A-I])$/.test(nextClass) ||
        !nextNumber || !/^[1-3]$/.test(currentGrade) ||
        !/^([1-9]|[A-I])$/.test(currentClass) || !currentNumber) {
      throw new WritingAccessError(
        "invalid-argument",
        `${index + 1}件目の年度更新情報が不正です。`
      );
    }
    if (!seenStudents.add(internalUid)) {
      throw new WritingAccessError("invalid-argument", "同じ生徒が重複しています。");
    }
    const targetKey = `${nextGrade}|${nextClass}|${nextNumber}`;
    if (!seenTargets.add(targetKey)) {
      throw new WritingAccessError("already-exists", "更新後の学年・組・番号が重複しています。");
    }
    return {
      internalUid, loginId,
      currentGrade, currentClass, currentNumber,
      nextGrade, nextClass, nextNumber,
    };
  });
}

function operationIdFor(rows) {
  const canonical = rows.map((row) => [
    row.internalUid, row.loginId,
    row.currentGrade, row.currentClass, row.currentNumber,
    row.nextGrade, row.nextClass, row.nextNumber,
  ].join("|")).sort().join("\n");
  return `academic_${crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}

function academicKey(grade, className, number) {
  return `${text(grade)}|${normalizeClass(className)}|${normalizeNumber(number)}`;
}

function automaticDisplayName(name, grade, className, number) {
  const value = text(name);
  const normalizedClass = normalizeClass(className);
  const normalizedNumber = normalizeNumber(number);
  const rawNumber = String(Number(normalizedNumber));
  return new Set([
    `${grade}-${normalizedClass}-${normalizedNumber}`,
    `${grade}_${normalizedClass}_${normalizedNumber}`,
    `${grade}年${normalizedClass}組${rawNumber}番`,
  ]).has(value);
}

function nextDisplayName(row) {
  return `${row.nextGrade}-${row.nextClass}-${row.nextNumber}`;
}

function isCurrentMembership(data) {
  const value = data || {};
  const status = text(value.membershipStatus || value.status).toLowerCase();
  return value.isCurrent !== false &&
    !["removed", "left", "transferred", "graduated"].includes(status);
}

async function validateSchoolState({ db, schoolId, rows }) {
  const snap = await db.collection("schools").doc(schoolId).collection("students").get();
  const targets = new Set(rows.map((row) => row.internalUid));
  const occupied = new Map();
  for (const doc of snap.docs) {
    if (targets.has(doc.id)) continue;
    const value = doc.data() || {};
    const key = academicKey(value.grade, value.class || value.className, value.number || value.seatNo);
    if (!key.includes("||") && !key.endsWith("|")) occupied.set(key, doc.id);
  }
  for (const row of rows) {
    const owner = occupied.get(academicKey(row.nextGrade, row.nextClass, row.nextNumber));
    if (owner) {
      throw new WritingAccessError(
        "already-exists",
        "更新後の学年・組・番号は別の在籍生徒と重複しています。"
      );
    }
  }
}

async function updateClassCopies({ db, schoolRef, classes, row, updateData }) {
  const existing = await Promise.all(classes.map(async (classDoc) => {
    const ref = classDoc.ref.collection("students").doc(row.internalUid);
    const snap = await ref.get();
    return snap.exists && isCurrentMembership(snap.data()) ? ref : null;
  }));
  const refs = existing.filter(Boolean);
  for (let start = 0; start < refs.length; start += 400) {
    const batch = db.batch();
    for (const ref of refs.slice(start, start + 400)) {
      batch.set(ref, updateData, { merge: true });
    }
    await batch.commit();
  }
  const joinedSnap = await schoolRef.collection("students").doc(row.internalUid)
    .collection("joinedClasses").get();
  for (let start = 0; start < joinedSnap.docs.length; start += 400) {
    const batch = db.batch();
    for (const doc of joinedSnap.docs.slice(start, start + 400)) {
      batch.set(doc.ref, {
        academicGrade: row.nextGrade,
        academicClass: row.nextClass,
        academicNumber: row.nextNumber,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    await batch.commit();
  }
}

async function applyAcademicYearUpdateForTeacher({ db, authUid, data }) {
  const session = await requireSchoolTeacherAdmin({ db, authUid });
  const rows = normalizeRows(data);
  const operationId = operationIdFor(rows);
  const schoolRef = db.collection("schools").doc(session.schoolId);
  const runRef = schoolRef.collection("academicYearUpdateRuns").doc(operationId);
  const existingRun = await runRef.get();
  if (existingRun.exists && existingRun.data().status === "completed") {
    return { ok: true, alreadyCompleted: true, operationId, count: rows.length };
  }

  await validateSchoolState({ db, schoolId: session.schoolId, rows });
  const classes = (await schoolRef.collection("classes").get()).docs;
  await runRef.set({
    schoolId: session.schoolId,
    operationId,
    actorUid: session.authUid,
    actorTeacherId: session.teacherId,
    status: "in_progress",
    targetCount: rows.length,
    updatedAt: FieldValue.serverTimestamp(),
    ...(existingRun.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
  }, { merge: true });

  let completedCount = 0;
  try {
    for (const row of rows) {
      const studentRef = schoolRef.collection("students").doc(row.internalUid);
      const snapshotRef = runRef.collection("snapshots").doc(row.internalUid);
      const resultRef = runRef.collection("results").doc(row.internalUid);
      const transactionResult = await db.runTransaction(async (transaction) => {
        const [studentSnap, snapshotSnap, resultSnap] = await Promise.all([
          transaction.get(studentRef),
          transaction.get(snapshotRef),
          transaction.get(resultRef),
        ]);
        if (resultSnap.exists && resultSnap.data().status === "completed") {
          return { alreadyCompleted: true, updateData: null };
        }
        if (!studentSnap.exists) {
          throw new WritingAccessError("not-found", "年度更新対象の生徒が見つかりません。");
        }
        const student = studentSnap.data() || {};
        const storedLoginId = text(student.loginId || student.studentId);
        if (storedLoginId !== row.loginId) {
          throw new WritingAccessError("failed-precondition", "ログインIDが現在の生徒データと一致しません。");
        }
        const currentKey = academicKey(
          student.grade,
          student.class || student.className,
          student.number || student.seatNo
        );
        const beforeKey = academicKey(row.currentGrade, row.currentClass, row.currentNumber);
        const afterKey = academicKey(row.nextGrade, row.nextClass, row.nextNumber);
        if (currentKey !== beforeKey && currentKey !== afterKey) {
          throw new WritingAccessError("failed-precondition", "更新前の学籍情報が変更されています。再度プレビューしてください。");
        }
        if (!snapshotSnap.exists) {
          transaction.create(snapshotRef, {
            schoolId: session.schoolId,
            internalUid: row.internalUid,
            loginId: storedLoginId,
            name: text(student.name),
            grade: text(student.grade),
            class: normalizeClass(student.class || student.className),
            number: normalizeNumber(student.number || student.seatNo),
            capturedAt: FieldValue.serverTimestamp(),
          });
        }
        const updateData = {
          grade: row.nextGrade,
          class: row.nextClass,
          number: row.nextNumber,
          seatNo: row.nextNumber,
          updatedAt: FieldValue.serverTimestamp(),
        };
        if (automaticDisplayName(
          student.name,
          row.currentGrade,
          row.currentClass,
          row.currentNumber
        )) {
          updateData.name = nextDisplayName(row);
        }
        transaction.set(studentRef, updateData, { merge: true });
        transaction.set(resultRef, {
          status: "master_updated",
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        return { alreadyCompleted: false, updateData };
      });
      if (!transactionResult.alreadyCompleted) {
        await updateClassCopies({
          db, schoolRef, classes, row,
          updateData: transactionResult.updateData,
        });
        await resultRef.set({
          status: "completed",
          completedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
      completedCount++;
    }
    await runRef.set({
      status: "completed",
      completedCount,
      completedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { ok: true, alreadyCompleted: false, operationId, count: completedCount };
  } catch (error) {
    await runRef.set({
      status: "failed",
      completedCount,
      errorCode: String(error && error.code || "internal"),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    throw error;
  }
}

module.exports = {
  normalizeRows,
  operationIdFor,
  automaticDisplayName,
  applyAcademicYearUpdateForTeacher,
};
