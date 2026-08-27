import { db } from '../db/index.js';

export const attendanceRepository = {
  findBySession(sessionId) {
    return db.prepare('SELECT * FROM attendance_records WHERE session_id = ?').all(sessionId);
  },

  findBySessionAndTeacher(sessionId, teacherId) {
    return db
      .prepare(
        `SELECT ar.* FROM attendance_records ar JOIN class_sessions cs ON cs.id = ar.session_id
         WHERE ar.session_id = ? AND cs.teacher_id = ?`
      )
      .all(sessionId, teacherId);
  },

  findByDate(schoolId, date) {
    return db
      .prepare(
        `SELECT ar.* FROM attendance_records ar JOIN class_sessions cs ON cs.id = ar.session_id
         WHERE ar.school_id = ? AND cs.session_date = ?`
      )
      .all(schoolId, date);
  },

  findByDateAndTeacher(schoolId, date, teacherId) {
    return db
      .prepare(
        `SELECT ar.* FROM attendance_records ar JOIN class_sessions cs ON cs.id = ar.session_id
         WHERE ar.school_id = ? AND cs.session_date = ? AND cs.teacher_id = ?`
      )
      .all(schoolId, date, teacherId);
  },

  findOne(sessionId, personType, personId) {
    return db
      .prepare('SELECT * FROM attendance_records WHERE session_id = ? AND person_type = ? AND person_id = ?')
      .get(sessionId, personType, personId);
  },

  create({ id, schoolId, sessionId, personType, personId, status, makeupArranged, note }) {
    db.prepare(
      `INSERT INTO attendance_records (id, school_id, session_id, person_type, person_id, status, makeup_arranged, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, schoolId, sessionId, personType, personId, status, makeupArranged ? 1 : 0, note);
  },

  update(id, { status, makeupArranged, makeupSessionId, note }) {
    db.prepare(
      `UPDATE attendance_records SET status=?, makeup_arranged=?, makeup_session_id=?, note=?, recorded_at=datetime('now')
       WHERE id = ?`
    ).run(status, makeupArranged ? 1 : 0, makeupSessionId, note, id);
  },

  delete(id) {
    db.prepare('DELETE FROM attendance_records WHERE id = ?').run(id);
  },
};
