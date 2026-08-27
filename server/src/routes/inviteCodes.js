import { Router } from 'express';
import { nanoid, customAlphabet } from 'nanoid';
import { inviteCodesRepository, teachersRepository } from '../repositories/index.js';
import { requireAuth, requireMembership } from '../auth/middleware.js';
import { addToTrash, captureInviteCode } from '../services/trash.js';
import { redeemInviteCode, InviteError } from '../services/invites.js';

const genCode = customAlphabet('23456789ABCDEFGHJKLMNPQRSTUVWXYZ', 8);

// 掛在 /api/schools/:schoolId/invite-codes 之下：管理者產生/查看/撤銷一次性邀請碼
export const inviteCodesRouter = Router({ mergeParams: true });
inviteCodesRouter.use(requireMembership(['admin']));

inviteCodesRouter.get('/', (req, res) => {
  res.json(inviteCodesRepository.findAllBySchool(req.params.schoolId));
});

inviteCodesRouter.post('/', (req, res) => {
  const { role, teacher_id } = req.body;
  if (!['admin', 'teacher', 'front_desk'].includes(role)) {
    return res.status(400).json({ error: "role must be 'admin', 'teacher', or 'front_desk'" });
  }
  if (role === 'teacher') {
    if (!teacher_id) return res.status(400).json({ error: 'teacher_id required when role is teacher' });
    const teacher = teachersRepository.findById(req.params.schoolId, teacher_id);
    if (!teacher) return res.status(400).json({ error: 'teacher not found in this school' });
  }

  const id = nanoid();
  const code = genCode();
  inviteCodesRepository.create({
    id,
    schoolId: req.params.schoolId,
    code,
    role,
    teacherId: role === 'teacher' ? teacher_id : null,
    createdBy: req.user.id,
  });

  res.status(201).json(inviteCodesRepository.findByIdWithTeacherName(id));
});

inviteCodesRouter.delete('/:id', (req, res) => {
  const code = inviteCodesRepository.findById(req.params.schoolId, req.params.id);
  if (!code) return res.status(404).json({ error: 'not found' });
  if (code.used_at) return res.status(400).json({ error: '此邀請碼已被使用，無法撤銷' });

  const roleLabel = { admin: '管理者', teacher: '教師', front_desk: '櫃台' }[code.role] || code.role;
  addToTrash(req.params.schoolId, 'invite_code', `邀請碼 ${code.code}（${roleLabel}）`, captureInviteCode(req.params.id), req.user.id, {
    teacherId: code.teacher_id || null,
  });

  inviteCodesRepository.delete(req.params.id);
  res.status(204).end();
});

// 全域端點：使用者輸入一次性邀請碼兌換權限，不需事先知道補習班 id
export const redeemRouter = Router();
redeemRouter.use(requireAuth);

redeemRouter.post('/redeem', (req, res) => {
  try {
    const result = redeemInviteCode(req.user.id, req.body.code);
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof InviteError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});
