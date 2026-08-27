import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

// 用 Node 內建 crypto 的 scrypt，不額外引入 bcrypt/argon2 依賴——scrypt 是成熟、被廣泛驗證的 KDF，
// 這裡只是呼叫標準函式庫實作，不是自製加密演算法。格式：`<saltHex>:<hashHex>`。
const KEY_LENGTH = 64;

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
