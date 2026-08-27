import { db } from '../db/index.js';

export const inviteCodesRepository = {
  findAllBySchool(schoolId) {
    return db
      .prepare(
        `SELECT ic.*, t.name as teacher_name FROM invite_codes ic
         LEFT JOIN teachers t ON t.id = ic.teacher_id
         WHERE ic.school_id = ? ORDER BY ic.created_at DESC`
      )
      .all(schoolId);
  },

  findById(schoolId, id) {
    return db.prepare('SELECT * FROM invite_codes WHERE id = ? AND school_id = ?').get(id, schoolId);
  },

  findByIdWithTeacherName(id) {
    return db
      .prepare(
        `SELECT ic.*, t.name as teacher_name FROM invite_codes ic
         LEFT JOIN teachers t ON t.id = ic.teacher_id WHERE ic.id = ?`
      )
      .get(id);
  },

  findByCode(code) {
    return db.prepare('SELECT * FROM invite_codes WHERE code = ?').get(code);
  },

  create({ id, schoolId, code, role, teacherId, createdBy }) {
    db.prepare(
      `INSERT INTO invite_codes (id, school_id, code, role, teacher_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, schoolId, code, role, teacherId || null, createdBy);
  },

  markUsed(id, userId) {
    db.prepare(`UPDATE invite_codes SET used_at = datetime('now'), used_by_user_id = ? WHERE id = ?`).run(userId, id);
  },

  delete(id) {
    db.prepare('DELETE FROM invite_codes WHERE id = ?').run(id);
  },
};
