import { createHash } from "crypto";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";

const ROOTS = "bot_data";
let firestore;
let lastFirestoreError = null;

function getDb() {
  if (firestore) return firestore;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT is not configured");

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch {
    throw new Error("FIREBASE_SERVICE_ACCOUNT must be a valid JSON string");
  }
  if (!serviceAccount.project_id || !serviceAccount.client_email || !serviceAccount.private_key) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT is missing required service account fields");
  }
  serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");

  const app = getApps()[0] || initializeApp({ credential: cert(serviceAccount) });
  firestore = getFirestore(app);
  return firestore;
}

export function getLastFirestoreError() {
  return lastFirestoreError;
}

function keyRef(db, key) {
  return db.collection(ROOTS).doc(createHash("sha256").update(String(key)).digest("hex"));
}

function entryRef(root, field) {
  return root.collection("entries").doc(createHash("sha256").update(String(field)).digest("hex"));
}

function expired(data, now = Date.now()) {
  return data?.expiresAt && data.expiresAt <= now;
}

async function validRoot(root) {
  const snapshot = await root.get();
  if (!snapshot.exists) return null;
  const data = snapshot.data();
  if (expired(data)) {
    return getDb().runTransaction(async (tx) => {
      const current = await tx.get(root);
      if (!current.exists || expired(current.data())) {
        if (current.exists) tx.delete(root);
        return null;
      }
      return current.data();
    });
  }
  return data;
}

async function ensureType(root, key, type) {
  await getDb().runTransaction(async (tx) => {
    const snapshot = await tx.get(root);
    const current = snapshot.exists ? snapshot.data() : null;
    if (current && !expired(current)) {
      if (current.type !== type) throw new Error(`Firestore data type mismatch for key ${key}`);
      return;
    }
    tx.set(root, { key, type, nextIndex: 0 });
  });
}

async function readEntries(root) {
  const snapshot = await root.collection("entries").get();
  return snapshot.docs;
}

// عدد العناصر بدون قراءتها: استعلام count() بيتحسب تقريباً بقراءة واحدة لكل 1000 عنصر (بدل قراءة كل عنصر)
async function countEntries(root) {
  const snapshot = await root.collection("entries").count().get();
  return Number(snapshot.data().count) || 0;
}

async function deleteKey(root) {
  const entries = await readEntries(root);
  for (let i = 0; i < entries.length; i += 400) {
    const batch = getDb().batch();
    entries.slice(i, i + 400).forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
  }
  await root.delete();
  return 1;
}

async function runCommand(cmd) {
  const [rawOperation, rawKey, ...args] = cmd || [];
  const operation = String(rawOperation || "").toUpperCase();
  const key = String(rawKey ?? "");
  const db = getDb();
  const root = keyRef(db, key);

  if (operation === "GET") {
    const data = await validRoot(root);
    if (!data) return null;
    if (data.type !== "string") throw new Error(`Firestore data type mismatch for key ${key}`);
    return data.value ?? null;
  }
  if (operation === "EXISTS") {
    return (await validRoot(root)) ? 1 : 0;
  }
  if (operation === "SET") {
    const value = String(args[0]);
    const nx = args.some((x) => String(x).toUpperCase() === "NX");
    const expireIndex = args.findIndex((x) => String(x).toUpperCase() === "EX");
    const expiresAt = expireIndex >= 0 ? Date.now() + Number(args[expireIndex + 1]) * 1000 : null;
    const result = await db.runTransaction(async (tx) => {
      const snapshot = await tx.get(root);
      if (nx && snapshot.exists && !expired(snapshot.data())) return null;
      tx.set(root, { key, type: "string", value, expiresAt });
      return "OK";
    });
    return result;
  }
  if (operation === "DEL") {
    const data = await validRoot(root);
    if (!data) return 0;
    if (data.type === "string") {
      return db.runTransaction(async (tx) => {
        const snapshot = await tx.get(root);
        if (!snapshot.exists || expired(snapshot.data())) return 0;
        tx.delete(root);
        return 1;
      });
    }
    return deleteKey(root);
  }
  if (operation === "INCR") {
    return db.runTransaction(async (tx) => {
      const snapshot = await tx.get(root);
      const data = snapshot.exists && !expired(snapshot.data()) ? snapshot.data() : null;
      if (data && data.type !== "string") throw new Error(`Firestore data type mismatch for key ${key}`);
      const value = (data ? Number(data.value) : 0) + 1;
      if (!Number.isSafeInteger(value)) throw new Error(`Invalid integer value for key ${key}`);
      tx.set(root, { key, type: "string", value: String(value), ...(data?.expiresAt ? { expiresAt: data.expiresAt } : {}) });
      return value;
    });
  }
  if (operation === "EXPIRE") {
    const seconds = Number(args[0]);
    return db.runTransaction(async (tx) => {
      const snapshot = await tx.get(root);
      if (!snapshot.exists || expired(snapshot.data())) return 0;
      tx.update(root, { expiresAt: Date.now() + seconds * 1000 });
      return 1;
    });
  }
  if (operation === "PFBASE") {
    const baselineCount = Number(args[0]);
    if (!Number.isSafeInteger(baselineCount) || baselineCount < 0) throw new Error("Invalid HyperLogLog baseline count");
    return db.runTransaction(async (tx) => {
      const snapshot = await tx.get(root);
      const current = snapshot.exists ? snapshot.data() : null;
      if (current && !expired(current) && current.type !== "hll") throw new Error(`Firestore data type mismatch for key ${key}`);
      tx.set(root, { ...(current && !expired(current) ? current : {}), key, type: "hll", baselineCount, nextIndex: 0 });
      return "OK";
    });
  }

  // ---- الهاش: القراءات مش بتقرا document الجذر خالص (الهاش مفيهوش انتهاء صلاحية)، والعدّ بـ count() ----
  if (operation === "HGET" || operation === "HMGET") {
    const refs = args.map((field) => entryRef(root, field));
    const snapshots = refs.length ? await db.getAll(...refs) : [];
    const values = snapshots.map((doc) => (doc.exists ? doc.data().value : null));
    return operation === "HGET" ? values[0] ?? null : values;
  }
  if (operation === "HEXISTS") return (await entryRef(root, args[0]).get()).exists ? 1 : 0;
  if (operation === "HLEN") return countEntries(root);
  if (operation === "HKEYS") return (await readEntries(root)).map((doc) => doc.data().field);
  if (operation === "HGETALL") return (await readEntries(root)).flatMap((doc) => [doc.data().field, doc.data().value]);

  if (operation === "HSETNX") {
    const field = String(args[0]), value = String(args[1]);
    return db.runTransaction(async (tx) => {
      const rootSnapshot = await tx.get(root);
      const current = rootSnapshot.exists ? rootSnapshot.data() : null;
      if (current && !expired(current) && current.type !== "hash") throw new Error(`Firestore data type mismatch for key ${key}`);
      const ref = entryRef(root, field);
      const existing = await tx.get(ref);
      if (existing.exists && !expired(current)) return 0;
      if (!current || expired(current)) tx.set(root, { key, type: "hash", nextIndex: 0 });
      tx.set(ref, { field, value });
      return 1;
    });
  }
  if (operation === "HSET") {
    if (args.length < 2 || args.length % 2 !== 0) throw new Error("HSET requires field/value pairs");
    const pairs = [];
    for (let i = 0; i < args.length; i += 2) pairs.push({ field: String(args[i]), value: String(args[i + 1]) });
    // transaction واحدة: قراءة الجذر + قراءة الحقول، وبعدها الكتابة (قبل كده: 3 قراءات منفصلة + batch)
    return db.runTransaction(async (tx) => {
      const rootSnapshot = await tx.get(root);
      const current = rootSnapshot.exists ? rootSnapshot.data() : null;
      if (current && !expired(current) && current.type !== "hash") throw new Error(`Firestore data type mismatch for key ${key}`);
      const refs = pairs.map((pair) => entryRef(root, pair.field));
      const snapshots = await Promise.all(refs.map((ref) => tx.get(ref)));
      if (!current || expired(current)) tx.set(root, { key, type: "hash", nextIndex: 0 });
      let added = 0;
      pairs.forEach((pair, i) => { if (!snapshots[i].exists) added++; tx.set(refs[i], { field: pair.field, value: pair.value }); });
      return added;
    });
  }
  if (operation === "HDEL") {
    const refs = args.map((field) => entryRef(root, field));
    const snapshots = await Promise.all(refs.map((ref) => ref.get()));
    const batch = db.batch();
    let removed = 0;
    snapshots.forEach((snapshot, i) => { if (snapshot.exists) { removed++; batch.delete(refs[i]); } });
    if (removed) await batch.commit();
    return removed;
  }
  if (operation === "HINCRBY") {
    const field = String(args[0]), amount = Number(args[1]);
    return db.runTransaction(async (tx) => {
      const rootSnapshot = await tx.get(root);
      const current = rootSnapshot.exists ? rootSnapshot.data() : null;
      if (current && !expired(current) && current.type !== "hash") throw new Error(`Firestore data type mismatch for key ${key}`);
      const ref = entryRef(root, field);
      const snapshot = await tx.get(ref);
      const value = (snapshot.exists ? Number(snapshot.data().value) : 0) + amount;
      if (!Number.isSafeInteger(value)) throw new Error(`Invalid integer value for key ${key}`);
      if (!current || expired(current)) tx.set(root, { key, type: "hash", nextIndex: 0 });
      tx.set(ref, { field, value: String(value) });
      return value;
    });
  }

  // ---- الست و HyperLogLog ----
  if (operation === "SMEMBERS") return (await readEntries(root)).map((doc) => doc.data().field);
  if (operation === "PFCOUNT") {
    const data = await validRoot(root);
    if (!data) return 0;   // يوم/مفتاح فاضي: قراءة واحدة بس
    if (data.type !== "hll") throw new Error(`Firestore data type mismatch for key ${key}`);
    return (Number(data.baselineCount) || 0) + (await countEntries(root));
  }
  if (operation === "SADD" || operation === "PFADD") {
    const type = operation === "PFADD" ? "hll" : "set";
    const fields = args.map(String);
    // transaction واحدة لكل الحقول (قبل كده: transaction للنوع + transaction لكل حقل + قراءة الجذر قبلهم)
    return db.runTransaction(async (tx) => {
      const rootSnapshot = await tx.get(root);
      const current = rootSnapshot.exists ? rootSnapshot.data() : null;
      if (current && !expired(current) && current.type !== type) throw new Error(`Firestore data type mismatch for key ${key}`);
      const refs = fields.map((field) => entryRef(root, field));
      const snapshots = await Promise.all(refs.map((ref) => tx.get(ref)));
      const added = new Set();
      fields.forEach((field, i) => {
        if (snapshots[i].exists || added.has(field)) return;
        added.add(field);
        tx.set(refs[i], { field, value: "1" });
      });
      if (!current || expired(current)) tx.set(root, { key, type, nextIndex: 0 });
      return added.size;
    });
  }
  if (operation === "SREM") {
    const refs = args.map((field) => entryRef(root, field));
    const snapshots = await Promise.all(refs.map((ref) => ref.get()));
    const batch = db.batch();
    let removed = 0;
    snapshots.forEach((snapshot, i) => { if (snapshot.exists) { removed++; batch.delete(refs[i]); } });
    if (removed) await batch.commit();
    return removed;
  }

  // ---- القوائم (الأسئلة وغيرها). كل تغيير بيرفع رقم نسخة "ver" في document الجذر علشان اللوحة تعرف إن فيه جديد بقراءة واحدة ----
  if (operation === "LVER") {
    const snapshot = await root.get();
    return snapshot.exists ? Number(snapshot.data().ver) || 0 : 0;
  }
  if (operation === "LPUSH") {
    if (!args.length) throw new Error("LPUSH requires a value");
    const result = await db.runTransaction(async (tx) => {
      const snapshot = await tx.get(root);
      const current = snapshot.exists && !expired(snapshot.data()) ? snapshot.data() : null;
      if (current && current.type !== "list") throw new Error(`Firestore data type mismatch for key ${key}`);
      let nextIndex = current?.nextIndex || 0;
      const refs = [];
      const values = [];
      for (const value of args) {
        nextIndex -= 1;
        refs.push(root.collection("entries").doc(`item_${String(-nextIndex).padStart(16, "0")}`));
        values.push(String(value));
      }
      tx.set(root, { key, type: "list", nextIndex, ver: (Number(current?.ver) || 0) + 1 });
      refs.forEach((ref, i) => tx.set(ref, { position: nextIndex + args.length - 1 - i, value: values[i] }));
      return true;
    });
    // كل المستدعين يحتاجون نجاح العملية فقط؛ حساب طول القائمة هنا كان يضيف
    // count() بعد كل LPUSH (سؤال/سجل/تنبيه) بلا أي استخدام فعلي للعدد.
    return result ? true : 0;
  }
  if (operation === "LRANGE" || operation === "LSET" || operation === "LREM") {
    let query = root.collection("entries").orderBy("position", "asc");
    // مدى موجب (من الأول) بنقرا العدد المطلوب بس بدل القائمة كلها
    if (operation === "LRANGE" && Number(args[0]) >= 0 && Number(args[1]) >= 0) query = query.limit(Number(args[1]) + 1);
    const docs = (await query.get()).docs;
    if (operation === "LRANGE") {
      let start = Number(args[0]), end = Number(args[1]);
      if (start < 0) start = docs.length + start;
      if (end < 0) end = docs.length + end;
      return docs.slice(Math.max(0, start), end + 1).map((doc) => doc.data().value);
    }
    if (operation === "LSET") {
      let index = Number(args[0]);
      if (index < 0) index = docs.length + index;
      const doc = docs[index];
      if (!doc) return null;
      const batch = db.batch();
      batch.update(doc.ref, { value: String(args[1]) });
      batch.update(root, { ver: FieldValue.increment(1) });
      await batch.commit();
      return "OK";
    }
    const count = Number(args[0]), value = String(args[1]);
    const matches = docs.filter((doc) => doc.data().value === value);
    const selected = count > 0 ? matches.slice(0, count) : count < 0 ? matches.slice(count) : matches;
    if (selected.length) {
      const batch = db.batch();
      selected.forEach((doc) => batch.delete(doc.ref));
      batch.update(root, { ver: FieldValue.increment(1) });
      await batch.commit();
    }
    return selected.length;
  }

  throw new Error(`Unsupported Firestore storage operation: ${operation}`);
}

export async function firestoreCommand(cmd) {
  try {
    return await runCommand(cmd);
  } catch (error) {
    lastFirestoreError = { t: Date.now(), msg: String(error?.message || error).slice(0, 200) };
    console.error("[firestore]", lastFirestoreError.msg);
    throw error;
  }
}
