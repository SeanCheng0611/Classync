import { Router } from 'express';
import { db } from '../db/index.js';
import { requireAuth, requireOwner } from '../auth/middleware.js';

export const devRouter = Router();

function requireDevMode(req, res, next) {
  if (process.env.DEV_LOGIN !== 'true') return res.status(403).json({ error: 'dev mode disabled' });
  next();
}

// 開發用：一鍵清空所有補習班測試資料（帳號本身保留，不用重新登入）
// 僅平台最高權限者可執行，避免一般使用者不小心／惡意清空全站資料
devRouter.post('/reset', requireDevMode, requireAuth, requireOwner, (req, res) => {
  db.prepare('DELETE FROM schools').run(); // FK cascade 會清掉底下所有 memberships/students/teachers/...
  res.json({ ok: true });
});
