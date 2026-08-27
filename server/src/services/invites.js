import { nanoid } from 'nanoid';
import { inviteCodesRepository, membershipsRepository, schoolsRepository, runInTransaction } from '../repositories/index.js';

export class InviteError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// 兌換邀請碼：加入/更新該補習班的 membership，並把邀請碼標記為已使用；兩個寫入必須同時成功或同時失敗，
// 否則會出現「membership 已建立但邀請碼還能被重複使用」或「邀請碼已標記用掉但使用者其實沒加入」的不一致
export function redeemInviteCode(userId, code) {
  if (!code) throw new InviteError(400, 'code required');

  const invite = inviteCodesRepository.findByCode(code.trim().toUpperCase());
  if (!invite) throw new InviteError(404, '邀請碼無效');
  if (invite.used_at) throw new InviteError(400, '此邀請碼已被使用');

  const school = schoolsRepository.findById(invite.school_id);
  if (!school) throw new InviteError(404, '補習班不存在');

  const existing = membershipsRepository.findByUserAndSchool(userId, invite.school_id);

  runInTransaction(() => {
    if (existing) {
      membershipsRepository.updateRoleAndTeacher(existing.id, { role: invite.role, teacherId: invite.teacher_id });
    } else {
      membershipsRepository.create({ id: nanoid(), userId, schoolId: invite.school_id, role: invite.role, teacherId: invite.teacher_id });
    }
    inviteCodesRepository.markUsed(invite.id, userId);
  });

  return { id: school.id, name: school.name, role: invite.role };
}
