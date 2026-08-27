import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

// 用 Node 內建 crypto 的 scrypt，不額外引入 bcrypt/argon2 依賴——scrypt 是成熟、被廣泛驗證的 KDF，
// 這裡只是呼叫標準函式庫實作，不是自製加密演算法。格式：`<saltHex>:<hashHex>`。
const KEY_LENGTH = 64;

const DEFAULT_TIMEZONE = 'Asia/Taipei';

// 密碼尾碼（MMDD）用明確指定的時區算，不依賴 Docker host / OS 的預設時區——host 時區設定錯誤或
// container 沒特別設定時區時常常是 UTC，會讓密碼尾碼跟台灣使用者認知的「今天」差一天。
// 用 Intl.DateTimeFormat 搭配 IANA 時區名稱是 Node 內建能力，不需要額外套件（例如 dayjs/luxon）。
// 接受可選的 `date` 參數（預設現在），方便單元測試獨立驗證這個函式，不用真的等到特定日期才能測。
export function todayMMDD(timezone = process.env.ADMIN_MODE_TIMEZONE || DEFAULT_TIMEZONE, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, month: '2-digit', day: '2-digit' }).formatToParts(date);
  const mm = parts.find((p) => p.type === 'month').value;
  const dd = parts.find((p) => p.type === 'day').value;
  return `${mm}${dd}`;
}

// 密碼格式驗證：先確認基本形狀合理（長度足夠、尾碼是 4 位數字）再進行 scrypt 運算，
// 避免對明顯不合法的輸入也做一次昂貴的雜湊計算。不合法回傳 null，呼叫端視同驗證失敗。
export function parseAdminPassword(password) {
  if (typeof password !== 'string' || password.length <= 4) return null;
  const dateCode = password.slice(-4);
  const prefix = password.slice(0, -4);
  if (!/^\d{4}$/.test(dateCode)) return null;
  if (!prefix) return null;
  return { prefix, dateCode };
}

export function hashAdminPassword(plainPassword) {
  const salt = randomBytes(16);
  const hash = scryptSync(plainPassword, salt, KEY_LENGTH);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyAdminPassword(plainPassword, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [saltHex, hashHex] = storedHash.split(':');
  try {
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = scryptSync(plainPassword, salt, expected.length);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// ---- 最小 brute-force protection（單一 process 記憶體內，多 instance 部署時需要升級成共用狀態，見文件）----

const FAILURE_LIMIT = 5;
const COOLDOWN_MS = 5 * 60 * 1000; // 5 分鐘
const attempts = new Map(); // key -> { count, firstFailureAt, cooldownUntil }

// key 建議用「使用者 id」（已登入才能碰這個功能，比 IP 更穩定，同時避免退化成需要另外處理 IP 的邊界情況）
export function isRateLimited(key) {
  const entry = attempts.get(key);
  if (!entry) return false;
  if (entry.cooldownUntil && Date.now() < entry.cooldownUntil) return true;
  if (entry.cooldownUntil && Date.now() >= entry.cooldownUntil) {
    attempts.delete(key);
    return false;
  }
  return false;
}

export function recordFailedAttempt(key) {
  const entry = attempts.get(key) || { count: 0, firstFailureAt: Date.now() };
  entry.count += 1;
  if (entry.count >= FAILURE_LIMIT) {
    entry.cooldownUntil = Date.now() + COOLDOWN_MS;
  }
  attempts.set(key, entry);
}

export function clearFailedAttempts(key) {
  attempts.delete(key);
}

export function cooldownRemainingMs(key) {
  const entry = attempts.get(key);
  if (!entry?.cooldownUntil) return 0;
  return Math.max(entry.cooldownUntil - Date.now(), 0);
}
