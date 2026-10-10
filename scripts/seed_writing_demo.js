"use strict";

process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || "shadow-speak-school";
process.env.GOOGLE_CLOUD_PROJECT =
  process.env.GOOGLE_CLOUD_PROJECT || "shadow-speak-school";
process.env.FIREBASE_AUTH_EMULATOR_HOST =
  process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";
process.env.FIRESTORE_EMULATOR_HOST =
  process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";

const admin = require("firebase-admin");
const { writeCredential } = require("../credential_security");

const projectId = "shadow-speak-school";
const demoSchoolId = "demo-tokai-minami";
const demoStudentUid = "writing-demo-student";
const demoStudentEmail = "writing-demo-student@example.local";
const demoStudentPassword = process.env.WRITING_DEMO_STUDENT_AUTH_PASSWORD;
const demoAdminUid = "writing-demo-admin";
const demoAdminEmail = "writing-demo-admin@example.local";
const demoAdminPassword = process.env.WRITING_DEMO_ADMIN_AUTH_PASSWORD;
const demoSchoolPassword = process.env.WRITING_DEMO_SCHOOL_PASSWORD;
const demoClassId = "demo-class-1";

admin.initializeApp({ projectId });

async function upsertUser({ uid, email, password, displayName }) {
  try {
    await admin.auth().updateUser(uid, {
      email,
      password,
      displayName,
      emailVerified: true,
      disabled: false,
    });
  } catch (error) {
    if (error.code !== "auth/user-not-found") throw error;
    await admin.auth().createUser({
      uid,
      email,
      password,
      displayName,
      emailVerified: true,
      disabled: false,
    });
  }
}

async function main() {
  if (!demoStudentPassword || !demoAdminPassword || !demoSchoolPassword) {
    throw new Error(
      "WRITING_DEMO_STUDENT_AUTH_PASSWORD, WRITING_DEMO_ADMIN_AUTH_PASSWORD, " +
      "and WRITING_DEMO_SCHOOL_PASSWORD must be provided for the local emulator seed."
    );
  }
  const db = admin.firestore();
  const now = admin.firestore.FieldValue.serverTimestamp();

  await upsertUser({
    uid: demoStudentUid,
    email: demoStudentEmail,
    password: demoStudentPassword,
    displayName: "Writing Demo Student",
  });
  await upsertUser({
    uid: demoAdminUid,
    email: demoAdminEmail,
    password: demoAdminPassword,
    displayName: "Writing Demo Admin",
  });

  await db.collection("admins").doc(demoAdminUid).set(
    {
      active: true,
      name: "ミワッチ向けデモAdmin",
      email: demoAdminEmail,
      updatedAt: now,
    },
    { merge: true }
  );

  await db.collection("schools").doc(demoSchoolId).set(
    {
      schoolCode: "tokai-demo",
      schoolName: "東海南高校（ローカルデモ）",
      schoolType: "demo",
      prefecture: "demo",
      year: "2026",
      contractStatus: "demo",
      createdAt: now,
      updatedAt: now,
    },
    { merge: true }
  );

  await db.collection("writingFeatureFlags").doc(demoSchoolId).set(
    {
      schoolId: demoSchoolId,
      enabled: false,
      updatedAt: now,
      updatedBy: "seed",
    },
    { merge: true }
  );

  await db
    .collection("schools")
    .doc(demoSchoolId)
    .collection("classes")
    .doc(demoClassId)
    .set(
      {
        classId: demoClassId,
        className: "デモクラス",
        active: true,
        createdAt: now,
        updatedAt: now,
      },
      { merge: true }
    );

  await db
    .collection("schools")
    .doc(demoSchoolId)
    .collection("students")
    .doc(demoStudentUid)
    .set(
      {
        loginId: "demo-student",
        name: "デモ生徒",
        studentId: "demo-student",
        active: true,
        status: "active",
        mustChangePassword: false,
        joinedClasses: [
          {
            classId: demoClassId,
            className: "デモクラス",
            active: true,
          },
        ],
        updatedAt: now,
      },
      { merge: true }
    );

  await writeCredential({
    db,
    schoolId: demoSchoolId,
    principalType: "student",
    principalId: demoStudentUid,
    password: demoSchoolPassword,
    metadata: { changedBy: "local-emulator-seed", updatedAt: now },
  });

  await db
    .collection("schools")
    .doc(demoSchoolId)
    .collection("students")
    .doc(demoStudentUid)
    .collection("joinedClasses")
    .doc(demoClassId)
    .set(
      {
        classId: demoClassId,
        className: "デモクラス",
        active: true,
        updatedAt: now,
      },
      { merge: true }
    );

  await db.collection("studentSessions").doc(demoStudentUid).set(
    {
      schoolId: demoSchoolId,
      studentInternalUid: demoStudentUid,
      loginId: "demo-student",
      active: true,
      role: "student",
      demoCorrectionCount: 0,
      demoCorrectionLimit: 5,
      createdAt: now,
      updatedAt: now,
    },
    { merge: true }
  );

  console.log("Seeded local Writing demo.");
  console.log("Admin email: writing-demo-admin@example.local");
  console.log("Student school ID: tokai-demo");
  console.log("Student login ID: demo-student");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
