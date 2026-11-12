"use strict";

const assert = require("assert");
const { authenticateWritingTeacher } = require("../writing_teacher");
const {
  applyAcademicYearUpdateForTeacher,
  automaticDisplayName,
  normalizeRows,
  operationIdFor,
} = require("../academic_year_update");

class FakeSnap {
  constructor(ref, value) {
    this.ref = ref;
    this.id = ref.id;
    this.value = value;
    this.exists = value != null;
  }
  data() { return this.value; }
}

function mergeValue(current, update) {
  const result = { ...(current || {}) };
  for (const [key, value] of Object.entries(update)) {
    if (value?.constructor?.name === "DeleteTransform") delete result[key];
    else result[key] = value;
  }
  return result;
}

class FakeRef {
  constructor(db, path) {
    this.db = db;
    this.path = path;
    this.id = path.split("/").pop();
  }
  collection(name) { return new FakeCollection(this.db, `${this.path}/${name}`); }
  async get() { return new FakeSnap(this, this.db.docs.get(this.path)); }
  async set(value, options) {
    this.db.docs.set(this.path, options?.merge
      ? mergeValue(this.db.docs.get(this.path), value)
      : value);
  }
  async update(value) {
    if (!this.db.docs.has(this.path)) throw new Error("missing");
    this.db.docs.set(this.path, mergeValue(this.db.docs.get(this.path), value));
  }
}

class FakeQuery {
  constructor(collection, filters = [], limitValue = null) {
    this.collection = collection;
    this.filters = filters;
    this.limitValue = limitValue;
  }
  where(key, op, value) {
    return new FakeQuery(this.collection, [...this.filters, [key, op, value]], this.limitValue);
  }
  limit(value) { return new FakeQuery(this.collection, this.filters, value); }
  async get() {
    let docs = this.collection.directDocs().filter((snap) =>
      this.filters.every(([key, op, value]) => op === "==" && snap.data()[key] === value));
    if (this.limitValue != null) docs = docs.slice(0, this.limitValue);
    return { docs, empty: docs.length === 0 };
  }
}

class FakeCollection extends FakeQuery {
  constructor(db, path) {
    super(null);
    this.db = db;
    this.path = path;
    this.collection = this;
  }
  doc(id) { return new FakeRef(this.db, `${this.path}/${id}`); }
  directDocs() {
    const prefix = `${this.path}/`;
    return [...this.db.docs.entries()]
      .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
      .map(([path, value]) => new FakeSnap(new FakeRef(this.db, path), value));
  }
  async get() {
    const docs = this.directDocs();
    return { docs, empty: docs.length === 0 };
  }
}

class FakeBatch {
  constructor(db) { this.db = db; this.operations = []; }
  set(ref, value, options) { this.operations.push([ref, value, options]); }
  async commit() {
    for (const [ref, value, options] of this.operations) await ref.set(value, options);
  }
}

class FakeDb {
  constructor(entries) { this.docs = new Map(entries); }
  collection(name) { return new FakeCollection(this, name); }
  batch() { return new FakeBatch(this); }
  async runTransaction(callback) {
    return callback({
      get: (ref) => ref.get(),
      create: (ref, value) => {
        if (this.docs.has(ref.path)) throw new Error("already exists");
        this.docs.set(ref.path, value);
      },
      set: (ref, value, options) => {
        this.docs.set(ref.path, options?.merge
          ? mergeValue(this.docs.get(ref.path), value)
          : value);
      },
    });
  }
}

function fixture() {
  return new FakeDb([
    ["schools/school-a", { schoolCode: "SCHOOL-A" }],
    ["schools/school-a/teachers/admin-a", {
      name: "管理者", password: "secret", active: true, isAdmin: true,
    }],
    ["schools/school-a/classes/english-a", { name: "英語A" }],
    ["schools/school-a/students/student-a", {
      loginId: "261101", name: "1-1-01", grade: "1", class: "1", number: "01",
      historyMarker: "keep-me",
    }],
    ["schools/school-a/classes/english-a/students/student-a", {
      studentInternalUid: "student-a", name: "1-1-01", grade: "1", class: "1",
      number: "01", isCurrent: true, resultMarker: "keep-result",
    }],
  ]);
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

(async () => {
  await test("normalization and operation id are deterministic", () => {
    const rows = normalizeRows({ rows: [{
      internalUid: "student-a", loginId: "261101",
      currentGrade: "1", currentClass: "A", currentNumber: "1",
      nextGrade: "2", nextClass: "B", nextNumber: "9",
    }] });
    assert.strictEqual(rows[0].currentNumber, "01");
    assert.strictEqual(rows[0].nextNumber, "09");
    assert.strictEqual(operationIdFor(rows), operationIdFor([...rows]));
    assert.strictEqual(automaticDisplayName("1-A-01", "1", "A", "1"), true);
    assert.strictEqual(automaticDisplayName("山田太郎", "1", "A", "1"), false);
  });

  await test("admin update preserves ids and history and is idempotent", async () => {
    const db = fixture();
    await authenticateWritingTeacher({
      db,
      authUid: "auth-admin",
      data: { schoolCode: "SCHOOL-A", teacherId: "admin-a", password: "secret" },
    });
    const data = { rows: [{
      internalUid: "student-a", loginId: "261101",
      currentGrade: "1", currentClass: "1", currentNumber: "01",
      nextGrade: "2", nextClass: "B", nextNumber: "09",
    }] };
    const first = await applyAcademicYearUpdateForTeacher({
      db, authUid: "auth-admin", data,
    });
    assert.strictEqual(first.alreadyCompleted, false);
    const student = db.docs.get("schools/school-a/students/student-a");
    assert.strictEqual(student.loginId, "261101");
    assert.strictEqual(student.historyMarker, "keep-me");
    assert.strictEqual(student.name, "2-B-09");
    assert.strictEqual(student.grade, "2");
    assert.strictEqual(student.class, "B");
    const classCopy = db.docs.get("schools/school-a/classes/english-a/students/student-a");
    assert.strictEqual(classCopy.resultMarker, "keep-result");
    assert.strictEqual(classCopy.name, "2-B-09");
    const snapshotPath = `schools/school-a/academicYearUpdateRuns/${first.operationId}/snapshots/student-a`;
    assert.strictEqual(db.docs.get(snapshotPath).grade, "1");

    const second = await applyAcademicYearUpdateForTeacher({
      db, authUid: "auth-admin", data,
    });
    assert.strictEqual(second.alreadyCompleted, true);
    assert.strictEqual(db.docs.get(snapshotPath).grade, "1");
  });

  await test("non-admin cannot run an academic year update", async () => {
    const db = fixture();
    db.docs.set("schools/school-a/teachers/teacher-a", {
      password: "teacher-secret", active: true, isAdmin: false,
    });
    await authenticateWritingTeacher({
      db,
      authUid: "auth-teacher",
      data: { schoolCode: "SCHOOL-A", teacherId: "teacher-a", password: "teacher-secret" },
    });
    await assert.rejects(
      () => applyAcademicYearUpdateForTeacher({
        db,
        authUid: "auth-teacher",
        data: { rows: [{
          internalUid: "student-a", loginId: "261101",
          currentGrade: "1", currentClass: "1", currentNumber: "01",
          nextGrade: "2", nextClass: "2", nextNumber: "01",
        }] },
      }),
      /学校管理者のみ/
    );
  });

  console.log("All academic year update tests passed.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
