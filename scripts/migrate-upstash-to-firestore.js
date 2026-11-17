import { firestoreCommand } from "../api/firebase.js";

const URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const BATCH_SIZE = 400;

if (!URL || !TOKEN) throw new Error("Set KV_REST_API_URL and KV_REST_API_TOKEN before running the migration");
if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw new Error("Set FIREBASE_SERVICE_ACCOUNT before running the migration");

async function redis(command) {
  const response = await fetch(URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const result = await response.json();
  if (!response.ok || result.error) throw new Error(`Upstash command ${command[0]} failed: ${result.error || response.status}`);
  return result.result;
}

async function listKeys() {
  const keys = new Set();
  let cursor = "0";
  do {
    const result = await redis(["SCAN", cursor, "COUNT", BATCH_SIZE]);
    if (!Array.isArray(result) || result.length !== 2 || !Array.isArray(result[1])) {
      throw new Error("Unexpected response from Upstash SCAN");
    }
    cursor = String(result[0]);
    result[1].forEach((key) => keys.add(String(key)));
  } while (cursor !== "0");
  return [...keys];
}

function isHyperLogLog(key) {
  return key === "subs:all"
    || /^active:day:\d{4}-\d{2}-\d{2}$/.test(key)
    || /^subs:(?:new:)?day:\d{4}-\d{2}-\d{2}$/.test(key);
}

async function copyHash(key) {
  const fields = await redis(["HGETALL", key]);
  if (!Array.isArray(fields) || fields.length % 2 !== 0) throw new Error(`Invalid hash data for ${key}`);
  for (let i = 0; i < fields.length; i += BATCH_SIZE * 2) {
    await firestoreCommand(["HSET", key, ...fields.slice(i, i + BATCH_SIZE * 2)]);
  }
}

async function copyList(key) {
  const values = await redis(["LRANGE", key, 0, -1]);
  if (!Array.isArray(values)) throw new Error(`Invalid list data for ${key}`);
  for (let end = values.length; end > 0; end -= BATCH_SIZE) {
    const start = Math.max(0, end - BATCH_SIZE);
    await firestoreCommand(["LPUSH", key, ...values.slice(start, end).reverse()]);
  }
}

async function copySet(key) {
  const values = await redis(["SMEMBERS", key]);
  if (!Array.isArray(values)) throw new Error(`Invalid set data for ${key}`);
  for (let i = 0; i < values.length; i += BATCH_SIZE) {
    await firestoreCommand(["SADD", key, ...values.slice(i, i + BATCH_SIZE)]);
  }
}

async function copyString(key) {
  const value = await redis(["GET", key]);
  if (value === null) return false;
  const ttl = Number(await redis(["TTL", key]));
  if (ttl === -2 || ttl === 0) return false;
  if (ttl > 0) await firestoreCommand(["SET", key, value, "EX", ttl]);
  else await firestoreCommand(["SET", key, value]);
  return true;
}

async function migrateKey(key) {
  if (isHyperLogLog(key)) {
    const count = Number(await redis(["PFCOUNT", key]));
    await firestoreCommand(["PFBASE", key, count]);
    return "hyperloglog";
  }

  const type = String(await redis(["TYPE", key]));
  if (type === "hash") await copyHash(key);
  else if (type === "list") await copyList(key);
  else if (type === "set") await copySet(key);
  else if (type === "string") {
    if (!(await copyString(key))) return "expired";
  } else if (type !== "none") {
    throw new Error(`Unsupported Upstash data type "${type}"`);
  }
  return type;
}

const keys = await listKeys();
if (!keys.length) {
  console.log("No Upstash keys found; nothing to migrate.");
  process.exit(0);
}

let existing = 0;
for (const key of keys) {
  if (await firestoreCommand(["EXISTS", key])) existing++;
}
if (existing) {
  throw new Error(`Firestore already contains ${existing} matching key(s). No data was copied; migrate into an empty Firestore database.`);
}

const totals = {};
for (let i = 0; i < keys.length; i++) {
  const type = await migrateKey(keys[i]);
  totals[type] = (totals[type] || 0) + 1;
  if ((i + 1) % 25 === 0 || i + 1 === keys.length) {
    console.log(`Migrated ${i + 1}/${keys.length} keys`);
  }
}

console.log("Migration complete:", JSON.stringify(totals));
