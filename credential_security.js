"use strict";

const crypto = require("crypto");
const { promisify } = require("util");
const { FieldValue } = require("firebase-admin/firestore");

const scryptAsync = promisify(crypto.scrypt);

const CREDENTIAL_ROOT = "schoolCredentials";
const CREDENTIAL_VERSION = 1;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_OPTIONS = Object.freeze({
  N: 32768,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
});

function constantTimeTextEquals(actual, expected) {
  // Hash only for the in-memory comparison so both operands have a fixed
  // length. Credentials at rest always use salted scrypt, never this digest.
  const left = crypto.createHash("sha256")
    .update(String(actual || ""), "utf8").digest();
  const right = crypto.createHash("sha256")
    .update(String(expected || ""), "utf8").digest();
  return crypto.timingSafeEqual(left, right);
}

function credentialCollectionName(principalType) {
  if (principalType === "student") return "studentCredentials";
  if (principalType === "teacher") return "teacherCredentials";
  throw new Error(`Unsupported credential principal type: ${principalType}`);
}

function credentialRef({ db, schoolId, principalType, principalId }) {
  return db.collection(CREDENTIAL_ROOT).doc(schoolId)
    .collection(credentialCollectionName(principalType)).doc(principalId);
}

async function deriveScrypt(password, salt, options = SCRYPT_OPTIONS) {
  return scryptAsync(String(password), salt, SCRYPT_KEY_LENGTH, options);
}

function fingerprintCredentialData(data) {
  if (!data || data.algorithm !== "scrypt" || !data.salt || !data.passwordHash) {
    return "";
  }
  return crypto.createHash("sha256")
    .update([
      data.algorithm,
      String(data.version || ""),
      data.salt,
      data.passwordHash,
      String(data.parameters?.N || ""),
      String(data.parameters?.r || ""),
      String(data.parameters?.p || ""),
    ].join(":"))
    .digest("hex");
}

function legacyCredentialFingerprint(password) {
  return crypto.createHash("sha256")
    .update(String(password || ""), "utf8")
    .digest("hex");
}

async function buildCredentialData(password, metadata = {}) {
  const salt = crypto.randomBytes(16);
  const derived = await deriveScrypt(password, salt);
  return {
    algorithm: "scrypt",
    version: CREDENTIAL_VERSION,
    salt: salt.toString("base64"),
    passwordHash: derived.toString("base64"),
    parameters: {
      N: SCRYPT_OPTIONS.N,
      r: SCRYPT_OPTIONS.r,
      p: SCRYPT_OPTIONS.p,
      keyLength: SCRYPT_KEY_LENGTH,
    },
    ...metadata,
  };
}

async function verifyScryptCredential(password, data) {
  if (!data || data.algorithm !== "scrypt" || data.version !== CREDENTIAL_VERSION) {
    return false;
  }
  try {
    const salt = Buffer.from(String(data.salt || ""), "base64");
    const expected = Buffer.from(String(data.passwordHash || ""), "base64");
    if (salt.length !== 16 || expected.length !== SCRYPT_KEY_LENGTH) return false;
    const params = data.parameters || {};
    const options = {
      N: Number(params.N || SCRYPT_OPTIONS.N),
      r: Number(params.r || SCRYPT_OPTIONS.r),
      p: Number(params.p || SCRYPT_OPTIONS.p),
      maxmem: SCRYPT_OPTIONS.maxmem,
    };
    const actual = await deriveScrypt(password, salt, options);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch (_) {
    return false;
  }
}

async function writeCredential({
  db,
  schoolId,
  principalType,
  principalId,
  password,
  metadata = {},
}) {
  const ref = credentialRef({ db, schoolId, principalType, principalId });
  const data = await buildCredentialData(password, {
    principalType,
    schoolId,
    principalId,
    ...metadata,
    updatedAt: FieldValue.serverTimestamp(),
  });
  await ref.set(data, { merge: false });
  return {
    ref,
    data,
    fingerprint: fingerprintCredentialData(data),
  };
}

async function deleteLegacyPassword(profileRef) {
  if (!profileRef || typeof profileRef.update !== "function") return;
  if (typeof profileRef.get === "function") {
    const snap = await profileRef.get();
    if (!snap.exists) return;
  }
  await profileRef.update({
    password: FieldValue.delete(),
    credentialMigratedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
}

async function cleanupLegacyPasswords({
  profileRef,
  cleanupLegacyRefs,
  schoolId,
  principalType,
  principalId,
}) {
  const refs = [profileRef, ...cleanupLegacyRefs]
    .filter((value, index, all) => value && all.indexOf(value) === index);
  for (const legacyRef of refs) {
    try {
      await deleteLegacyPassword(legacyRef);
    } catch (error) {
      console.warn("Credential stored but legacy password cleanup failed", {
        schoolId,
        principalType,
        principalId,
        message: error?.message || String(error),
      });
    }
  }
}

async function verifyCredential({
  db,
  schoolId,
  principalType,
  principalId,
  password,
  profileRef,
  legacyPassword,
  cleanupLegacyRefs = [],
}) {
  const ref = credentialRef({ db, schoolId, principalType, principalId });
  const snap = await ref.get();
  if (snap.exists) {
    const data = snap.data();
    const valid = await verifyScryptCredential(password, data);
    if (valid && legacyPassword != null) {
      await cleanupLegacyPasswords({
        profileRef,
        cleanupLegacyRefs,
        schoolId,
        principalType,
        principalId,
      });
    }
    return {
      valid,
      migrated: false,
      fingerprint: valid ? fingerprintCredentialData(data) : "",
    };
  }

  if (!constantTimeTextEquals(password, legacyPassword)) {
    return { valid: false, migrated: false, fingerprint: "" };
  }

  // Credential first, plaintext cleanup second. A cleanup failure can leave a
  // temporary legacy copy, but can never leave the account without a usable
  // credential.
  const stored = await writeCredential({
    db,
    schoolId,
    principalType,
    principalId,
    password,
    metadata: {
      createdAt: FieldValue.serverTimestamp(),
      migratedFromLegacyAt: FieldValue.serverTimestamp(),
    },
  });
  await cleanupLegacyPasswords({
    profileRef,
    cleanupLegacyRefs,
    schoolId,
    principalType,
    principalId,
  });
  return { valid: true, migrated: true, fingerprint: stored.fingerprint };
}

async function currentCredentialFingerprint({
  db,
  schoolId,
  principalType,
  principalId,
  legacyPassword,
}) {
  const snap = await credentialRef({
    db, schoolId, principalType, principalId,
  }).get();
  if (snap.exists) return fingerprintCredentialData(snap.data());
  return legacyPassword == null ? "" : legacyCredentialFingerprint(legacyPassword);
}

module.exports = {
  CREDENTIAL_ROOT,
  CREDENTIAL_VERSION,
  SCRYPT_OPTIONS,
  buildCredentialData,
  constantTimeTextEquals,
  credentialRef,
  currentCredentialFingerprint,
  fingerprintCredentialData,
  legacyCredentialFingerprint,
  verifyCredential,
  verifyScryptCredential,
  writeCredential,
};
