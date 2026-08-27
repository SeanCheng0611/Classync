import { Router } from 'express';
import { requireAuth, requireSystemAdminMode } from '../auth/middleware.js';
import {
  setAdminSessionCookie,
  clearAdminSessionCookie,
  verifyAdminSession,
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_MINUTES_VALUE,
} from '../auth/adminSession.js';
import {
  verifyAdminPassword,
  parseAdminPassword,
  todayMMDD,
  isRateLimited,
  recordFailedAttempt,
  clearFailedAttempts,
  cooldownRemainingMs,
} from '../auth/adminPassword.js';
import { logEvent, findLogs } from '../services/auditLog.service.js';
import { PAGE_KEY_VALUES } from '../constants/pageKeys.js';

export const adminRouter = Router();
adminRouter.use(requireAuth);

// 是否已經解鎖過（給前端 refresh 後判斷要不要恢復 Admin Mode UI 用）。這裡用跟
// requireSystemAdminMode 完全一樣的驗證邏輯，只是不擋 request、只回報結果——實際保護敏感資料的
// 還是每個 /api/admin/* 敏感 endpoint 各自掛的 requireSystemAdminMode，不是靠前端信任這個回應。
adminRouter.get('/status', (req, res) => {
  const token = req.cookies?.[ADMIN_SESSION_COOKIE];
  const userId = token && verifyAdminSession(token);
  res.json({ unlocked: !!userId && userId === req.user.id });
});

adminRouter.post('/unlock', (req, res) => {
  const { password } = req.body;
  const rateLimitKey = req.user.id;

  if (isRateLimited(rateLimitKey)) {
    const remainingMs = cooldownRemainingMs(rateLimitKey);
    logEvent({
      level: 'WARN',
      category: 'SECURITY',
      pageKey: 'settings',
      action: 'admin.unlock.rate_limited',
      message: '管理者模式解鎖嘗試次數過多，暫時鎖定',
      userId: req.user.id,
    });
    return res.status(429).json({ error: '嘗試次數過多，請稍後再試', retry_after_ms: remainingMs });
  }

  const expectedHash = process.env.ADMIN_MODE_PASSWORD_HASH;
  if (!expectedHash) {
    return res.status(500).json({ error: 'ADMIN_MODE_PASSWORD_HASH 尚未設定，管理者模式無法使用' });
  }
  // 密碼是「固定前綴 + 當天日期（MMDD）」，每天自動變動：只有前綴被雜湊儲存，
  // 日期尾碼一律用 server 自己的時鐘（明確指定 ADMIN_MODE_TIMEZONE，預設 Asia/Taipei）算，
  // 不信任任何 client 提供的日期，避免被操控成任何一天都能用。
  const parsed = parseAdminPassword(password);
  const suffixOk = !!parsed && parsed.dateCode === todayMMDD();
  const prefixOk = !!parsed && verifyAdminPassword(parsed.prefix, expectedHash);
  if (!parsed || !suffixOk || !prefixOk) {
    recordFailedAttempt(rateLimitKey);
    // 絕對不記錄提交的密碼本身，只記錄「這件事發生了」
    logEvent({
      level: 'WARN',
      category: 'SECURITY',
      pageKey: 'settings',
      action: 'admin.unlock.failed',
      message: '管理者模式解鎖失敗',
      userId: req.user.id,
    });
    return res.status(401).json({ error: '密碼錯誤' });
  }

  clearFailedAttempts(rateLimitKey);
  setAdminSessionCookie(res, req.user.id);
  logEvent({
    level: 'INFO',
    category: 'SECURITY',
    pageKey: 'settings',
    action: 'admin.unlock.success',
    message: '管理者模式解鎖成功',
    userId: req.user.id,
  });
  res.json({ ok: true, expires_in_minutes: ADMIN_SESSION_MINUTES_VALUE });
});

adminRouter.post('/lock', (req, res) => {
  clearAdminSessionCookie(res);
  logEvent({
    level: 'INFO',
    category: 'SECURITY',
    pageKey: 'settings',
    action: 'admin.lock',
    message: '離開管理者模式',
    userId: req.user.id,
  });
  res.json({ ok: true });
});

adminRouter.get('/logs', requireSystemAdminMode, (req, res) => {
  const { log_type, page_key, level, category, user_id, school_id, keyword, start_time, end_time, limit, offset } = req.query;
  if (page_key && !PAGE_KEY_VALUES.includes(page_key)) {
    return res.status(400).json({ error: `unknown page_key: ${page_key}` });
  }
  const result = findLogs({
    logType: log_type,
    pageKey: page_key,
    level,
    category,
    userId: user_id,
    schoolId: school_id,
    keyword,
    startTime: start_time,
    endTime: end_time,
    limit,
    offset,
  });
  res.json(result);
});
