"use strict";

const assert = require("assert");
const {
  WritingAccessError,
  isWritingEnabledFromFeatureFlagData,
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
  const school = { schoolName: "テスト高校" };
  const initial = {
    "schools/schoolA": school,
    "schools/schoolB": {
      schoolName: "別学校",
    },
    "schools/schoolA/students/student1": {
      loginId: "s001",
      password: "pass123",
    },
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
  await test("missing writing feature is fail-closed", async () => {
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
    assert.strictEqual(status.enabled, false);
    await assert.rejects(
      () => assertWritingEnabledForAuth({ db, authUid: "authA" }),
      WritingAccessError
    );
  });

  await test("writing false is hidden and API denied", async () => {
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
    assert.strictEqual(status.enabled, false);
    await assert.rejects(
      () => assertWritingEnabledForAuth({ db, authUid: "authA" }),
      /利用できません/
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

  await test("another enabled school cannot be forged", async () => {
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
    await assert.rejects(
      () => assertWritingEnabledForAuth({ db, authUid: "authA" }),
      WritingAccessError
    );
  });

  await test("admin can toggle exact school and non-admin cannot", async () => {
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
    const session = await db.collection("writingAuthSessions").doc("authA").get();
    assert.strictEqual(session.exists, false);
  });
})();
