import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
export const SESSION_COOKIE = 'cram_session';

export function signSession(userId) {
  return jwt.sign({ sub: userId }, SECRET, { expiresIn: '30d' });
}

export function verifySession(token) {
  try {
    const payload = jwt.verify(token, SECRET);
    return payload.sub;
  } catch {
    return null;
  }
}

export function setSessionCookie(res, userId) {
  res.cookie(SESSION_COOKIE, signSession(userId), {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE);
}
