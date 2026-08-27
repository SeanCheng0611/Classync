import { usersRepository, membershipsRepository } from '../repositories/index.js';
import { SESSION_COOKIE, verifySession } from './session.js';
import { ADMIN_SESSION_COOKIE, verifyAdminSession } from './adminSession.js';

export function requireAuth(req, res, next) {
  const token = req.cookies?.[SESSION_COOKIE];
  const userId = token && verifySession(token);
  if (!userId) return res.status(401).json({ error: 'not authenticated' });

  const user = usersRepository.findById(userId);
  if (!user) return res.status(401).json({ error: 'not authenticated' });

  req.user = user;
  next();
}

// 平台最高權限者：可跨補習班刪除整間補習班
export function requireOwner(req, res, next) {
  if (!req.user.is_owner) return res.status(403).json({ error: 'owner only' });
  next();
}

// 系統診斷/管理模式（不是 school membership 的 business role，見 docs/ADMIN_MODE.md）。
// 掛在所有 /api/admin/* 的敏感 endpoint 前面；只認獨立的 admin session cookie，
// 跟一般登入 session 分開驗證，過期或沒解鎖過就一律 403，不會因為 frontend 顯示了 Admin Page 就代表真的有權限。
export function requireSystemAdminMode(req, res, next) {
  const token = req.cookies?.[ADMIN_SESSION_COOKIE];
  const userId = token && verifyAdminSession(token);
  if (!userId || userId !== req.user?.id) {
    return res.status(403).json({ error: 'admin mode required' });
  }
  next();
}

// 掛在 /api/schools/:schoolId/... 之下，驗證使用者在該補習班有 membership
// 預設角色（未指定 roles 時）僅用於學生檔案/教師檔案/課表/點名/座位五項子系統，front_desk（櫃台）在此範圍內視同 admin
export function requireMembership(roles = ['admin', 'teacher', 'front_desk']) {
  return (req, res, next) => {
    const { schoolId } = req.params;
    const membership = membershipsRepository.findByUserAndSchool(req.user.id, schoolId);

    if (!membership) return res.status(403).json({ error: 'not a member of this school' });
    if (!roles.includes(membership.role)) return res.status(403).json({ error: 'insufficient role' });

    req.membership = membership;
    next();
  };
}
