import { Router } from 'express';
import { nanoid, customAlphabet } from 'nanoid';
import { db } from '../db/index.js';
import { requireAuth, requireMembership } from '../auth/middleware.js';
import { addToTrash, captureInviteCode } from '../services/trash.js';

const genCode = customAlphabet('23456789ABCDEFGHJKLMNPQRSTUVWXYZ', 8);

// 掛在 /api/schools/:schoolId/invite-codes 之下：管理者產生/查看/撤銷一次性邀請碼
export const inviteCodesRouter = Router({ mergeParams: true });
inviteCodesRouter.use(requireMembership(['admin']));

inviteCodesRouter.get('/', (req, res) => {
  const rows = db
    .prepare(
      `SELECT ic.*, t.name as teacher_name FROM invite_codes ic
       LEFT JOIN teachers t ON t.id = ic.teacher_id
       WHERE ic.school_id = ? ORDER BY ic.created_at DESC`
    )
    .all(req.params.schoolId);
  res.json(rows);
});

inviteCodesRouter.post('/', (req, res) => {
  const { role, teacher_id } = req.body;
  if (!['admin', 'teacher', 'front_desk'].includes(role)) {
    return res.status(400).json({ error: "role must be 'admin', 'teacher', or 'front_desk'" });
  }
  if (role === 'teacher') {
    if (!teacher_id) return res.status(400).json({ error: 'teacher_id required when role is teacher' });
    const teacher = db
      .prepare('SELECT * FROM teachers WHERE id = ? AND school_id = ?')
      .get(teacher_id, req.params.schoolId);
    if (!teacher) return res.status(400).json({ error: 'teacher not found in this school' });
  }

  const id = nanoid();
  const code = genCode();
  db.prepare(
    `INSERT INTO invite_codes (id, school_id, code, role, teacher_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, req.params.schoolId, code, role, role === 'teacher' ? teacher_id : null, req.user.id);

  const row = db
    .prepare(
      `SELECT ic.*, t.name as teacher_name FROM invite_codes ic
       LEFT JOIN teachers t ON t.id = ic.teacher_id WHERE ic.id = ?`
    )
    .get(id);
  res.status(201).json(row);
});

inviteCodesRouter.delete('/:id', (req, res) => {
  const code = db
    .prepare('SELECT * FROM invite_codes WHERE id = ? AND school_id = ?')
    .get(req.params.id, req.params.schoolId);
  if (!code) return res.status(404).json({ error: 'not found' });
  if (code.used_at) return res.status(400).json({ error: '此邀請碼已被使用，無法撤銷' });

  const roleLabel = { admin: '管理者', teacher: '教師', front_desk: '櫃台' }[code.role] || code.role;
  addToTrash(req.params.schoolId, 'invite_code', `邀請碼 ${code.code}（${roleLabel}）`, captureInviteCode(req.params.id), req.user.id, {
    teacherId: code.teacher_id || null,
  });

  db.prepare('DELETE FROM invite_codes WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// 全域端點：使用者輸入一次性邀請碼兌換權限，不需事先知道補習班 id
export const redeemRouter = Router();
redeemRouter.use(requireAuth);

redeemRouter.post('/redeem', (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code required' });

  const invite = db.prepare('SELECT * FROM invite_codes WHERE code = ?').get(code.trim().toUpperCase());
  if (!invite) return res.status(404).json({ error: '邀請碼無效' });
  if (invite.used_at) return res.status(400).json({ error: '此邀請碼已被使用' });

  const school = db.prepare('SELECT * FROM schools WHERE id = ?').get(invite.school_id);
  if (!school) return res.status(404).json({ error: '補習班不存在' });

  const existing = db
    .prepare('SELECT * FROM memberships WHERE user_id = ? AND school_id = ?')
    .get(req.user.id, invite.school_id);

  if (existing) {
    db.prepare('UPDATE memberships SET role = ?, teacher_id = ? WHERE id = ?').run(
      invite.role,
      invite.teacher_id,
      existing.id
    );
  } else {
    db.prepare(
      'INSERT INTO memberships (id, user_id, school_id, role, teacher_id) VALUES (?, ?, ?, ?, ?)'
    ).run(nanoid(), req.user.id, invite.school_id, invite.role, invite.teacher_id);
  }

  db.prepare('UPDATE invite_codes SET used_at = datetime(\'now\'), used_by_user_id = ? WHERE id = ?').run(
    req.user.id,
    invite.id
  );

  res.status(201).json({ id: school.id, name: school.name, role: invite.role });
});
