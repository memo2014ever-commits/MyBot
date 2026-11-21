// سجل العملاء (تدريجي / Lazy) + مشاركة رقم الهاتف المشفّر
// - لا يوجد ترحيل جماعي: العميل القديم بدون حالة = phone_not_requested، وتتسجل حالته عند أول تفاعل له فقط.
// - رقم الهاتف بيتخزن مشفّر AES-256-GCM بمفتاح من متغير البيئة PHONE_ENC_KEY (مش في الكود ولا GitHub).
// - مفيش أي طباعة لأرقام الهواتف في الـ logs.
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { firestoreCommand } from "./firebase.js";
import { cairoDayOf } from "./stats.js";

// ثلاث مجموعات حقول (كل مجموعة: chatId -> قيمة)
const INFO = "cu:info";   // JSON: { n: الاسم, u: username, fs: أول تفاعل مسجل (ms), pt: وقت مشاركة الرقم }
const PHS = "cu:phs";     // الحالة: phone_shared | phone_skipped | phone_prompted (الغياب = phone_not_requested)
const PH = "cu:ph";       // رقم الهاتف المشفّر

export const PHONE_STATES = ["phone_shared", "phone_skipped", "phone_prompted", "phone_not_requested"];

// ---------- التشفير ----------
function loadKey() {
  const raw = (process.env.PHONE_ENC_KEY || "").trim();
  if (!raw) return null;
  try {
    const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
    return buf.length === 32 ? buf : null;
  } catch { return null; }
}
// الميزة كلها بتشتغل بس لو المفتاح موجود وصحيح (32 بايت). غير كده: مفيش طلب رقم ولا تخزين.
export const phoneFeatureEnabled = () => loadKey() !== null;
const PHONE_CACHE_MS = 60 * 1000;
const phoneDueCache = new Map();
const phoneExistsCache = new Map();
function trimPhoneCache(cache) { if (cache.size > 20000) cache.clear(); }
// كاش بيانات العميل للوحة (الاسم/حالة الرقم) دقيقتين، بدل 3 قراءات لكل عميل في كل تحديث
const customerRawCache = new Map();
const CUSTOMER_CACHE_MS = 2 * 60 * 1000;
function invalidatePhoneCache(id) { phoneDueCache.delete(String(id)); phoneExistsCache.delete(String(id)); customerRawCache.delete(String(id)); }

export function encryptPhone(chatId, phone) {
  const key = loadKey();
  if (!key) throw new Error("PHONE_ENC_KEY missing or invalid");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(String(chatId)));   // الرقم مربوط بمعرف صاحبه: نقله لعميل تاني بيفشل في فك التشفير
  const ct = Buffer.concat([c.update(String(phone), "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

// بيرجع الرقم أو null لو فشل فك التشفير (مفتاح غلط/بيانات تالفة). مبيرميش خطأ ومبيطبعش الرقم.
export function decryptPhone(chatId, blob) {
  try {
    const key = loadKey();
    if (!key || typeof blob !== "string") return null;
    const [v, iv, tag, ct] = blob.split(".");
    if (v !== "v1" || !iv || !tag || !ct) return null;
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    d.setAAD(Buffer.from(String(chatId)));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
  } catch { return null; }
}

// "+20 100 123 4567" -> "+201001234567" ، ويرفض اللي مش رقم منطقي (7-15 رقم حسب E.164)
export function normalizePhone(p) {
  const digits = String(p ?? "").replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15 ? "+" + digits : null;
}

const validId = (id) => /^\d{1,20}$/.test(String(id ?? ""));
const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const fullName = (from) => [from?.first_name, from?.last_name].filter(Boolean).join(" ").slice(0, 150);

// ---------- سجل العميل (الاسم / username / أول تفاعل) ----------
// بيحفظ أول تفاعل مرة واحدة فقط (fs)، ويحدّث الاسم والـ username لو اتغيروا
export async function upsertInfo(from, extra = {}, now = Date.now()) {
  if (!from || !validId(from.id)) return;
  const id = String(from.id);
  const cur = parse(await firestoreCommand(["HGET", INFO, id])) || {};
  const next = { ...cur, n: fullName(from) || cur.n || "", u: from.username || "", fs: cur.fs || now, ...extra };
  if (JSON.stringify(next) !== JSON.stringify(cur)) await firestoreCommand(["HSET", INFO, id, JSON.stringify(next)]);
}

// ---------- حالة مشاركة الرقم + جدول التذكير ----------
// القيمة المخزنة في cu:phs:  الحالة|عدد مرات الظهور|وقت آخر ظهور|وقت بداية الدورة   (والقيم القديمة بدون | بتتقرأ عادي)
//  - phone_prompted (تجاهل الطلب): يظهر في أول تفاعل بعد كل 24 ساعة، لحد 5 مرات.
//  - phone_skipped (ضغط "بدون مشاركة"): يتذكّر كل 3 أيام لمدة 30 يوم من وقت اختياره، وبعدها يقف والزرار يفضل اختياري.
//  - phone_shared: مفيش طلب تاني.
export const PROMPT_POLICY = {
  ignoredMax: 5, ignoredEveryMs: 24 * 3600e3,
  skippedEveryMs: 3 * 24 * 3600e3, skippedWindowMs: 30 * 24 * 3600e3,
};
const baseState = (v) => String(v ?? "").split("|")[0];
function parseState(v) {
  if (!v) return null;
  const [state, c, last, start] = String(v).split("|");
  return { state, count: Number(c) || 0, last: Number(last) || 0, start: Number(start) || 0 };
}
const enc = (state, count, last, start) => `${state}|${count}|${last}|${start}`;

// بيرجع true لو لازم نعرض الطلب للعميل دلوقتي (وبيسجّل الظهور). مفيش طلب لأي عميل بيحصل أكتر من مرة في نفس اللحظة.
export async function phonePromptDue(chatId, now = Date.now()) {
  if (!validId(chatId)) return false;
  const id = String(chatId);
  const cachedUntil = phoneDueCache.get(id) || 0;
  if (cachedUntil > now) return false;
  const due = await phonePromptDueUncached(id, now);
  if (!due) { phoneDueCache.set(id, now + PHONE_CACHE_MS); trimPhoneCache(phoneDueCache); }
  else phoneDueCache.delete(id);
  return due;
}

async function phonePromptDueUncached(id, now) {
  const cur = parseState(await firestoreCommand(["HGET", PHS, id]));
  // أول ظهور: HSETNX ذري (يرجع 1 لطلب واحد بس حتى لو جت رسايل كتير مع بعض)
  if (!cur) return (await firestoreCommand(["HSETNX", PHS, id, enc("phone_prompted", 1, now, now)])) === 1;
  if (cur.state === "phone_shared") return false;
  // سجل قديم من قبل جدول التذكير: نبدأ العدّ من دلوقتي من غير ما نظهر الطلب فجأة
  if (!cur.last) { await firestoreCommand(["HSET", PHS, id, enc(cur.state, cur.count || 1, now, cur.start || now)]); return false; }
  let due = false;
  if (cur.state === "phone_prompted") due = cur.count < PROMPT_POLICY.ignoredMax && now - cur.last >= PROMPT_POLICY.ignoredEveryMs;
  else if (cur.state === "phone_skipped") due = now - cur.start <= PROMPT_POLICY.skippedWindowMs && now - cur.last >= PROMPT_POLICY.skippedEveryMs;
  if (!due) return false;
  // قفل قصير يمنع تكرار الطلب لو جت رسالتين في نفس اللحظة
  if ((await firestoreCommand(["SET", `pl:${id}`, "1", "NX", "EX", 60])) !== "OK") return false;
  return (await firestoreCommand(["HSET", PHS, id, enc(cur.state, cur.count + 1, now, cur.start || now)])) !== null;
}

// ضغط زرار القايمة الرئيسية: يتسجل إن الطلب اتعرض (من غير ما يلغي أي جدول موجود)
export async function claimPhonePrompt(chatId, now = Date.now()) {
  if (!validId(chatId)) return false;
  invalidatePhoneCache(chatId);
  return (await firestoreCommand(["HSETNX", PHS, String(chatId), enc("phone_prompted", 1, now, now)])) === 1;
}

export async function hasPhone(chatId) {
  if (!validId(chatId)) return false;
  const id = String(chatId), cached = phoneExistsCache.get(id);
  if (cached && cached.until > Date.now()) return cached.value;
  const value = (await firestoreCommand(["HEXISTS", PH, id])) === 1;
  phoneExistsCache.set(id, { value, until: Date.now() + PHONE_CACHE_MS });
  trimPhoneCache(phoneExistsCache);
  return value;
}

// بيحفظ الرقم مشفّر. بيرجع true بس لو الكتابة نجحت فعلاً
export async function savePhone(from, phone) {
  if (!from || !validId(from.id)) return false;
  const id = String(from.id);
  invalidatePhoneCache(id);
  const blob = encryptPhone(id, phone);
  if ((await firestoreCommand(["HSET", PH, id, blob])) === null) return false;
  if ((await firestoreCommand(["HSET", PHS, id, "phone_shared"])) === null) return false;
  await upsertInfo(from, { pt: Date.now() }).catch(() => {});
  return true;
}

// "الاستمرار بدون مشاركة": ما بيلغيش رقم محفوظ فعلاً
export async function skipPhone(from) {
  if (!from || !validId(from.id)) return false;
  const id = String(from.id);
  invalidatePhoneCache(id);
  if (await hasPhone(id)) return true;
  const now = Date.now(), cur = parseState(await firestoreCommand(["HGET", PHS, id]));
  // ضغطة "بدون مشاركة": بداية دورة التذكير كل 3 أيام (ولو كان متخطي قبل كده نحتفظ ببداية الدورة)
  const keep = cur && cur.state === "phone_skipped" && cur.start;
  const r = await firestoreCommand(["HSET", PHS, id, enc("phone_skipped", keep ? cur.count : 0, now, keep ? cur.start : now)]);
  await upsertInfo(from).catch(() => {});
  return r !== null;
}

// ---------- قراءة للوحة الإدارة ----------
function stateOf(stored, hasPh) {
  if (hasPh) return "phone_shared";
  const b = baseState(stored);
  return PHONE_STATES.includes(b) && b !== "phone_shared" ? b : "phone_not_requested";
}

// بيانات مجموعة عملاء (للأسئلة): 3 استعلامات مجمعة مهما كان العدد
export async function customerMap(ids, { withPhones = false } = {}) {
  const list = [...new Set(ids.map(String).filter(validId))];
  const out = {};
  if (!list.length) return out;
  const now = Date.now();
  const missing = list.filter((id) => { const e = customerRawCache.get(id); return !e || now - e.t >= CUSTOMER_CACHE_MS; });
  if (missing.length) {
    const [infos, states, phones] = await Promise.all([
      firestoreCommand(["HMGET", INFO, ...missing]), firestoreCommand(["HMGET", PHS, ...missing]), firestoreCommand(["HMGET", PH, ...missing]),
    ]);
    if (customerRawCache.size > 5000) customerRawCache.clear();
    missing.forEach((id, i) => customerRawCache.set(id, { t: now, info: infos?.[i] ?? null, state: states?.[i] ?? null, ph: phones?.[i] ?? null }));
  }
  list.forEach((id) => {
    const e = customerRawCache.get(id) || {};
    const info = parse(e.info) || {};
    const hasPh = !!e.ph;
    out[id] = {
      chatId: id, name: info.n || "", username: info.u || "", firstSeen: info.fs || null,
      phoneState: stateOf(e.state, hasPh), hasPhone: hasPh,
      ...(withPhones && hasPh ? { phone: decryptPhone(id, e.ph) } : {}),
    };
  });
  return out;
}

function toObj(arr) { const o = {}; for (let i = 0; i < (arr?.length || 0); i += 2) o[arr[i]] = arr[i + 1]; return o; }

// كل العملاء المعروفين: اللي ليهم سجل + أصحاب الأسئلة (حتى لو قدامى بدون سجل بعد)
// كل صفحة/بحث/فلتر في تاب العملاء: تم تحسينه لمنع قراءة cu:ph بالكامل (HGETALL PH) لتوفير آلاف القراءات
let hashesCache = { t: 0, v: null, p: null };
async function loadCustomerHashes() {
  const now = Date.now();
  if (hashesCache.v && now - hashesCache.t < CUSTOMER_CACHE_MS) return hashesCache.v;
  if (hashesCache.p) return hashesCache.p;
  // نكتفي بـ INFO و PHS فقط؛ قراءة PH محذوفة تماماً لمنع قراءة النصوص المشفرة غير المعروضة
  const p = Promise.all([firestoreCommand(["HGETALL", INFO]), firestoreCommand(["HGETALL", PHS])])
    .then(([infoA, phsA]) => { hashesCache = { t: Date.now(), v: { infoA, phsA, phA: [] }, p: null }; return hashesCache.v; })
    .catch((e) => { hashesCache.p = null; throw e; });
  hashesCache.p = p;
  return p;
}
export async function listCustomers({ questions = [], filter = "all", q = "", withPhones = false } = {}) {
  const { infoA, phsA } = await loadCustomerHashes();
  const infos = toObj(infoA), states = toObj(phsA);
  const byId = {};
  const ensure = (id) => (byId[id] ||= { chatId: id, name: "", username: "", firstSeen: null });
  Object.keys(infos).forEach((id) => { const i = parse(infos[id]) || {}; Object.assign(ensure(id), { name: i.n || "", username: i.u || "", firstSeen: i.fs || null }); });
  Object.keys(states).forEach(ensure);
  questions.forEach((x) => {
    if (!validId(x.chatId)) return;
    const c = ensure(String(x.chatId));
    if (!c.name && x.customerName) c.name = x.customerName;
    if (!c.username && x.username) c.username = x.username;
    if (!c.firstSeen || x.t < c.firstSeen) c.firstSeen = x.t;   // أقدم سؤال = أقدم تفاعل معروف
  });
  const needle = String(q || "").trim().toLowerCase().replace(/^@/, "");
  let rows = Object.values(byId).map((c) => {
    const st = states[c.chatId];
    const info = parse(infos[c.chatId]);
    const hasPh = (st && baseState(st) === "phone_shared") || !!(info?.pt);
    return { ...c, phoneState: stateOf(st, hasPh), hasPhone: hasPh };
  });
  if (filter === "shared") rows = rows.filter((c) => c.hasPhone);
  else if (filter === "notshared") rows = rows.filter((c) => !c.hasPhone);
  if (needle) {
    rows = rows.filter((c) => {
      return c.name.toLowerCase().includes(needle) || c.username.toLowerCase().includes(needle) || c.chatId.includes(needle);
    });
  }
  rows.sort((a, b) => (b.firstSeen || 0) - (a.firstSeen || 0));
  return rows;
}

export async function customerDetail(chatId, { withPhones = false } = {}) {
  const m = await customerMap([chatId], { withPhones });
  return m[String(chatId)] || null;
}

export async function phoneSharedCount() {
  return Number((await firestoreCommand(["HLEN", PH])) ?? 0) || 0;
}

// عدد اللي شاركوا أرقامهم في يوم محدد (يعاد استخدام الكاش لتوفير HGETALL إضافية)
export async function phonesSharedOnDay(date) {
  const { infoA } = await loadCustomerHashes().catch(() => ({ infoA: [] }));
  const o = toObj(infoA || []);
  let n = 0;
  for (const v of Object.values(o)) { const pt = parse(v)?.pt; if (pt && cairoDayOf(pt) === date) n++; }
  return n;
}
