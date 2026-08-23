import { Router } from 'express';
import { nanoid } from 'nanoid';
import { db } from '../db/index.js';
import { requireAuth, requireOwner } from '../auth/middleware.js';
import { broadcastChange, broadcastForceReload } from '../realtime/index.js';

export const schoolsRouter = Router();
schoolsRouter.use(requireAuth);

function getMembership(userId, schoolId) {
  return db.prepare('SELECT * FROM memberships WHERE user_id = ? AND school_id = ?').get(userId, schoolId);
}

function genInviteCode() {
  return nanoid(8).toUpperCase();
}

// 建立新補習班：僅平台最高權限者（owner）可執行，一般使用者只能用邀請碼加入既有補習班
schoolsRouter.post('/', requireOwner, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  const schoolId = nanoid();
  const inviteCode = genInviteCode();
  const membershipId = nanoid();

  db.prepare('INSERT INTO schools (id, name, invite_code) VALUES (?, ?, ?)').run(
    schoolId,
    name,
    inviteCode
  );
  db.prepare(
    'INSERT INTO memberships (id, user_id, school_id, role) VALUES (?, ?, ?, ?)'
  ).run(membershipId, req.user.id, schoolId, 'admin');

  res.status(201).json({ id: schoolId, name, invite_code: inviteCode, role: 'admin' });
});

schoolsRouter.get('/mine', (req, res) => {
  const rows = db
    .prepare(
      `SELECT s.id, s.name, m.role
       FROM memberships m JOIN schools s ON s.id = m.school_id
       WHERE m.user_id = ?`
    )
    .all(req.user.id);
  res.json(rows);
});

// 管理者查看/更新邀請碼與補習班基本資料
schoolsRouter.get('/:schoolId', (req, res) => {
  const membership = db
    .prepare('SELECT * FROM memberships WHERE user_id = ? AND school_id = ?')
    .get(req.user.id, req.params.schoolId);
  if (!membership) return res.status(403).json({ error: 'not a member' });

  const school = db.prepare('SELECT * FROM schools WHERE id = ?').get(req.params.schoolId);
  if (!school) return res.status(404).json({ error: 'not found' });
  res.json({ ...school, role: membership.role });
});

// 學生單堂預設金額（依年級級距）：新增固定課程/單堂加課時的預設單價，僅管理者可調整
schoolsRouter.put('/:schoolId/tuition-defaults', (req, res) => {
  const membership = getMembership(req.user.id, req.params.schoolId);
  if (!membership || membership.role !== 'admin') return res.status(403).json({ error: 'admin only' });

  const school = db.prepare('SELECT * FROM schools WHERE id = ?').get(req.params.schoolId);
  if (!school) return res.status(404).json({ error: 'not found' });

  const {
    default_price_grade_1_6 = school.default_price_grade_1_6,
    default_price_grade_7_9 = school.default_price_grade_7_9,
    default_price_grade_10_12 = school.default_price_grade_10_12,
  } = req.body;

  db.prepare(
    `UPDATE schools SET default_price_grade_1_6 = ?, default_price_grade_7_9 = ?, default_price_grade_10_12 = ? WHERE id = ?`
  ).run(
    Number(default_price_grade_1_6) || 0,
    Number(default_price_grade_7_9) || 0,
    Number(default_price_grade_10_12) || 0,
    req.params.schoolId
  );

  broadcastChange(req.params.schoolId, 'tuition-defaults');
  res.json({ ...db.prepare('SELECT * FROM schools WHERE id = ?').get(req.params.schoolId), role: membership.role });
});

// 刪除整間補習班：僅平台最高權限者（owner）可執行，FK cascade 會一併清除其下所有資料
schoolsRouter.delete('/:schoolId', requireOwner, (req, res) => {
  const school = db.prepare('SELECT * FROM schools WHERE id = ?').get(req.params.schoolId);
  if (!school) return res.status(404).json({ error: 'not found' });

  db.prepare('DELETE FROM schools WHERE id = ?').run(req.params.schoolId);
  res.status(204).end();
});

// 成員列表：該補習班的 admin 可查看
schoolsRouter.get('/:schoolId/members', (req, res) => {
  const membership = getMembership(req.user.id, req.params.schoolId);
  if (!membership || membership.role !== 'admin') return res.status(403).json({ error: 'admin only' });

  const rows = db
    .prepare(
      `SELECT m.id, m.role, m.teacher_id, u.id as user_id, u.display_name, u.picture_url, u.is_owner
       FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.school_id = ?
       ORDER BY m.role, u.display_name`
    )
    .all(req.params.schoolId);
  res.json(rows);
});

// 將成員（教師角色）連結到對應的教師檔案，教師才能替自己的課點名；也可在此變更成員角色（管理者/教師）
schoolsRouter.put('/:schoolId/members/:membershipId', (req, res) => {
  const membership = getMembership(req.user.id, req.params.schoolId);
  if (!membership || membership.role !== 'admin') return res.status(403).json({ error: 'admin only' });

  const target = db
    .prepare(
      `SELECT m.*, u.is_owner as target_is_owner FROM memberships m
       JOIN users u ON u.id = m.user_id WHERE m.id = ? AND m.school_id = ?`
    )
    .get(req.params.membershipId, req.params.schoolId);
  if (!target) return res.status(404).json({ error: 'not found' });

  const { teacher_id, role } = req.body;

  // 角色調整規則：平台擁有者可調整任何人的權限；一般管理者只能調整「非管理者」（教師/櫃台）的權限，不能調整其他管理者
  // 沒有人（包含擁有者本人）可以調整自己或平台擁有者的權限
  if (role && role !== target.role) {
    if (!['admin', 'teacher', 'front_desk'].includes(role)) return res.status(400).json({ error: 'invalid role' });
    if (target.user_id === req.user.id) return res.status(403).json({ error: '無法調整自己的權限' });
    if (target.target_is_owner) return res.status(403).json({ error: '無法調整系統擁有者的權限' });
    if (!req.user.is_owner && target.role === 'admin') return res.status(403).json({ error: '無法調整管理者的權限' });
  }

  const nextRole = role || target.role;
  const nextTeacherId = nextRole !== 'teacher' ? null : teacher_id !== undefined ? teacher_id : target.teacher_id;
  if (nextTeacherId) {
    const teacher = db
      .prepare('SELECT * FROM teachers WHERE id = ? AND school_id = ?')
      .get(nextTeacherId, req.params.schoolId);
    if (!teacher) return res.status(400).json({ error: 'teacher not found in this school' });
  }

  db.prepare('UPDATE memberships SET teacher_id = ?, role = ? WHERE id = ?').run(
    nextTeacherId || null,
    nextRole,
    req.params.membershipId
  );

  broadcastChange(req.params.schoolId, 'members');
  if (role && role !== target.role) {
    broadcastForceReload(req.params.schoolId, target.user_id);
  }

  res.json(db.prepare('SELECT * FROM memberships WHERE id = ?').get(req.params.membershipId));
});

// 移除成員（踢出帳號）：該補習班的 admin 可執行，但不可移除最後一位 admin
schoolsRouter.delete('/:schoolId/members/:membershipId', (req, res) => {
  const membership = getMembership(req.user.id, req.params.schoolId);
  if (!membership || membership.role !== 'admin') return res.status(403).json({ error: 'admin only' });

  const target = db
    .prepare(
      `SELECT m.*, u.is_owner as target_is_owner FROM memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.id = ? AND m.school_id = ?`
    )
    .get(req.params.membershipId, req.params.schoolId);
  if (!target) return res.status(404).json({ error: 'not found' });
  if (target.target_is_owner) return res.status(403).json({ error: '無法移除系統擁有者' });

  if (target.role === 'admin') {
    const { count } = db
      .prepare("SELECT COUNT(*) as count FROM memberships WHERE school_id = ? AND role = 'admin'")
      .get(req.params.schoolId);
    if (count <= 1) return res.status(400).json({ error: '無法移除最後一位管理者' });
  }

  db.prepare('DELETE FROM memberships WHERE id = ?').run(req.params.membershipId);
  res.status(204).end();
});
