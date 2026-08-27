import { db } from '../db/index.js';

// 只涵蓋 students 資料表本身的存取；課堂/出缺勤/學費相關查詢屬於 scheduling / finance domain，留在原本檔案
export const studentsRepository = {
  findAllBySchool(schoolId) {
    return db.prepare('SELECT * FROM students WHERE school_id = ?').all(schoolId);
  },

  findAllBySchoolAndTeacher(schoolId, teacherId) {
    return db.prepare('SELECT * FROM students WHERE school_id = ? AND teacher_id = ?').all(schoolId, teacherId || '');
  },

  findById(schoolId, id) {
    return db.prepare('SELECT * FROM students WHERE school_id = ? AND id = ?').get(schoolId, id);
  },

  findByName(schoolId, name, excludeId = null) {
    if (excludeId) {
      return db.prepare('SELECT id FROM students WHERE school_id = ? AND name = ? AND id != ?').get(schoolId, name, excludeId);
    }
    return db.prepare('SELECT id FROM students WHERE school_id = ? AND name = ?').get(schoolId, name);
  },

  create({ id, schoolId, name, grade, schoolName, subjects, teacherId, tuitionMonthly, note, status }) {
    db.prepare(
      `INSERT INTO students (id, school_id, name, grade, school_name, subjects, teacher_id, tuition_monthly, note, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, schoolId, name, grade, schoolName, JSON.stringify(subjects), teacherId, tuitionMonthly, note, status);
  },

  update(id, { name, grade, schoolName, subjects, teacherId, tuitionMonthly, note, status }) {
    db.prepare(
      `UPDATE students SET name=?, grade=?, school_name=?, subjects=?, teacher_id=?, tuition_monthly=?, note=?, status=?, updated_at=datetime('now')
       WHERE id = ?`
    ).run(name, grade, schoolName, JSON.stringify(subjects), teacherId, tuitionMonthly, note, status, id);
  },

  delete(schoolId, id) {
    db.prepare('DELETE FROM students WHERE school_id = ? AND id = ?').run(schoolId, id);
  },
};
