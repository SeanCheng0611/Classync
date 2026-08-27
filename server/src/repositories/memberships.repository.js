import { db } from '../db/index.js';

export const membershipsRepository = {
  findByUserAndSchool(userId, schoolId) {
    return db.prepare('SELECT * FROM memberships WHERE user_id = ? AND school_id = ?').get(userId, schoolId);
  },

  // 該補習班的成員清單，附帶使用者顯示資訊，依角色/姓名排序
  findMembersWithUser(schoolId) {
    return db
      .prepare(
        `SELECT m.id, m.role, m.teacher_id, u.id as user_id, u.display_name, u.picture_url, u.is_owner
         FROM memberships m JOIN users u ON u.id = m.user_id
         WHERE m.school_id = ?
         ORDER BY m.role, u.display_name`
      )
      .all(schoolId);
  },

  // 成員異動（改角色/移除）時需要一併知道目標帳號是否為平台 owner，用來擋掉「不能調整 owner」的規則
  findByIdWithUser(membershipId, schoolId) {
    return db
      .prepare(
        `SELECT m.*, u.is_owner as target_is_owner FROM memberships m
         JOIN users u ON u.id = m.user_id WHERE m.id = ? AND m.school_id = ?`
      )
      .get(membershipId, schoolId);
  },

  create({ id, userId, schoolId, role, teacherId = null }) {
    db.prepare('INSERT INTO memberships (id, user_id, school_id, role, teacher_id) VALUES (?, ?, ?, ?, ?)').run(
      id,
      userId,
      schoolId,
      role,
      teacherId
    );
  },

  updateRoleAndTeacher(membershipId, { role, teacherId }) {
    db.prepare('UPDATE memberships SET teacher_id = ?, role = ? WHERE id = ?').run(teacherId || null, role, membershipId);
  },

  countAdmins(schoolId) {
    const row = db.prepare("SELECT COUNT(*) as count FROM memberships WHERE school_id = ? AND role = 'admin'").get(schoolId);
    return row.count;
  },

  findById(membershipId) {
    return db.prepare('SELECT * FROM memberships WHERE id = ?').get(membershipId);
  },

  delete(membershipId) {
    db.prepare('DELETE FROM memberships WHERE id = ?').run(membershipId);
  },
};
