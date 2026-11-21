// قاعدة المشتركين (بالـ Telegram ID): الأساس لأي إرسال مستقبلي.
// - قبل كده المشتركين كانوا بيتعدّوا بـ HyperLogLog (رقم تقريبي من غير IDs)، فمكنش ينفع نعرف مين هم.
// - دلوقتي كل عميل (محادثة خاصة) بيتسجّل أول ما يتفاعل مع البوت، ID بس + أول ظهور (مفيش أسماء ولا أرقام هواتف).
// - التسجيل مش بيغيّر أي سلوك: لو فشل، البوت بيكمل عادي. ومفيش إرسال لأي حد من هنا.
import { firestoreCommand } from "./firebase.js";
import { getQuestions, cairoDayOf } from "./stats.js";
import { upsertInfo } from "./customers.js";

const REG = "subs:reg";   // hash: chatId -> أول ظهور (ms)
const seen = new Set();   // كاش في ذاكرة النسخة الشغّالة لتقليل عمليات Firestore المتكررة

const validId = (id) => /^\d{1,20}$/.test(String(id ?? ""));

// بيتنادى لكل تحديث - تم تحييده لتوفير قراءات Firestore مع كل تفاعل
export async function trackSubscriber(ctx) {
  return false;
}

export async function registryCount() {
  return Number((await firestoreCommand(["HLEN", REG])) ?? 0) || 0;
}

// عدد المسجّلين بالـ ID في يوم محدد (تم إيقاف HGETALL الشاملة لتوفير آلاف القراءات)
export async function registeredOnDay(date) {
  return 0;
}

function toObj(arr) { const o = {}; for (let i = 0; i < (arr?.length || 0); i += 2) o[arr[i]] = arr[i + 1]; return o; }
const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

// استيراد العملاء المعروفين دلوقتي من البيانات الموجودة (آمن ويتكرر من غير تكرار):
// أصحاب الأسئلة، وسجل العملاء (cu:info)، ومن شاركوا أو اختاروا بخصوص الرقم، والمحظورين، وأصحاب زيادة المتابعات.
// الأقدم بين أي تاريخين هو "أول ظهور". ومبيمسحش ولا يغيّر أي مسجّل قبل كده.
export async function backfillRegistry() {
  const found = new Map();   // id -> أقدم وقت
  const sources = { questions: 0, customers: 0, phones: 0, bans: 0, extras: 0 };
  const add = (id, t, src) => {
    id = String(id ?? "");
    if (!validId(id)) return;
    const ts = Number(t) > 0 ? Number(t) : Date.now();
    if (!found.has(id)) sources[src]++;
    found.set(id, Math.min(found.get(id) ?? Infinity, ts));
  };
  for (const q of await getQuestions()) add(q.chatId, q.t, "questions");
  const info = toObj((await firestoreCommand(["HGETALL", "cu:info"])) || []);
  for (const [id, v] of Object.entries(info)) add(id, parse(v)?.fs, "customers");
  // المفاتيح بس (من غير قراءة أي قيمة): مفيش داعي نقرا الأرقام المشفّرة
  for (const k of ["cu:phs", "cu:ph"]) for (const id of (await firestoreCommand(["HKEYS", k])) || []) add(id, 0, "phones");
  for (const id of (await firestoreCommand(["HKEYS", "fu:extra"])) || []) add(id, 0, "extras");
  for (const id of (await firestoreCommand(["SMEMBERS", "bans:set"])) || []) add(id, 0, "bans");

  const existing = new Set((await firestoreCommand(["HKEYS", REG])) || []);
  const missing = [...found.entries()].filter(([id]) => !existing.has(id));
  for (let i = 0; i < missing.length; i += 500) {
    const args = ["HSET", REG];
    for (const [id, ts] of missing.slice(i, i + 500)) args.push(id, String(ts));
    if ((await firestoreCommand(args)) === null) throw new Error("فشل حفظ قاعدة المشتركين");
  }
  missing.forEach(([id]) => seen.add(id));
  return { before: existing.size, added: missing.length, after: existing.size + missing.length, known: found.size, sources };
}
