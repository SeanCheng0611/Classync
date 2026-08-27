import { db } from '../db/index.js';

// 只涵蓋 teachers 資料表本身的存取；課堂/薪資相關查詢屬於 scheduling / finance domain，留在原本檔案
export const teachersRepository = {
  findAllBySchool(schoolId) {
    return db.prepare('SELECT * FROM teachers WHERE school_id = ?').all(schoolId);
  },

  findAllBySchoolAndId(schoolId, teacherId) {
    return db.prepare('SELECT * FROM teachers WHERE school_id = ? AND id = ?').all(schoolId, teacherId || '');
  },

  findById(schoolId, id) {
    return db.prepare('SELECT * FROM teachers WHERE school_id = ? AND id = ?').get(schoolId, id);
  },

  findByName(schoolId, name, excludeId = null) {
    if (excludeId) {
      return db.prepare('SELECT id FROM teachers WHERE school_id = ? AND name = ? AND id != ?').get(schoolId, name, excludeId);
    }
    return db.prepare('SELECT id FROM teachers WHERE school_id = ? AND name = ?').get(schoolId, name);
  },

  create({ id, schoolId, name, subjects, rateGrade1to6, rateGrade7to9, rateGrade10to12, rateAdmin, note, flexibleSchedule }) {
    db.prepare(
      `INSERT INTO teachers (id, school_id, name, subjects, rate_grade_1_6, rate_grade_7_9, rate_grade_10_12, rate_admin, note, flexible_schedule)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, schoolId, name, JSON.stringify(subjects), rateGrade1to6, rateGrade7to9, rateGrade10to12, rateAdmin, note, JSON.stringify(flexibleSchedule));
  },

  update(id, { name, subjects, rateGrade1to6, rateGrade7to9, rateGrade10to12, rateAdmin, note, status, flexibleSchedule }) {
    db.prepare(
      `UPDATE teachers SET name=?, subjects=?, rate_grade_1_6=?, rate_grade_7_9=?, rate_grade_10_12=?, rate_admin=?, note=?, status=?, flexible_schedule=?, updated_at=datetime('now')
       WHERE id = ?`
    ).run(name, JSON.stringify(subjects), rateGrade1to6, rateGrade7to9, rateGrade10to12, rateAdmin, note, status, JSON.stringify(flexibleSchedule), id);
  },

  updateFlexibleSchedule(id, flexibleSchedule) {
    db.prepare(`UPDATE teachers SET flexible_schedule = ?, updated_at = datetime('now') WHERE id = ?`).run(
      JSON.stringify(flexibleSchedule),
      id
    );
  },

  delete(schoolId, id) {
    db.prepare('DELETE FROM teachers WHERE school_id = ? AND id = ?').run(schoolId, id);
  },
};
