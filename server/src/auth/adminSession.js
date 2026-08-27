import jwt from 'jsonwebtoken';

// 獨立於一般登入 session（見 auth/session.js）的短效 JWT，代表「系統診斷/管理模式」這個 capability，
// 刻意不跟 school membership 的 role（owner/admin/teacher/front_desk）混在一起——見
// docs/ADMIN_MODE.md「Admin Mode 不是 Business Role」。用同一把 JWT_SECRET 簽，因為都是這個
// 系統自己簽發、自己驗證的 token，沒有必要另外管理一把 secret。
const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
export const ADMIN_SESSION_COOKIE = 'cram_admin_session';
const ADMIN_SESSION_MINUTES = Number(process.env.ADMIN_MODE_SESSION_MINUTES) || 45;

export function signAdminSession(userId) {
  return jwt.sign({ sub: userId, adminMode: true }, SECRET, { expiresIn: `${ADMIN_SESSION_MINUTES}m` });
}

// 回傳 userId（有效）或 null（無效/過期/被竄改），並確認 payload 真的帶有 adminMode 標記，
// 避免萬一哪天 signSession 的 payload 格式被沿用混淆，這裡永遠明確檢查這個 token 是不是為了 admin mode 簽的
export function verifyAdminSession(token) {
  try {
    const payload = jwt.verify(token, SECRET);
    if (!payload.adminMode) return null;
    return payload.sub;
  } catch {
    return null;
  }
}

export function setAdminSessionCookie(res, userId) {
  res.cookie(ADMIN_SESSION_COOKIE, signAdminSession(userId), {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: ADMIN_SESSION_MINUTES * 60 * 1000,
  });
}

export function clearAdminSessionCookie(res) {
  res.clearCookie(ADMIN_SESSION_COOKIE);
}

export const ADMIN_SESSION_MINUTES_VALUE = ADMIN_SESSION_MINUTES;
