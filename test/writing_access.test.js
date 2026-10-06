"use strict";

const assert = require("assert");
const {
  WritingAccessError,
  SESSION_IDLE_TTL_MS,
  SESSION_ABSOLUTE_TTL_MS,
  isWritingEnabledFromFeatureFlagData,
  authenticateStudentSession,
  refreshStudentSession,
  registerWritingStudentSession,
  getWritingFeatureStatus,
  assertWritingEnabledForAuth,
  setSchoolWritingFeature,
} = require("../writing_access");

class FakeFirestore {
  constructor(initial = {}) {
    this.store = new Map(Object.entries(initial));
  }

  collection(name) {
    return new FakeCollection(this, name);
  }
}

class FakeCollection {
  constructor(db, path) {
    this.db = db;
    this.path = path;
  }

  doc(id) {
    return new FakeDoc(this.db, `${this.path}/${id}`);
  }

  where(field, operator, value) {
    assert.strictEqual(operator, "==");
    return new FakeQuery(this.db, this.path, field, value);
  }
}

class FakeQuery {
  constructor(db, path, field, value) {
    this.db = db;
    this.path = path;
    this.field = field;
    this.value = value;
    this.max = Infinity;
  }

  limit(max) {
    this.max = max;
    return this;
  }

  async get() {
    const prefix = `${this.path}/`;
    const docs = [];
    for (const [path, value] of this.db.store.entries()) {
      const tail = path.slice(prefix.length);
      if (!path.startsWith(prefix) || tail.includes("/")) continue;
      if (value[this.field] !== this.value) continue;
      docs.push(new FakeDocSnapshot(this.db, path, value));
      if (docs.length >= this.max) break;
    }
    return { empty: docs.length === 0, docs };
  }
}

class FakeDocSnapshot {
  constructor(db, path, value) {
    this.id = path.split("/").pop();
    this.ref = new FakeDoc(db, path);
    this.exists = true;
    this._value = value;
  }

  data() {
    return clone(this._value);
  }
}

class FakeDoc {
  constructor(db, path) {
    this.db = db;
    this.path = path;
  }

  collection(name) {
    return new FakeCollection(this.db, `${this.path}/${name}`);
  }

  async get() {
    const data = this.db.store.get(this.path);
    return {
      exists: data != null,
      data: () => clone(data),
    };
  }

  async set(data, options = {}) {
    const current = options.merge ? this.db.store.get(this.path) || {} : {};
    this.db.store.set(this.path, deepMerge(current, data));
  }

  async update(data) {
    if (!this.db.store.has(this.path)) {
      throw new Error(`Missing document: ${this.path}`);
    }
    const current = clone(this.db.store.get(this.path));
    for (const [key, value] of Object.entries(data)) {
      setDotPath(current, key, value);
    }
    this.db.store.set(this.path, current);
  }
}

const fakeAdmin = {
  firestore: {
    FieldValue: {
      serverTimestamp: () => ({ __serverTimestamp: true }),
    },
  },
};

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function deepMerge(target, source) {
  const output = clone(target) || {};
  for (const [key, value] of Object.entries(source)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      output[key] &&
      typeof output[key] === "object" &&
      !Array.isArray(output[key])
    ) {
      output[key] = deepMerge(output[key], value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

function setDotPath(target, path, value) {
  const parts = path.split(".");
  let cursor = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    cursor[parts[i]] = cursor[parts[i]] || {};
    cursor = cursor[parts[i]];
  }
  cursor[parts[parts.length - 1]] = value;
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

function baseDb({ writingEnabled } = {}) {
  const school = { schoolName: "テスト高校", schoolCode: "SCH-A" };
  const initial = {
    "schools/schoolA": school,
    "schools/schoolB": {
      schoolName: "別学校",
    },
    "schools/schoolA/students/student1": {
      loginId: "s001",
      password: "pass123",
      name: "Student One",
      classIds: ["classA"],
    },
    "schools/schoolA/classes/classA": { className: "1-A" },
    "admins/admin1": { active: true },
    "admins/teacher1": { active: false },
    "writingFeatureFlags/schoolB": {
      schoolId: "schoolB",
      enabled: true,
    },
  };
  if (writingEnabled !== undefined) {
    initial["writingFeatureFlags/schoolA"] = {
      schoolId: "schoolA",
      enabled: writingEnabled,
    };
  }
  return new FakeFirestore(initial);
}

(async () => {
  await test("student login is verified server-side and creates a scoped session", async () => {
    const db = baseDb({ writingEnabled: true });
    const result = await authenticateStudentSession({
      db,
      authUid: "authA",
      data: { schoolCode: "SCH-A", loginId: "s001", password: "pass123" },
    });
    assert.strictEqual(result.schoolId, "schoolA");
    assert.strictEqual(result.studentInternalUid, "student1");
    assert.strictEqual(result.classes[0].classId, "classA");
    const session = await db.collection("studentSessions").doc("authA").get();
    assert.strictEqual(session.data().role, "student");
    assert.strictEqual(session.data().schoolId, "schoolA");
    const ttl = result.sessionExpiresAtMillis - Date.now();
    assert.ok(ttl <= SESSION_IDLE_TTL_MS);
    assert.ok(ttl >= SESSION_IDLE_TTL_MS - 2000);
  });

  await test("expired idle session is refreshed with the same 30 day TTL", async () => {
    const db = baseDb({ writingEnabled: true });
    await authenticateStudentSession({
      db,
      authUid: "authA",
      data: { schoolCode: "SCH-A", loginId: "s001", password: "pass123" },
    });
    const session = db.store.get("studentSessions/authA");
    session.expiresAt = {
      _seconds: Math.floor((Date.now() - 1000) / 1000),
    };
    db.store.set("studentSessions/authA", session);

    const result = await refreshStudentSession({ db, authUid: "authA" });
    const ttl = result.sessionExpiresAtMillis - Date.now();
    assert.ok(ttl <= SESSION_IDLE_TTL_MS);
    assert.ok(ttl >= SESSION_IDLE_TTL_MS - 2000);
    const refreshed = db.store.get("studentSessions/authA");
    const hardExpiryMillis = Number(refreshed.absoluteExpiresAt._seconds) * 1000;
    const hardTtl = hardExpiryMillis - Date.now();
    assert.ok(hardTtl <= SESSION_ABSOLUTE_TTL_MS);
    assert.ok(hardTtl >= SESSION_ABSOLUTE_TTL_MS - 2000);
  });

  await test("legacy expired session without an absolute expiry can be migrated", async () => {
    const db = baseDb({ writingEnabled: true });
    await authenticateStudentSession({
      db,
      authUid: "authA",
      data: { schoolCode: "SCH-A", loginId: "s001", password: "pass123" },
    });
    const session = db.store.get("studentSessions/authA");
    session.expiresAt = {
      _seconds: Math.floor((Date.now() - 1000) / 1000),
    };
    delete session.absoluteExpiresAt;
    db.store.set("studentSessions/authA", session);

    const result = await refreshStudentSession({ db, authUid: "authA" });
    const ttl = result.sessionExpiresAtMillis - Date.now();
    assert.ok(ttl <= SESSION_IDLE_TTL_MS);
    assert.ok(ttl >= SESSION_IDLE_TTL_MS - 2000);
    const refreshed = db.store.get("studentSessions/authA");
    assert.ok(refreshed.absoluteExpiresAt);
  });

  await test("student login rejects an invalid password without creating a session", async () => {
    const db = baseDb({ writingEnabled: true });
    await assert.rejects(
      () => authenticateStudentSession({
        db,
        authUid: "authA",
        data: { schoolCode: "SCH-A", loginId: "s001", password: "wrong" },
      }),
      WritingAccessError
    );
    assert.strictEqual((await db.collection("studentSessions").doc("authA").get()).exists, false);
  });

  await test("hidden demo student cannot create a login session", async () => {
    const db = baseDb({ writingEnabled: true });
    db.store.set("schools/schoolA/students/demoStudent", {
      loginId: "demo01",
      password: "SchoolA-Demo9!",
      name: "Demo Student",
      classIds: ["classA"],
      isDemoStudent: true,
      isDemoData: true,
    });
    await assert.rejects(
      () => authenticateStudentSession({
        db,
        authUid: "demoAuth",
        data: { schoolCode: "SCH-A", loginId: "demo01", password: "SchoolA-Demo9!" },
      }),
      /現在このデモアカウントは利用できません/
    );
    assert.strictEqual((await db.collection("studentSessions").doc("demoAuth").get()).exists, false);
  });

  await test("visible demo student uses the normal password login path", async () => {
    const db = baseDb({ writingEnabled: true });
    db.store.set("schools/schoolA", {
      schoolName: "テスト高校",
      schoolCode: "SCH-A",
      demoDataVisible: true,
    });
    db.store.set("schools/schoolA/students/demoStudent", {
      loginId: "demo01",
      password: "SchoolA-Demo9!",
      name: "Demo Student",
      classIds: ["classA"],
      isDemoStudent: true,
      isDemoData: true,
    });
    const result = await authenticateStudentSession({
      db,
      authUid: "demoAuth",
      data: { schoolCode: "SCH-A", loginId: "demo01", password: "SchoolA-Demo9!" },
    });
    assert.strictEqual(result.studentInternalUid, "demoStudent");
    assert.strictEqual(result.classes[0].classId, "classA");
  });

  await test("legacy Writing session registration also rejects a hidden demo student", async () => {
    const db = baseDb({ writingEnabled: true });
    db.store.set("schools/schoolA/students/demoStudent", {
      loginId: "demo01",
      password: "SchoolA-Demo9!",
      isDemoStudent: true,
      isDemoData: true,
    });
    await assert.rejects(
      () => registerWritingStudentSession({
        db,
        admin: fakeAdmin,
        authUid: "demoAuth",
        data: {
          schoolId: "schoolA",
          studentInternalUid: "demoStudent",
          loginId: "demo01",
          password: "SchoolA-Demo9!",
        },
      }),
      /現在このデモアカウントは利用できません/
    );
  });

  await test("missing legacy writing flag still allows the standard feature", async () => {
    const db = baseDb();
    await registerWritingStudentSession({
      db,
      admin: fakeAdmin,
      authUid: "authA",
      data: {
        schoolId: "schoolA",
        studentInternalUid: "student1",
        loginId: "s001",
        password: "pass123",
      },
    });
    const status = await getWritingFeatureStatus({ db, authUid: "authA" });
    assert.strictEqual(status.enabled, true);
    assert.strictEqual(
      (await assertWritingEnabledForAuth({ db, authUid: "authA" })).enabled,
      true
    );
  });

  await test("legacy writing false no longer disables the standard feature", async () => {
    const db = baseDb({ writingEnabled: false });
    await registerWritingStudentSession({
      db,
      admin: fakeAdmin,
      authUid: "authA",
      data: {
        schoolId: "schoolA",
        studentInternalUid: "student1",
        loginId: "s001",
        password: "pass123",
      },
    });
    const status = await getWritingFeatureStatus({ db, authUid: "authA" });
    assert.strictEqual(status.enabled, true);
    assert.strictEqual(
      (await assertWritingEnabledForAuth({ db, authUid: "authA" })).enabled,
      true
    );
  });

  await test("writing true is visible and API allowed", async () => {
    const db = baseDb({ writingEnabled: true });
    await registerWritingStudentSession({
      db,
      admin: fakeAdmin,
      authUid: "authA",
      data: {
        schoolId: "schoolA",
        studentInternalUid: "student1",
        loginId: "s001",
        password: "pass123",
      },
    });
    const status = await assertWritingEnabledForAuth({
      db,
      authUid: "authA",
    });
    assert.strictEqual(status.enabled, true);
    assert.strictEqual(status.schoolId, "schoolA");
  });

  await test("another school's legacy flag does not change the scoped session", async () => {
    const db = baseDb({ writingEnabled: false });
    await registerWritingStudentSession({
      db,
      admin: fakeAdmin,
      authUid: "authA",
      data: {
        schoolId: "schoolA",
        studentInternalUid: "student1",
        loginId: "s001",
        password: "pass123",
      },
    });
    assert.strictEqual(
      isWritingEnabledFromFeatureFlagData(
        (await db.collection("writingFeatureFlags").doc("schoolB").get()).data()
      ),
      true
    );
    const status = await assertWritingEnabledForAuth({ db, authUid: "authA" });
    assert.strictEqual(status.enabled, true);
    assert.strictEqual(status.schoolId, "schoolA");
  });

  await test("legacy admin endpoint keeps Writing enabled and rejects non-admin", async () => {
    const db = baseDb({ writingEnabled: false });
    await assert.rejects(
      () =>
        setSchoolWritingFeature({
          db,
          admin: fakeAdmin,
          uid: "teacher1",
          data: { schoolId: "schoolA", enabled: true },
        }),
      /権限/
    );

    const result = await setSchoolWritingFeature({
      db,
      admin: fakeAdmin,
      uid: "admin1",
      data: { schoolId: "schoolA", enabled: true },
    });
    assert.deepStrictEqual(result, { schoolId: "schoolA", enabled: true });
    const flag = (
      await db.collection("writingFeatureFlags").doc("schoolA").get()
    ).data();
    assert.strictEqual(flag.enabled, true);
    assert.strictEqual(flag.schoolId, "schoolA");

    const disableResult = await setSchoolWritingFeature({
      db,
      admin: fakeAdmin,
      uid: "admin1",
      data: { schoolId: "schoolA", enabled: false },
    });
    assert.deepStrictEqual(disableResult, { schoolId: "schoolA", enabled: true });
    assert.strictEqual(
      (await db.collection("writingFeatureFlags").doc("schoolA").get()).data().enabled,
      true
    );
  });

  await test("invalid password does not bind auth UID", async () => {
    const db = baseDb({ writingEnabled: true });
    await assert.rejects(
      () =>
        registerWritingStudentSession({
          db,
          admin: fakeAdmin,
          authUid: "authA",
          data: {
            schoolId: "schoolA",
            studentInternalUid: "student1",
            loginId: "s001",
            password: "wrong",
          },
        }),
      WritingAccessError
    );
    const session = await db.collection("studentSessions").doc("authA").get();
    assert.strictEqual(session.exists, false);
  });
})();
