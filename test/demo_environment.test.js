"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("fs");
const path = require("path");
const {
  DATASET_ID,
  DEMO_CLASS_ID,
  EXAMPLE_MATERIAL_ID,
  assertDemoManager,
  assertSuperAdmin,
  deleteDemoEnvironment,
  demoStudents,
  getDemoAuthenticationForAdmin,
  getDemoCredentials,
  initializeDemoEnvironment,
  loadDemoWords,
  setDemoAuthentication,
  setDemoVisibility,
} = require("../demo_environment");

class FakeSnapshot {
  constructor(value) {
    this._value = value;
    this.exists = value !== undefined;
  }
  data() { return this._value; }
}

class FakeRef {
  constructor(db, pathValue) {
    this.db = db;
    this.path = pathValue;
  }
  collection(name) { return new FakeCollection(this.db, `${this.path}/${name}`); }
  async get() { return new FakeSnapshot(this.db.docs.get(this.path)); }
  async set(data, options = {}) {
    const previous = options.merge === false ? {} : (this.db.docs.get(this.path) || {});
    this.db.docs.set(this.path, applyData(previous, data));
  }
}

class FakeCollection {
  constructor(db, pathValue) {
    this.db = db;
    this.path = pathValue;
  }
  doc(id) { return new FakeRef(this.db, `${this.path}/${id}`); }
  where(field, operator, value) {
    assert.equal(operator, "==");
    return {
      get: async () => ({
        docs: [...this.db.docs.entries()]
          .filter(([key, data]) => {
            const suffix = key.slice(this.path.length + 1);
            return key.startsWith(`${this.path}/`) && !suffix.includes("/") && data[field] === value;
          })
          .map(([key, data]) => ({ ref: new FakeRef(this.db, key), data: () => data })),
      }),
    };
  }
}

class FakeDb {
  constructor() { this.docs = new Map(); }
  collection(name) { return new FakeCollection(this, name); }
  batch() {
    const pending = [];
    return {
      set: (ref, data) => pending.push({ ref, data }),
      commit: async () => {
        for (const item of pending) {
          const previous = this.docs.get(item.ref.path) || {};
          this.docs.set(item.ref.path, applyData(previous, item.data));
        }
      },
    };
  }
  async recursiveDelete(ref) {
    for (const key of [...this.docs.keys()]) {
      if (key === ref.path || key.startsWith(`${ref.path}/`)) this.docs.delete(key);
    }
  }
}

function applyData(previous, data) {
  const result = { ...previous };
  for (const [key, value] of Object.entries(data)) {
    if (value?.constructor?.name === "DeleteTransform") {
      delete result[key];
    } else {
      result[key] = value;
    }
  }
  return result;
}

class FakeBucket {
  constructor() { this.files = new Set(); }
  file(name) {
    return {
      exists: async () => [this.files.has(name)],
      delete: async () => this.files.delete(name),
    };
  }
  async upload(localPath, options) {
    assert.equal(fs.existsSync(localPath), true);
    this.files.add(options.destination);
  }
  async getFiles({ prefix }) {
    return [[...this.files]
      .filter((name) => name.startsWith(prefix))
      .map((name) => this.file(name))];
  }
}

const fakeAdmin = {
  firestore: { FieldValue: { serverTimestamp: () => ({ serverTimestamp: true }) } },
};

test("demo students use fixed IDs without embedding a plaintext password", () => {
  const students = demoStudents();
  assert.equal(students.length, 10);
  assert.equal(students[0].id, "demo_student_01");
  assert.equal(students[9].data.loginId, "demo10");
  for (const student of students) {
    assert.equal(student.data.password, undefined);
    assert.equal(student.data.classId, DEMO_CLASS_ID);
    assert.equal(student.data.demoDatasetId, DATASET_ID);
  }
});

test("dashboard demo data can be repaired before Admin configures app credentials", async () => {
  const db = new FakeDb();
  const bucket = new FakeBucket();
  db.docs.set("schools/school-a", { schoolCode: "school-a" });
  const result = await initializeDemoEnvironment({
    db, bucket, admin: fakeAdmin, schoolId: "school-a",
    actor: { teacherId: "teacher-a", teacherName: "Teacher A" },
  });
  assert.equal(result.demoLogin, null);
  assert.equal(
    db.docs.get("schools/school-a/students/demo_student_09").password,
    undefined,
  );
  assert.equal(
    db.docs.get("schools/school-a/classes/demo_class_teacher_sales_demo_v1/vocabTests/demo_vocab_test_01").vocabListId,
    "junior_english_1800",
  );
});

test("Admin can configure the password without creating demo students", async () => {
  const db = new FakeDb();
  db.docs.set("schools/school-a", { schoolCode: "school-a" });
  await setDemoAuthentication({
    db,
    admin: fakeAdmin,
    schoolId: "school-a",
    password: "AdminSelected-2026!",
    actorUid: "admin-a",
  });
  assert.equal(
    db.docs.get("schools/school-a/demoSettings/authentication").password,
    undefined,
  );
  assert.equal(
    db.docs.has("schoolCredentials/school-a/studentCredentials/demo_student_01"),
    true,
  );
  assert.equal(db.docs.has("schools/school-a/students/demo_student_01"), false);
  const stored = await getDemoAuthenticationForAdmin({ db, schoolId: "school-a" });
  assert.deepEqual(stored, {
    configured: true,
    password: "",
    passwordStoredSecurely: true,
  });
});

test("demo authentication settings are restricted to the operations Admin", async () => {
  const db = new FakeDb();
  db.docs.set("admins/admin-a", { active: true, role: "superAdmin" });
  const actor = await assertSuperAdmin({ db, request: { auth: { uid: "admin-a" } } });
  assert.equal(actor.uid, "admin-a");
  await assert.rejects(
    assertSuperAdmin({ db, request: { auth: { uid: "teacher-a" } } }),
    (error) => error.code === "permission-denied",
  );
});

test("a normal active teacher session can manage only its own school's demo", async () => {
  const db = new FakeDb();
  db.docs.set("teacherSessions/auth-a", {
    active: true,
    role: "teacher",
    schoolId: "school-a",
    teacherId: "teacher-a",
    expiresAt: { toMillis: () => Date.now() + 60_000 },
  });
  db.docs.set("schools/school-a/teachers/teacher-a", {
    active: true,
    name: "Teacher A",
  });
  const actor = await assertDemoManager({
    db,
    request: { auth: { uid: "auth-a" } },
    requestedSchoolId: "school-a",
  });
  assert.equal(actor.teacherId, "teacher-a");
  await assert.rejects(
    assertDemoManager({
      db,
      request: { auth: { uid: "auth-a" } },
      requestedSchoolId: "school-b",
    }),
    (error) => error.code === "permission-denied",
  );
});

test("packaged Example and vocabulary templates are complete", () => {
  const root = path.join(__dirname, "../demo_templates/example");
  const subtitle = JSON.parse(fs.readFileSync(path.join(root, "example_subtitles.json")));
  const translation = JSON.parse(fs.readFileSync(path.join(root, "example_ja.json")));
  const waveform = JSON.parse(fs.readFileSync(path.join(root, "example_waveform.json")));
  const questions = JSON.parse(fs.readFileSync(path.join(root, "example_questions.json")));
  assert.match(subtitle.text, /Learning English takes practice/);
  assert.equal(translation.segments.length, subtitle.segments.length);
  assert.equal(waveform.samplesPerSecond, 100);
  assert.equal(waveform.values.length, 571);
  assert.equal(questions.length, 2);
  assert.equal(loadDemoWords().length, 30);
});

test("initialization is idempotent and repairs fixed demo paths", async () => {
  const db = new FakeDb();
  const bucket = new FakeBucket();
  db.docs.set("schools/school-a", { schoolCode: "school-a" });
  db.docs.set("schools/school-a/demoSettings/authentication", {
    password: "AdminSelected-2026!",
  });
  const input = {
    db,
    bucket,
    admin: fakeAdmin,
    schoolId: "school-a",
    actor: { teacherId: "teacher-a", teacherName: "Teacher A" },
  };
  const first = await initializeDemoEnvironment(input);
  const documentCount = db.docs.size;
  const fileCount = bucket.files.size;
  const second = await initializeDemoEnvironment(input);

  assert.equal(first.demoStudentCount, 10);
  assert.equal(first.vocabTestCount, 3);
  assert.equal(first.uploadedAssetCount, 5);
  assert.equal(second.uploadedAssetCount, 0);
  assert.equal(db.docs.size, documentCount);
  assert.equal(bucket.files.size, fileCount);
  assert.equal(first.demoLogin.passwordConfigured, true);
  assert.deepEqual(second.demoLogin, first.demoLogin);
  assert.equal(db.docs.has(`schools/school-a/classes/${DEMO_CLASS_ID}`), true);
  assert.equal(db.docs.has(`schools/school-a/classes/${DEMO_CLASS_ID}/materials/${EXAMPLE_MATERIAL_ID}`), true);
  assert.equal(db.docs.get(`schools/school-a/classes/${DEMO_CLASS_ID}/materials/${EXAMPLE_MATERIAL_ID}`).visible, true);
  assert.equal(db.docs.get("schools/school-a/classes/demo_class_teacher_sales_demo_v1/vocabTests/demo_vocab_test_01").words.length, 10);
});

test("credentials are returned from the tagged demo class", async () => {
  const db = new FakeDb();
  const bucket = new FakeBucket();
  db.docs.set("schools/school-a", { schoolCode: "SCH-A" });
  db.docs.set("schools/school-a/demoSettings/authentication", {
    password: "AdminSelected-2026!",
  });
  const result = await initializeDemoEnvironment({
    db, bucket, admin: fakeAdmin, schoolId: "school-a",
    actor: { teacherId: "teacher-a", teacherName: "Teacher A" },
  });
  const credentials = await getDemoCredentials({ db, schoolId: "school-a" });
  assert.deepEqual(credentials, result.demoLogin);
  const update = await setDemoAuthentication({
    db,
    admin: fakeAdmin,
    schoolId: "school-a",
    password: "AdminChanged-2026!",
    actorUid: "admin-a",
  });
  assert.equal(update.updatedDemoStudentDocuments, 20);
  assert.equal(
    db.docs.get("schools/school-a/students/demo_student_09").password,
    undefined,
  );
  assert.equal(
    (await getDemoCredentials({ db, schoolId: "school-a" })).passwordConfigured,
    true,
  );
});

test("turning demo mode off revokes only this school's demo student sessions", async () => {
  const db = new FakeDb();
  db.docs.set("schools/school-a", { schoolCode: "SCH-A", demoDataVisible: true });
  db.docs.set("studentSessions/demo-session", {
    schoolId: "school-a", studentId: "demo_student_09", active: true,
  });
  db.docs.set("studentSessions/normal-session", {
    schoolId: "school-a", studentId: "normal-student", active: true,
  });
  db.docs.set("studentSessions/other-school-demo", {
    schoolId: "school-b", studentId: "demo_student_09", active: true,
  });
  const result = await setDemoVisibility({
    db, admin: fakeAdmin, schoolId: "school-a", visible: false,
  });
  assert.equal(result.revokedSessionCount, 1);
  assert.equal(db.docs.get("studentSessions/demo-session").active, false);
  assert.equal(db.docs.get("studentSessions/normal-session").active, true);
  assert.equal(db.docs.get("studentSessions/other-school-demo").active, true);
  assert.equal(db.docs.get("schools/school-a").demoDataVisible, false);
});

test("explicit demo deletion removes only fixed demo data and Example assets", async () => {
  const db = new FakeDb();
  const bucket = new FakeBucket();
  db.docs.set("schools/school-a", { schoolCode: "school-a" });
  db.docs.set("schools/school-a/demoSettings/authentication", {
    password: "AdminSelected-2026!",
  });
  db.docs.set("schools/school-a/classes/normal-class", { name: "Normal" });
  await initializeDemoEnvironment({
    db, bucket, admin: fakeAdmin, schoolId: "school-a",
    actor: { teacherId: "teacher-a", teacherName: "Teacher A" },
  });
  db.docs.set("studentSessions/demo-session", {
    schoolId: "school-a", studentId: "demo_student_09", active: true,
  });
  const result = await deleteDemoEnvironment({
    db, bucket, admin: fakeAdmin, schoolId: "school-a",
  });
  assert.equal(result.deletedStorageFiles, 5);
  assert.equal(result.revokedSessionCount, 1);
  assert.equal(db.docs.get("studentSessions/demo-session").active, false);
  assert.equal(db.docs.has("schools/school-a/classes/normal-class"), true);
  assert.equal(db.docs.has(`schools/school-a/classes/${DEMO_CLASS_ID}`), false);
  assert.equal(db.docs.has(`schools/school-a/materials/${EXAMPLE_MATERIAL_ID}`), false);
  assert.equal(bucket.files.size, 0);
  assert.equal(db.docs.get("schools/school-a").demoDataVisible, false);
});
