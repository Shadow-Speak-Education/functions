const {onRequest} = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

async function deleteQueryDocuments(query, deletedPaths, authUids) {
  const snap = await query.get();
  for (const doc of snap.docs) {
    const data = doc.data() || {};
    for (const candidate of [doc.id, data.uid, data.authUid]) {
      if (typeof candidate === "string" && candidate.trim()) {
        authUids.add(candidate.trim());
      }
    }
    await doc.ref.firestore.recursiveDelete(doc.ref);
    deletedPaths.push(doc.ref.path);
  }
}

async function collectSchoolAuthUids(schoolRef) {
  const authUids = new Set();
  for (const collectionName of ["teachers", "students"]) {
    const snap = await schoolRef.collection(collectionName).get();
    for (const doc of snap.docs) {
      const data = doc.data() || {};
      for (const candidate of [data.uid, data.authUid]) {
        if (typeof candidate === "string" && candidate.trim()) {
          authUids.add(candidate.trim());
        }
      }
    }
  }
  return authUids;
}

async function deleteStoragePrefix(bucket, prefix, deletedPaths) {
  const [files] = await bucket.getFiles({prefix});
  await Promise.all(
    files.map(async (file) => {
      await file.delete({ignoreNotFound: true});
      deletedPaths.push(`storage/${file.name}`);
    })
  );
}

exports.hardDeleteSchoolHttp = onRequest(
  {
    region: "asia-northeast1",
    timeoutSeconds: 540,
    memory: "1GiB",
    cors: true,
  },
  async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        res.status(204).send("");
        return;
      }

      if (req.method !== "POST") {
        res.status(405).json({message: "POSTのみ許可されています。"});
        return;
      }

      const authHeader = req.headers.authorization || "";
      const match = authHeader.match(/^Bearer (.+)$/);

      if (!match) {
        res.status(401).json({message: "ログインが必要です。"});
        return;
      }

      const decoded = await admin.auth().verifyIdToken(match[1]);
      const uid = decoded.uid;
      const db = admin.firestore();

      const adminSnap = await db.collection("admins").doc(uid).get();
      const adminData = adminSnap.data();
      const isSuperAdmin =
        adminSnap.exists &&
        adminData &&
        adminData.active === true &&
        adminData.role === "superAdmin";

      if (!isSuperAdmin) {
        res.status(403).json({
          message: "完全削除はsuperAdminのみ実行できます。",
        });
        return;
      }

      const schoolId = String(req.body.schoolId || "").trim();
      const confirmSchoolId = String(req.body.confirmSchoolId || "").trim();
      const confirmText = String(req.body.confirmText || "").trim();

      if (!schoolId || schoolId !== confirmSchoolId || confirmText !== "完全削除") {
        res.status(400).json({message: "確認情報が一致しません。"});
        return;
      }

      if (schoolId.includes("/") || schoolId === "." || schoolId === "..") {
        res.status(400).json({message: "schoolIdの形式が不正です。"});
        return;
      }

      const schoolRef = db.collection("schools").doc(schoolId);
      const schoolSnap = await schoolRef.get();

      if (!schoolSnap.exists) {
        res.status(404).json({message: "学校が存在しません。"});
        return;
      }

      const schoolData = schoolSnap.data() || {};
      const isSoftDeleted =
        schoolData.deletedAt != null ||
        schoolData.status === "deleted" ||
        schoolData.contractStatus === "deleted";

      if (!isSoftDeleted) {
        res.status(412).json({
          message: "先にAdmin画面で削除扱いにしてください。",
        });
        return;
      }

      const deletedPaths = [];
      const authUids = await collectSchoolAuthUids(schoolRef);

      // 学校ドキュメント外に保存される検証済みセッションも削除する。
      for (const collectionName of ["studentSessions", "teacherSessions"]) {
        await deleteQueryDocuments(
          db.collection(collectionName).where("schoolId", "==", schoolId),
          deletedPaths,
          authUids
        );
      }

      // 旧形式のトップレベルユーザーが残っている場合も対象にする。
      await deleteQueryDocuments(
        db.collection("users").where("schoolId", "==", schoolId),
        deletedPaths,
        authUids
      );

      const featureFlagRef = db.collection("writingFeatureFlags").doc(schoolId);
      if ((await featureFlagRef.get()).exists) {
        await db.recursiveDelete(featureFlagRef);
        deletedPaths.push(featureFlagRef.path);
      }

      await db.collection("admin_delete_logs").add({
        action: "hardDeleteSchoolHttp",
        schoolId,
        schoolName: schoolData.schoolName || null,
        requestedBy: uid,
        requestedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      await db.recursiveDelete(schoolRef);
      deletedPaths.push(schoolRef.path);

      const bucket = admin.storage().bucket();
      for (const prefix of [
        `schools/${schoolId}/`,
        `school_materials/${schoolId}/`,
        `uploads/${schoolId}/`,
      ]) {
        await deleteStoragePrefix(bucket, prefix, deletedPaths);
      }

      for (const authUid of authUids) {
        // 学校データから収集したUIDのみを削除する。
        await admin.auth().deleteUser(authUid).catch((error) => {
          if (error && error.code !== "auth/user-not-found") throw error;
        });
        deletedPaths.push(`auth/${authUid}`);
      }

      await db.collection("admin_delete_logs").add({
        action: "hardDeleteSchoolHttpCompleted",
        schoolId,
        requestedBy: uid,
        deletedCount: deletedPaths.length,
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      res.status(200).json({
        ok: true,
        deletedPath: `schools/${schoolId}`,
        deletedCount: deletedPaths.length,
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({
        message: error.message || "完全削除に失敗しました。",
      });
    }
  }
);
