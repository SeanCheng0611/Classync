import { db } from '../db/index.js';

// 目前只涵蓋 auth/middleware.js 與其他 domain 需要的最小讀取集合；
// LINE 登入/dev 登入的 upsert 邏輯留在 routes/auth.js，之後處理 auth domain 時再一併搬進來
export const usersRepository = {
  findById(id) {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  },

  findDisplayNameById(id) {
    const row = db.prepare('SELECT display_name FROM users WHERE id = ?').get(id);
    return row?.display_name || null;
  },
};
