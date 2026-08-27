import { Router } from 'express';
import { nanoid } from 'nanoid';
import { db } from '../db/index.js';
import { requireAuth } from '../auth/middleware.js';
import { SESSION_COOKIE, verifySession, setSessionCookie, clearSessionCookie } from '../auth/session.js';
import { clearAdminSessionCookie } from '../auth/adminSession.js';
import { logEvent } from '../services/auditLog.service.js';
import { PAGE_KEYS } from '../constants/pageKeys.js';

export const authRouter = Router();

const STATE_COOKIE = 'line_oauth_state';
const RETURN_COOKIE = 'line_oauth_return';
const REDIRECT_COOKIE = 'line_oauth_redirect';

function allowedOrigins() {
  return (process.env.CLIENT_URL || 'http://localhost:5173').split(',').map((s) => s.trim()).filter(Boolean);
}

function upsertLineUser({ line_user_id, display_name, picture_url }) {
  const existing = db.prepare('SELECT * FROM users WHERE line_user_id = ?').get(line_user_id);
  if (existing) {
    db.prepare('UPDATE users SET display_name = ?, picture_url = ? WHERE id = ?').run(
      display_name,
      picture_url,
      existing.id
    );
    return existing.id;
  }
  const id = nanoid();
  const { count } = db.prepare('SELECT COUNT(*) as count FROM users').get();
  const isOwner = count === 0 ? 1 : 0; // 系統第一位登入者自動成為最高權限者
  db.prepare(
    'INSERT INTO users (id, line_user_id, display_name, picture_url, is_owner) VALUES (?, ?, ?, ?, ?)'
  ).run(id, line_user_id, display_name, picture_url, isOwner);
  return id;
}

// --- LINE Login ---
authRouter.get('/line/login', (req, res) => {
  if (!process.env.LINE_CHANNEL_ID) {
    return res.status(500).json({ error: 'LINE_CHANNEL_ID 尚未設定，請先在 server/.env 填入 LINE Login channel 資訊，或使用 DEV_LOGIN' });
  }
  const state = nanoid();
  res.cookie(STATE_COOKIE, state, { httpOnly: true, sameSite: 'lax', maxAge: 5 * 60 * 1000 });

  // 記住使用者是從哪個網址發起登入（localhost 或區網 IP），callback 完成後導回同一個
  const referer = req.get('Referer');
  const origins = allowedOrigins();
  const returnOrigin = (referer && origins.find((o) => referer.startsWith(o))) || origins[0];
  res.cookie(RETURN_COOKIE, returnOrigin, { httpOnly: true, sameSite: 'lax', maxAge: 5 * 60 * 1000 });

  // redirect_uri 依這次請求實際打到的位址（localhost 或區網 IP）動態決定，兩者都需先在 LINE Console 註冊
  const redirectUri = `${req.protocol}://${req.get('host')}/auth/line/callback`;
  res.cookie(REDIRECT_COOKIE, redirectUri, { httpOnly: true, sameSite: 'lax', maxAge: 5 * 60 * 1000 });

  const url = new URL('https://access.line.me/oauth2/v2.1/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', process.env.LINE_CHANNEL_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('scope', 'profile openid');
  res.redirect(url.toString());
});

authRouter.get('/line/callback', async (req, res) => {
  const { code, state } = req.query;
  const savedState = req.cookies?.[STATE_COOKIE];
  if (!code || !state || state !== savedState) {
    return res.status(400).send('無效的登入狀態，請重新登入');
  }
  res.clearCookie(STATE_COOKIE);
  const redirectUri = req.cookies?.[REDIRECT_COOKIE];
  res.clearCookie(REDIRECT_COOKIE);
  if (!redirectUri) return res.status(400).send('登入逾時，請重新登入');

  try {
    const tokenRes = await fetch('https://api.line.me/oauth2/v2.1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: process.env.LINE_CHANNEL_ID,
        client_secret: process.env.LINE_CHANNEL_SECRET,
      }),
    });
    if (!tokenRes.ok) throw new Error(`token exchange failed: ${await tokenRes.text()}`);
    const { access_token } = await tokenRes.json();

    const profileRes = await fetch('https://api.line.me/v2/profile', {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    if (!profileRes.ok) throw new Error(`profile fetch failed: ${await profileRes.text()}`);
    const profile = await profileRes.json();

    const userId = upsertLineUser({
      line_user_id: profile.userId,
      display_name: profile.displayName,
      picture_url: profile.pictureUrl,
    });

    setSessionCookie(res, userId);
    logEvent({ category: 'AUTH', pageKey: PAGE_KEYS.AUTH, action: 'login.line', message: 'LINE 登入成功', userId });
    const returnOrigin = req.cookies?.[RETURN_COOKIE] || allowedOrigins()[0];
    res.clearCookie(RETURN_COOKIE);
    res.redirect(returnOrigin);
  } catch (err) {
    console.error(err);
    res.status(500).send('LINE 登入失敗，請稍後再試');
  }
});

// --- Dev login (只在 DEV_LOGIN=true 時可用，供尚未申請 LINE channel 前本機測試) ---
authRouter.post('/dev/login', (req, res) => {
  if (process.env.DEV_LOGIN !== 'true') {
    return res.status(403).json({ error: 'dev login disabled' });
  }
  const { display_name } = req.body;
  if (!display_name) return res.status(400).json({ error: 'display_name required' });

  const fakeLineId = `dev:${display_name}`;
  const userId = upsertLineUser({
    line_user_id: fakeLineId,
    display_name,
    picture_url: null,
  });
  setSessionCookie(res, userId);
  logEvent({ category: 'AUTH', pageKey: PAGE_KEYS.AUTH, action: 'login.dev', message: '開發用假登入', userId });
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, (req, res) => {
  const memberships = db
    .prepare(
      `SELECT m.school_id, m.role, m.teacher_id, s.name as school_name
       FROM memberships m JOIN schools s ON s.id = m.school_id
       WHERE m.user_id = ?`
    )
    .all(req.user.id);

  res.json({
    user: {
      id: req.user.id,
      display_name: req.user.display_name,
      picture_url: req.user.picture_url,
      is_owner: !!req.user.is_owner,
    },
    memberships,
  });
});

authRouter.post('/logout', (req, res) => {
  // logout 不強制要求已登入（沿用原本行為，未登入呼叫也回 200），但如果能辨識出使用者就順便記一筆、
  // 並清掉 admin mode（一般使用者登出時，管理者模式一併失效，見 docs/ADMIN_MODE.md）
  const token = req.cookies?.[SESSION_COOKIE];
  const userId = token && verifySession(token);
  if (userId) logEvent({ category: 'AUTH', pageKey: PAGE_KEYS.AUTH, action: 'logout', message: '登出', userId });

  clearSessionCookie(res);
  clearAdminSessionCookie(res);
  res.json({ ok: true });
});
