import { db } from '../db/index.js';
import { SESSION_COOKIE, verifySession } from './session.js';

export function requireAuth(req, res, next) {
  const token = req.cookies?.[SESSION_COOKIE];
  const userId = token && verifySession(token);
  if (!userId) return res.status(401).json({ error: 'not authenticated' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(401).json({ error: 'not authenticated' });

  req.user = user;
  next();
}

// 平台最高權限者：可跨補習班刪除整間補習班
export function requireOwner(req, res, next) {
  if (!req.user.is_owner) return res.status(403).json({ error: 'owner only' });
  next();
}

// 掛在 /api/schools/:schoolId/... 之下，驗證使用者在該補習班有 membership
// 預設角色（未指定 roles 時）僅用於學生檔案/教師檔案/課表/點名/座位五項子系統，front_desk（櫃台）在此範圍內視同 admin
export function requireMembership(roles = ['admin', 'teacher', 'front_desk']) {
  return (req, res, next) => {
    const { schoolId } = req.params;
    const membership = db
      .prepare('SELECT * FROM memberships WHERE user_id = ? AND school_id = ?')
      .get(req.user.id, schoolId);

    if (!membership) return res.status(403).json({ error: 'not a member of this school' });
    if (!roles.includes(membership.role)) return res.status(403).json({ error: 'insufficient role' });

    req.membership = membership;
    next();
  };
}
