import { nanoid } from 'nanoid';
import { usersRepository } from '../repositories/index.js';

// LINE 登入/dev 登入共用：依 line_user_id 找到既有帳號就更新顯示資訊，否則建立新帳號
// （系統第一位登入者自動成為最高權限者 is_owner，這是既有行為，不是本次新增）
export function upsertLineUser({ line_user_id, display_name, picture_url }) {
  const existing = usersRepository.findByLineUserId(line_user_id);
  if (existing) {
    usersRepository.updateProfile(existing.id, { displayName: display_name, pictureUrl: picture_url });
    return existing.id;
  }
  const id = nanoid();
  const isOwner = usersRepository.count() === 0;
  usersRepository.create({ id, lineUserId: line_user_id, displayName: display_name, pictureUrl: picture_url, isOwner });
  return id;
}
