import { db } from '../db/index.js';

export const usersRepository = {
  findById(id) {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  },

  findDisplayNameById(id) {
    const row = db.prepare('SELECT display_name FROM users WHERE id = ?').get(id);
    return row?.display_name || null;
  },

  findByLineUserId(lineUserId) {
    return db.prepare('SELECT * FROM users WHERE line_user_id = ?').get(lineUserId);
  },

  count() {
    return db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  },

  create({ id, lineUserId, displayName, pictureUrl, isOwner }) {
    db.prepare(
      'INSERT INTO users (id, line_user_id, display_name, picture_url, is_owner) VALUES (?, ?, ?, ?, ?)'
    ).run(id, lineUserId, displayName, pictureUrl, isOwner ? 1 : 0);
  },

  updateProfile(id, { displayName, pictureUrl }) {
    db.prepare('UPDATE users SET display_name = ?, picture_url = ? WHERE id = ?').run(displayName, pictureUrl, id);
  },
};
