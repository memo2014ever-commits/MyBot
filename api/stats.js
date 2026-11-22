// الإحصائيات والأسئلة والتخزين المشترك في Firestore.
import { createHash, randomUUID } from "crypto";
import { firestoreCommand } from "./firebase.js";

export function dayKey(offset = 0) {
  const d = new Date(Date.now() + offset * 86400000);
  return d.toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
}
export const todayKey = () => dayKey(0);
export const cairoDayOf = (ts) => new Date(Number(ts)).toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });

// كاش محلي يمنع تكرار أوامر HyperLogLog لنفس العميل في اليوم على نفس النسخة.
const visitorSeenToday = new Set();
const activeSeenToday = new Set();
function cacheKey(chatId) { return `${todayKey()}:${String(chatId)}`; }
function trimSeen(set) { if (set.size > 20000) set.clear(); }

// عميل جديد (/start) - تم تحييدها لتوفير حصة Firestore (بدون تأثير على عمل البوت)
export async function trackVisitor(chatId) {
  return;
}

// أي تفاعل فعلي مع البوت - تم تحييدها لتوفير حصة Firestore (بدون تأثير على عمل البوت)
export async function trackActive(chatId) {
  return;
}

// نحافظ على الإحصائيات المجمعة حسب الزر والساعة - تم تحييدها لتوفير استهلاك القراءات
function hourNow() {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: "Africa/Cairo", hour: "numeric", hourCycle: "h23" }).format(new Date());
  return String(Number(h));
}

export async function trackPress(path, label) {
  return;
}

// سؤال معلّق لمدة 10 دقايق لحد ما العميل يختار من "تقصد؟" أو يأكد إنه يبعته
function pendKey(chatId) {
  return "pend:" + createHash("sha256").update(String(chatId)).digest("hex").slice(0, 16);
}
export async function setPending(chatId, text) {
  await firestoreCommand(["SET", pendKey(chatId), String(text).slice(0, 500), "EX", 600]);
}
export async function takePending(chatId) {
  const k = pendKey(chatId);
  const v = await firestoreCommand(["GET", k]);
  if (v) await firestoreCommand(["DEL", k]);
  return v;
}

// صورة معلّقة لمدة 10 دقايق لحد ما العميل يكتب السؤال
function pendImgKey(chatId) {
  return "pendimg:" + createHash("sha256").update(String(chatId)).digest("hex").slice(0, 16);
}
export async function setPendingImage(chatId, url) {
  await firestoreCommand(["SET", pendImgKey(chatId), String(url), "EX", 600]);
}
export async function takePendingImage(chatId) {
  const k = pendImgKey(chatId);
  const v = await firestoreCommand(["GET", k]);
  if (v) await firestoreCommand(["DEL", k]);
  return v;
}
let nextLocalExpiryCheck = 0;
export async function maybeExpireQuestions(now = Date.now()) {
  if (now < nextLocalExpiryCheck) return [];
  nextLocalExpiryCheck = now + 5 * 60 * 1000;
  let ok = null;
  try { ok = await firestoreCommand(["SET", "expiry:lock", "1", "NX", "EX", 600]); } catch { return []; }
  if (ok !== "OK") return [];
  nextLocalExpiryCheck = now + 10 * 60 * 1000;
  return closeExpiredQuestions(now);
}

// ==================== مفتاح استقبال الأسئلة الجديدة ====================
// محفوظ في Firestore (بيسري فوراً من غير نشر). بيأثر على إنشاء الأسئلة الجديدة فقط.
export const DEFAULT_INTAKE_MESSAGE = "نعتذر 🙏 استقبال الأسئلة الجديدة متوقف مؤقتاً حالياً.\nتقدر تتصفح القوايم والإجابات الجاهزة زي الأول، والمتابعات على أسئلتك السابقة شغالة بشكل طبيعي. هنفتح الاستقبال تاني قريباً.";
const INTAKE_KEY = "cfg:intake";
export async function getIntake() {
  const a = await firestoreCommand(["HMGET", INTAKE_KEY, "enabled", "message", "by", "at"]);
  // لو مفيش إعداد: الاستقبال مفعل (الوضع الافتراضي القديم)
  return { enabled: !Array.isArray(a) || a[0] !== "0", message: (Array.isArray(a) && a[1]) || "", updatedBy: (Array.isArray(a) && a[2]) || "", updatedAt: (Array.isArray(a) && Number(a[3])) || null };
}
export async function setIntake(enabled, message, by) {
  const args = ["HSET", INTAKE_KEY, "enabled", enabled ? "1" : "0", "by", String(by).slice(0, 50), "at", Date.now()];
  if (typeof message === "string") args.push("message", message.trim().slice(0, 500));
  const r = await firestoreCommand(args);
  if (r === null) return false;
  await firestoreCommand(["LPUSH", "intake_log", JSON.stringify({ t: Date.now(), enabled: !!enabled, by: String(by).slice(0, 50) })]);
  return true;
}

export async function pushQuestion(text, chatId, customerName = "", attachments = [], username = "", intakeChecked = false) {
  // استدعاء webhook يمرر نتيجة فحص الاستقبال لتجنب قراءة الإعداد مرتين.
  if (!intakeChecked) {
    const intake = await getIntake();
    if (!intake.enabled) return { ok: false, reason: "intake_paused", message: intake.message };
  }
  const question = {
    id: randomUUID(), t: Date.now(), q: String(text).slice(0, 500), chatId: String(chatId), customerName: String(customerName).slice(0, 150), username: String(username || "").slice(0, 64), status: "open",
    attachments: Array.isArray(attachments) ? attachments.slice(0, 5) : [],
  };
  const saved = await firestoreCommand(["LPUSH", "questions", JSON.stringify(question)]);
  if (saved === null) return { ok: false, reason: "save_failed" };
  return { ok: true, question };
}

const MAX_QUESTIONS = 3;
const WINDOW_SECONDS = 86400;
function qKey(chatId) { return `qrate:${createHash("sha256").update(String(chatId)).digest("hex").slice(0, 16)}`; }
export async function questionsLeft(chatId) {
  const used = Number((await firestoreCommand(["GET", qKey(chatId)])) ?? 0);
  return Math.max(0, MAX_QUESTIONS - used);
}
export async function questionAllowed(chatId) {
  const key = qKey(chatId), n = await firestoreCommand(["INCR", key]);
  if (n === null) return null;
  if (n === 1 && (await firestoreCommand(["EXPIRE", key, WINDOW_SECONDS])) === null) return null;
  return { allowed: n <= MAX_QUESTIONS, left: Math.max(0, MAX_QUESTIONS - n) };
}
export const MAX_QUESTIONS_COUNT = MAX_QUESTIONS;

export async function getQuestions() {
  const raw = (await firestoreCommand(["LRANGE", "questions", 0, -1])) || [];
  return raw.map((r) => ({ raw: r, ...JSON.parse(r) }));
}

// رقم نسخة قايمة الأسئلة (بيزيد مع أي إضافة/تعديل/حذف). قراءة واحدة بدل قراءة القايمة كلها
export async function getQuestionsVersion() {
  return Number(await firestoreCommand(["LVER", "questions"])) || 0;
}

// نسخة مؤقتة من الأسئلة للعرض فقط (الإحصائيات وقايمة العملاء). أي تعديل/حذف/إجابة بيعتمد على getQuestions الطازجة مش على دي
let qCache = { t: 0, list: null, p: null };
export function invalidateQuestionsCache() { qCache = { t: 0, list: null, p: null }; }
export function seedQuestionsCache(list) { qCache = { t: Date.now(), list, p: null }; }
export async function getQuestionsCached(maxAgeMs = 48 * 60 * 60 * 1000) {
  const now = Date.now();
  if (qCache.list && now - qCache.t < maxAgeMs) return qCache.list;
  if (qCache.p) return qCache.p;
  const p = getQuestions().then((list) => { qCache = { t: Date.now(), list, p: null }; return list; }).catch((e) => { qCache.p = null; throw e; });
  qCache.p = p;
  return p;
}

// إحصائيات حالات الأسئلة. كل سؤال أصلي بيتعد مرة واحدة (بالـ id)، والمتابعات جوه السؤال نفسه فمش بتتعد كأسئلة.
export function computeQuestionStats(list) {
  const seen = new Set();
  const c = { total: 0, open: 0, followupPending: 0, awaitingCustomer: 0, closed: 0, legacyAnswered: 0, other: 0, closedTimeout: 0, closedMaxFollowups: 0, closedManual: 0 };
  for (const x of list || []) {
    if (!x) continue;
    const key = x.id || x.raw;
    if (key) { if (seen.has(key)) continue; seen.add(key); }
    c.total++;
    const st = x.status || "open";
    if (st === "open") c.open++;
    else if (st === "followup_pending") c.followupPending++;
    else if (st === "awaiting_followup") c.awaitingCustomer++;
    else if (st === "archived") {
      c.closed++;
      if (x.closeReason === "timeout") c.closedTimeout++;
      else if (x.closeReason === "max_followups") c.closedMaxFollowups++;
      else c.closedManual++;
    }
    else if (st === "answered") c.legacyAnswered++;
    else c.other++;
  }
  return { ...c, archiveTotal: c.closed + c.legacyAnswered };
}

export async function deleteQuestion(raw) { await firestoreCommand(["LREM", "questions", 1, raw]); }

export const FOLLOWUP_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MAX_FOLLOWUPS = 10;

// ==================== سجل العميل وحد المتابعات الإضافي ====================
export const MAX_EXTRA_PER_OPERATION = 100;
const validChatId = (id) => /^\d{1,20}$/.test(String(id ?? ""));
const EXTRA_KEY = "fu:extra";

export async function getExtraFollowups(chatId) {
  if (!validChatId(chatId)) return 0;
  const v = Number((await firestoreCommand(["HGET", EXTRA_KEY, String(chatId)])) ?? 0);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}
export async function getAllExtras() {
  const o = toObj((await firestoreCommand(["HGETALL", EXTRA_KEY])) || []);
  Object.keys(o).forEach((k) => { if (!(o[k] > 0)) delete o[k]; });
  return o;
}
export const followupLimitFor = (extra = 0) => MAX_FOLLOWUPS + Math.max(0, Number(extra) || 0);

export const limitForItem = (item, permanent = 0) =>
  MAX_FOLLOWUPS + Math.max(0, Number(permanent) || 0) + Math.max(0, Number(item?.extraFollowups) || 0);
const ACTIVE_STATUSES = ["open", "awaiting_followup", "followup_pending"];

// أحدث سؤال للعميل (القائمة من الأحدث للأقدم) - نبحث في أول 100 سؤال أولاً لتقليل القراءات
async function latestQuestionOf(chatId) {
  let raw = (await firestoreCommand(["LRANGE", "questions", 0, 99])) || [];
  for (let i = 0; i < raw.length; i++) {
    let item; try { item = JSON.parse(raw[i]); } catch { continue; }
    if (String(item.chatId) === String(chatId)) return { index: i, item };
  }
  raw = (await firestoreCommand(["LRANGE", "questions", 0, -1])) || [];
  for (let i = 0; i < raw.length; i++) {
    let item; try { item = JSON.parse(raw[i]); } catch { continue; }
    if (String(item.chatId) === String(chatId)) return { index: i, item };
  }
  return null;
}

export async function followupLimitState(chatId) {
  const permanent = await getExtraFollowups(chatId);
  const found = await latestQuestionOf(chatId);
  const item = found?.item || null;
  const reopenable = !!item && item.status === "archived" && item.closeReason === "max_followups";
  const active = !!item && (ACTIVE_STATUSES.includes(item.status || "open") || reopenable);
  const questionExtra = Math.max(0, Number(item?.extraFollowups) || 0);
  const totalLimit = item ? limitForItem(item, permanent) : MAX_FOLLOWUPS + permanent;
  const used = item ? (item.followups || []).length : null;
  return {
    permanentExtra: permanent, questionId: item?.id || null, questionStatus: item?.status || null, questionExtra,
    totalLimit, used, remaining: used === null ? null : Math.max(0, totalLimit - used), canAdjust: active, reopenable,
  };
}

export async function adjustQuestionExtra(chatId, op, amount = 0, now = Date.now()) {
  if (!validChatId(chatId)) return { error: "معرف العميل غير صحيح" };
  if (!["add", "sub", "clear"].includes(op)) return { error: "عملية غير معروفة" };
  if (op !== "clear" && (!Number.isInteger(amount) || amount < 1 || amount > MAX_EXTRA_PER_OPERATION)) return { error: `أدخل رقم صحيح من 1 إلى ${MAX_EXTRA_PER_OPERATION}` };
  const found = await latestQuestionOf(chatId);
  if (!found) return { error: "العميل ده مالوش أسئلة" };
  const { index, item } = found;
  const reopen = op === "add" && item.status === "archived" && item.closeReason === "max_followups";
  if (!ACTIVE_STATUSES.includes(item.status || "open") && !reopen) {
    return { error: "مفيش سؤال شغّال للعميل ده. الزيادة بتتطبق على السؤال المفتوح بس (وبتنتهي بانتهائه)." };
  }
  const permanent = await getExtraFollowups(chatId);
  const cur = Math.max(0, Number(item.extraFollowups) || 0);
  if (op === "sub" && amount > cur) return { error: cur ? `زيادة السؤال الحالية ${cur} فقط، مينفعش تنقّص أكتر منها` : "مفيش زيادة على السؤال ده عشان تتنقّص" };
  if (op === "clear" && cur === 0) return { error: "مفيش زيادة على السؤال ده" };
  const next = op === "add" ? cur + amount : op === "sub" ? cur - amount : 0;
  const prevLimit = limitForItem(item, permanent), newLimit = limitForItem({ extraFollowups: next }, permanent);
  let updated = { ...item, extraFollowups: next };
  if (next === 0) delete updated.extraFollowups;
  if (reopen && (item.followups || []).length < newLimit) {
    updated = { ...updated, status: "awaiting_followup", closedAt: null, closeReason: null, reopenedAt: now, lastActivityAt: now, followupUntil: now + FOLLOWUP_WINDOW_MS };
  }
  const r = await firestoreCommand(["LSET", "questions", index, JSON.stringify(updated)]);
  if (r === null) return { error: "فشل حفظ التغيير، لم يتم تغيير أي شيء", fatal: true };
  return { ok: true, questionId: item.id, prevLimit, newLimit, delta: next - cur, reopened: reopen && updated.status === "awaiting_followup" };
}

export async function clearPermanentExtra(chatId) {
  if (!validChatId(chatId)) return { error: "معرف العميل غير صحيح" };
  const prev = await getExtraFollowups(chatId);
  if (prev === 0) return { error: "مفيش إضافي دائم للعميل ده" };
  const r = await firestoreCommand(["HDEL", EXTRA_KEY, String(chatId)]);
  if (r === null) return { error: "فشل الحذف، لم يتم تغيير أي شيء", fatal: true };
  return { ok: true, prevExtra: prev, prevLimit: MAX_FOLLOWUPS + prev, newLimit: MAX_FOLLOWUPS, delta: -prev };
}

export async function claimOperation(requestId) {
  if (typeof requestId !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(requestId)) return false;
  return (await firestoreCommand(["SET", `op:${requestId}`, "1", "NX", "EX", 600])) === "OK";
}

export async function logLimitChange(entry) {
  await firestoreCommand(["LPUSH", "followup_log", JSON.stringify(entry)]);
}
export async function getLimitLog(chatId = null) {
  const raw = (await firestoreCommand(["LRANGE", "followup_log", 0, 49])) || [];
  const all = raw.map((r) => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
  return chatId ? all.filter((e) => String(e.chatId) === String(chatId)) : all;
}

export async function closeExpiredQuestions(now = Date.now(), rawOverride = null) {
  const raw = rawOverride || (await firestoreCommand(["LRANGE", "questions", 0, -1])) || [];
  const closed = [];
  for (let i = 0; i < raw.length; i++) {
    try {
      const item = JSON.parse(raw[i]);
      if (item.status === "awaiting_followup" && item.followupUntil && item.followupUntil <= now) {
        const updated = { ...item, status: "archived", closedAt: now, closeReason: "timeout" };
        const encoded = JSON.stringify(updated);
        const saved = await firestoreCommand(["LSET", "questions", i, encoded]);
        if (saved !== null) {
          raw[i] = encoded;
          closed.push({ ...updated, raw: encoded });
        }
      }
    } catch {}
  }
  return closed;
}

export async function getQuestionsAndCloseExpired(now = Date.now()) {
  const raw = (await firestoreCommand(["LRANGE", "questions", 0, -1])) || [];
  const expired = await closeExpiredQuestions(now, raw);
  return { questions: raw.map((r) => ({ raw: r, ...JSON.parse(r) })), expired };
}

export async function closeQuestion(ref, reason = "manual") {
  let raw = (await firestoreCommand(["LRANGE", "questions", 0, 99])) || [];
  let index = raw.findIndex((r) => {
    try { return JSON.parse(r).id === ref || r === ref; } catch { return r === ref; }
  });
  if (index < 0) {
    raw = (await firestoreCommand(["LRANGE", "questions", 0, -1])) || [];
    index = raw.findIndex((r) => {
      try { return JSON.parse(r).id === ref || r === ref; } catch { return r === ref; }
    });
  }
  if (index < 0) return null;
  const item = JSON.parse(raw[index]);
  if (item.status === "archived") return { ...item, raw: raw[index] };
  const updated = { ...item, status: "archived", closedAt: Date.now(), closeReason: reason };
  const result = await firestoreCommand(["LSET", "questions", index, JSON.stringify(updated)]);
  return result === null ? null : { ...updated, raw: JSON.stringify(updated) };
}

export async function questionForReply(chatId, messageId, now = Date.now()) {
  const searchLimit = 50;
  const rawRecent = (await firestoreCommand(["LRANGE", "questions", 0, searchLimit - 1])) || [];
  for (let i = 0; i < rawRecent.length; i++) {
    try {
      const item = JSON.parse(rawRecent[i]);
      if (String(item.chatId) !== String(chatId) || item.status !== "awaiting_followup" || !item.followupUntil || item.followupUntil <= now) continue;
      if ((item.answerMessageIds || []).map(Number).includes(Number(messageId))) return { ...item, raw: rawRecent[i], index: i };
    } catch {}
  }
  const rawNext = (await firestoreCommand(["LRANGE", "questions", searchLimit, searchLimit * 2 - 1])) || [];
  for (let i = 0; i < rawNext.length; i++) {
    try {
      const item = JSON.parse(rawNext[i]);
      if (String(item.chatId) !== String(chatId) || item.status !== "awaiting_followup" || !item.followupUntil || item.followupUntil <= now) continue;
      if ((item.answerMessageIds || []).map(Number).includes(Number(messageId))) return { ...item, raw: rawNext[i], index: searchLimit + i };
    } catch {}
  }
  return null;
}

export async function addFollowup(ref, text, attachments = [], now = Date.now()) {
  let raw = (await firestoreCommand(["LRANGE", "questions", 0, 49])) || [];
  let index = raw.findIndex((r) => {
    try { return JSON.parse(r).id === ref || r === ref; } catch { return r === ref; }
  });
  if (index < 0) {
    raw = (await firestoreCommand(["LRANGE", "questions", 50, 149])) || [];
    const idx2 = raw.findIndex((r) => {
      try { return JSON.parse(r).id === ref || r === ref; } catch { return r === ref; }
    });
    if (idx2 >= 0) index = 50 + idx2;
    else {
      raw = (await firestoreCommand(["LRANGE", "questions", 0, -1])) || [];
      index = raw.findIndex((r) => {
        try { return JSON.parse(r).id === ref || r === ref; } catch { return r === ref; }
      });
    }
  }
  if (index < 0) return null;
  const item = JSON.parse(raw[index]);
  const followups = Array.isArray(item.followups) ? item.followups : [];
  const limit = limitForItem(item, await getExtraFollowups(item.chatId).catch(() => 0));
  if (followups.length >= limit) return { ...item, raw: raw[index], limitReached: true };
  const updated = {
    ...item,
    status: "followup_pending",
    lastActivityAt: now,
    followups: [...followups, { t: now, text: String(text).slice(0, 1000), attachments: Array.isArray(attachments) ? attachments.slice(0, 5) : [] }],
  };
  const result = await firestoreCommand(["LSET", "questions", index, JSON.stringify(updated)]);
  return result === null ? null : { ...updated, raw: JSON.stringify(updated) };
}

export async function getQuestionById(questionId) {
  if (!questionId) return null;
  let raw = (await firestoreCommand(["LRANGE", "questions", 0, 49])) || [];
  for (let i = 0; i < raw.length; i++) {
    try {
      const item = JSON.parse(raw[i]);
      if (item.id === questionId || raw[i] === questionId) return item;
    } catch {}
  }
  raw = (await firestoreCommand(["LRANGE", "questions", 50, 99])) || [];
  for (let i = 0; i < raw.length; i++) {
    try {
      const item = JSON.parse(raw[i]);
      if (item.id === questionId || raw[i] === questionId) return item;
    } catch {}
  }
  raw = (await firestoreCommand(["LRANGE", "questions", 0, -1])) || [];
  for (let i = 0; i < raw.length; i++) {
    try {
      const item = JSON.parse(raw[i]);
      if (item.id === questionId || raw[i] === questionId) return item;
    } catch {}
  }
  return null;
}

export async function answerQuestion(ref, answer, telegramMessageId = null) {
  let raw = (await firestoreCommand(["LRANGE", "questions", 0, 49])) || [];
  let index = raw.findIndex((r) => {
    try { return JSON.parse(r).id === ref || r === ref; } catch { return r === ref; }
  });
  if (index < 0) {
    raw = (await firestoreCommand(["LRANGE", "questions", 50, 99])) || [];
    const idx2 = raw.findIndex((r) => {
      try { return JSON.parse(r).id === ref || r === ref; } catch { return r === ref; }
    });
    if (idx2 >= 0) {
      index = 50 + idx2;
    } else {
      raw = (await firestoreCommand(["LRANGE", "questions", 0, -1])) || [];
      index = raw.findIndex((r) => {
        try { return JSON.parse(r).id === ref || r === ref; } catch { return r === ref; }
      });
    }
  }
  if (index < 0) return null;

  const item = JSON.parse(raw[index]);
  if (!item.chatId) return { error: "السؤال قديم ولا يحتوي على معرّف العميل" };
  const now = Date.now();
  const followupCount = Array.isArray(item.followups) ? item.followups.length : 0;
  const limit = limitForItem(item, await getExtraFollowups(item.chatId).catch(() => 0));
  const closesNow = followupCount >= limit;
  const updated = {
    ...item,
    answer: String(answer).slice(0, 3500),
    status: closesNow ? "archived" : "awaiting_followup",
    answeredAt: now,
    lastActivityAt: now,
    followupUntil: closesNow ? null : now + FOLLOWUP_WINDOW_MS,
    closedAt: closesNow ? now : item.closedAt,
    closeReason: closesNow ? "max_followups" : item.closeReason,
    answerMessageIds: [...(item.answerMessageIds || []), ...(telegramMessageId ? [Number(telegramMessageId)] : [])].slice(-10),
    answerHistory: [...(item.answerHistory || []), { t: now, text: String(answer).slice(0, 3500), messageId: telegramMessageId ? Number(telegramMessageId) : null }].slice(-10),
  };
  const result = await firestoreCommand(["LSET", "questions", index, JSON.stringify(updated)]);
  if (result === null) return null;
  return { ...updated, raw: JSON.stringify(updated) };
}

export async function updateAnswerHistory(ref, historyIndex, answer, telegramMessageId = null) {
  let raw = (await firestoreCommand(["LRANGE", "questions", 0, 99])) || [];
  let index = raw.findIndex((r) => {
    try { return JSON.parse(r).id === ref || r === ref; } catch { return r === ref; }
  });
  if (index < 0) {
    raw = (await firestoreCommand(["LRANGE", "questions", 0, -1])) || [];
    index = raw.findIndex((r) => {
      try { return JSON.parse(r).id === ref || r === ref; } catch { return r === ref; }
    });
  }
  if (index < 0) return null;
  const item = JSON.parse(raw[index]);
  const history = Array.isArray(item.answerHistory) && item.answerHistory.length
    ? [...item.answerHistory]
    : (item.answer ? [{ t: item.answeredAt || item.t || Date.now(), text: item.answer, messageId: null }] : []);
  if (!Number.isInteger(historyIndex) || historyIndex < 0 || historyIndex >= history.length) return { error: "الإجابة غير موجودة" };
  const now = Date.now();
  history[historyIndex] = { ...history[historyIndex], text: String(answer).slice(0, 3500), editedAt: now, messageId: telegramMessageId ? Number(telegramMessageId) : history[historyIndex].messageId };
  const updated = {
    ...item,
    answer: history[history.length - 1]?.text || item.answer || "",
    answerHistory: history,
    answeredAt: now,
    lastActivityAt: now,
    followupUntil: now + FOLLOWUP_WINDOW_MS,
    status: item.status === "archived" ? "archived" : "awaiting_followup",
    answerMessageIds: [...(item.answerMessageIds || []), ...(telegramMessageId ? [Number(telegramMessageId)] : [])].slice(-10),
  };
  const result = await firestoreCommand(["LSET", "questions", index, JSON.stringify(updated)]);
  return result === null ? null : { ...updated, raw: JSON.stringify(updated) };
}

async function hoursForDate(date) { return toObj((await firestoreCommand(["HGETALL", `stats:hours:${date}`])) || []); }
function peakHour(hours) {
  const entries = Object.entries(hours).map(([h, n]) => [Number(h), Number(n)]).filter(([, n]) => n > 0);
  if (!entries.length) return null;
  const max = Math.max(...entries.map(([, n]) => n));
  return { hour: entries.filter(([, n]) => n === max).map(([h]) => h).sort((a, b) => a - b)[0], count: max };
}

export async function getStats() {
  const perDay = await Promise.all([6, 5, 4, 3, 2, 1, 0].map(async (off) => {
    const date = dayKey(-off);
    const [active, newSubs, press, hours] = await Promise.all([
      firestoreCommand(["PFCOUNT", `subs:day:${date}`]),
      firestoreCommand(["PFCOUNT", `subs:new:day:${date}`]),
      firestoreCommand(["HGETALL", `stats:press:${date}`]),
      hoursForDate(date),
    ]);
    const byPath = toObj(press);
    return { date, active: active ?? 0, newSubs: newSubs ?? 0, presses: sum(byPath), byPath, hours };
  }));
  const [subsAll, newToday, activeToday] = await Promise.all([
    firestoreCommand(["PFCOUNT", "subs:all"]), firestoreCommand(["PFCOUNT", `subs:new:day:${todayKey()}`]),
    firestoreCommand(["PFCOUNT", `active:day:${todayKey()}`]),
  ]);
  const agg = {};
  perDay.forEach((d) => Object.entries(d.byPath).forEach(([k, v]) => (agg[k] = (agg[k] || 0) + v)));
  const last7Hours = {};
  perDay.forEach((d) => Object.entries(d.hours).forEach(([h, n]) => (last7Hours[h] = (last7Hours[h] || 0) + n)));
  return {
    configured: Boolean(process.env.FIREBASE_SERVICE_ACCOUNT), subscribersTotal: subsAll ?? 0,
    subscribersToday: perDay[6].active, newSubscribersToday: newToday ?? 0, activeToday: activeToday ?? 0,
    pressesToday: perDay[6].presses, pressesYesterday: perDay[5].presses,
    pressByPath: perDay[6].byPath, pressByPath7d: agg,
    hours: last7Hours, last7Hours, peakLast7: peakHour(last7Hours), daily: perDay.map(({ date, newSubs, presses }) => ({ date, newSubs, presses })),
  };
}

export async function getStatsByDay(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("تاريخ غير صحيح");
  const [hours, press] = await Promise.all([hoursForDate(date), firestoreCommand(["HGETALL", `stats:press:${date}`])]);
  const byPath = toObj(press);
  return { date, hours, presses: sum(byPath), byPath, peak: peakHour(hours) };
}

export async function getOverviewDay(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("تاريخ غير صحيح");
  const [newSubs, active, day] = await Promise.all([
    firestoreCommand(["PFCOUNT", `subs:new:day:${date}`]), firestoreCommand(["PFCOUNT", `active:day:${date}`]), getStatsByDay(date),
  ]);
  return { date, newSubs: newSubs ?? 0, active: active ?? 0, presses: day.presses, peak: day.peak };
}

function sum(o) { return Object.values(o).reduce((a, b) => a + b, 0); }
function toObj(arr) { const o = {}; for (let i = 0; i < (arr?.length || 0); i += 2) o[arr[i]] = Number(arr[i + 1]); return o; }

// ==================== نظام الحظر ====================
function banKey(chatId) {
  return "ban:" + createHash("sha256").update(String(chatId)).digest("hex").slice(0, 16);
}

export async function banUser(chatId, reason, bannedBy) {
  const key = banKey(chatId);
  const saved = await firestoreCommand(["HSET", key, "chatId", String(chatId), "reason", String(reason).slice(0, 300), "bannedAt", Date.now(), "bannedBy", String(bannedBy).slice(0, 50)]);
  await firestoreCommand(["SADD", "bans:set", String(chatId)]);
  if (saved !== null) {
    banDecisionCache.set(String(chatId), { value: true, until: Date.now() + BAN_DECISION_CACHE_MS });
    noBansCheckedAt = 0;
    noBansUntil = 0;
  }
}

export async function unbanUser(chatId) {
  await firestoreCommand(["DEL", banKey(chatId)]);
  const removed = await firestoreCommand(["SREM", "bans:set", String(chatId)]);
  if (removed !== null) {
    banDecisionCache.set(String(chatId), { value: false, until: Date.now() + BAN_DECISION_CACHE_MS });
    noBansCheckedAt = 0;
    noBansUntil = 0;
  }
}

const NO_BANS_RECHECK_MS = 48 * 60 * 60 * 1000;
const BAN_DECISION_CACHE_MS = 48 * 60 * 60 * 1000;
const banDecisionCache = new Map();
let noBansCheckedAt = 0;
let noBansUntil = 0;

async function knownNoBans(now) {
  if (noBansUntil > now) return true;
  if (noBansCheckedAt && now - noBansCheckedAt < NO_BANS_RECHECK_MS) return false;
  const ids = await firestoreCommand(["SMEMBERS", "bans:set"]);
  noBansCheckedAt = now;
  if (Array.isArray(ids) && ids.length === 0) {
    noBansUntil = now + NO_BANS_RECHECK_MS;
    return true;
  }
  return false;
}

export async function isBanned(chatId) {
  const now = Date.now();
  const id = String(chatId);
  if (await knownNoBans(now)) return false;
  const cached = banDecisionCache.get(id);
  if (cached && cached.until > now) return cached.value;
  const value = (await firestoreCommand(["HEXISTS", banKey(id), "chatId"])) === 1;
  banDecisionCache.set(id, { value, until: now + BAN_DECISION_CACHE_MS });
  if (banDecisionCache.size > 20000) banDecisionCache.clear();
  return value;
}

export async function getBanInfo(chatId) {
  const arr = await firestoreCommand(["HGETALL", banKey(chatId)]);
  if (!arr || !arr.length) return null;
  const o = {};
  for (let i = 0; i < arr.length; i += 2) o[arr[i]] = arr[i + 1];
  return o;
}

export async function getBans() {
  const ids = (await firestoreCommand(["SMEMBERS", "bans:set"])) || [];
  const list = await Promise.all(ids.map(async (id) => {
    const info = await getBanInfo(id);
    return info ? { ...info, chatId: id } : null;
  }));
  return list.filter(Boolean).sort((a, b) => Number(b.bannedAt) - Number(a.bannedAt));
}
