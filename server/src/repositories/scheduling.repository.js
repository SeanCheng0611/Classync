import { db, runInTransaction } from '../db/index.js';

// schedule_templates / template_students / class_sessions / session_students 高度耦合
// （樣板展開成課堂、課堂帶學生關聯都橫跨這四張表），集中在同一個 repository，不強行拆開。
//
// Transaction 慣例：單一 row 的簡單寫入直接執行；牽涉多張表、必須 all-or-nothing 的操作
// （建立樣板+學生、建立課堂+學生、刪除樣板+取消未來課堂等）由這個 repository 自己的方法內部
// 呼叫 runInTransaction 包起來，呼叫端（route/service）只需要呼叫單一方法，不需要、也不應該
// 自己再包一層 transaction（node:sqlite 不支援巢狀 BEGIN）。
export const schedulingRepository = {
  // ---- schedule_templates ----

  findTemplatesBySchool(schoolId) {
    return db.prepare('SELECT * FROM schedule_templates WHERE school_id = ? ORDER BY weekday, start_slot').all(schoolId);
  },

  findTemplatesBySchoolAndTeacher(schoolId, teacherId) {
    return db
      .prepare('SELECT * FROM schedule_templates WHERE school_id = ? AND teacher_id = ? ORDER BY weekday, start_slot')
      .all(schoolId, teacherId || '');
  },

  findTemplateById(schoolId, id) {
    return db.prepare('SELECT * FROM schedule_templates WHERE school_id = ? AND id = ?').get(schoolId, id);
  },

  // 該星期、生效區間涵蓋這天的樣板（懶生成展開 session 用）
  findTemplatesActiveOnDate(schoolId, weekday, dateStr) {
    return db
      .prepare(
        `SELECT * FROM schedule_templates
         WHERE school_id = ? AND weekday = ?
           AND active_from <= ?
           AND (active_until IS NULL OR active_until >= ?)`
      )
      .all(schoolId, weekday, dateStr, dateStr);
  },

  // 同星期、排除自己，給教師固定課衝堂檢查用的候選清單，實際時段重疊判斷留在 service
  findTemplatesByTeacherAndWeekday(schoolId, teacherId, weekday, excludeTemplateId) {
    return db
      .prepare('SELECT * FROM schedule_templates WHERE school_id = ? AND teacher_id = ? AND weekday = ? AND id != ?')
      .all(schoolId, teacherId, weekday, excludeTemplateId || '');
  },

  // 同星期、該學生有排的固定課，排除自己，給學生固定課衝堂檢查用的候選清單
  findTemplatesByStudentAndWeekday(schoolId, studentId, weekday, excludeTemplateId) {
    return db
      .prepare(
        `SELECT st.* FROM schedule_templates st JOIN template_students ts ON ts.template_id = st.id
         WHERE st.school_id = ? AND ts.student_id = ? AND st.weekday = ? AND st.id != ?`
      )
      .all(schoolId, studentId, weekday, excludeTemplateId || '');
  },

  // 教師在該星期、已經有學生的固定課樣板時段（用於新增固定行政時段時自動避開）
  findTemplatesWithStudentsByTeacherAndWeekday(schoolId, teacherId, weekday) {
    return db
      .prepare(
        `SELECT st.* FROM schedule_templates st
         WHERE st.school_id = ? AND st.teacher_id = ? AND st.weekday = ?
         AND EXISTS (SELECT 1 FROM template_students ts WHERE ts.template_id = st.id)`
      )
      .all(schoolId, teacherId, weekday);
  },

  // 建立樣板 + 設定學生名單（atomic）
  createTemplate({ id, schoolId, teacherId, subject, weekday, startSlot, durationSlots, activeFrom, activeUntil, note, rateOverride, students }) {
    runInTransaction(() => {
      db.prepare(
        `INSERT INTO schedule_templates (id, school_id, teacher_id, subject, weekday, start_slot, duration_slots, active_from, active_until, note, rate_override)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, schoolId, teacherId, subject, weekday, startSlot, durationSlots, activeFrom, activeUntil, note, rateOverride);
      setTemplateStudents(id, students);
    });
  },

  // 更新樣板：欄位本身 + （選擇性）薪資覆寫同步到未來課堂 + （選擇性）縮短生效期取消未來課堂
  // + （選擇性）取代學生名單並把移除的學生從未來課堂關聯中拿掉。整組視為一個 business operation，atomic。
  // 呼叫端負責判斷「要不要做」（rate 是否真的變了、active_until 是否真的縮短、哪些學生被移除、要不要
  // broadcast），這裡只負責照著描述原子性地執行寫入。
  updateTemplate(id, { fields, syncRateOverride, cancelSessionsAfterDate, students, removedStudentIds }) {
    runInTransaction(() => {
      db.prepare(
        `UPDATE schedule_templates SET teacher_id=?, subject=?, weekday=?, start_slot=?, duration_slots=?, active_from=?, active_until=?, note=?, rate_override=?
         WHERE id = ?`
      ).run(
        fields.teacherId, fields.subject, fields.weekday, fields.startSlot, fields.durationSlots,
        fields.activeFrom, fields.activeUntil, fields.note, fields.rateOverride, id
      );

      if (syncRateOverride !== undefined) {
        db.prepare(`UPDATE class_sessions SET rate_override = ? WHERE template_id = ? AND session_date >= date('now')`).run(syncRateOverride, id);
      }

      if (cancelSessionsAfterDate) {
        db.prepare(
          `UPDATE class_sessions SET cancelled = 1
           WHERE template_id = ? AND session_date > ? AND session_date >= date('now') AND cancelled = 0`
        ).run(id, cancelSessionsAfterDate);
      }

      if (removedStudentIds && removedStudentIds.length > 0) {
        const futureSessionIds = db
          .prepare(`SELECT id FROM class_sessions WHERE template_id = ? AND session_date >= date('now')`)
          .all(id)
          .map((r) => r.id);
        const del = db.prepare('DELETE FROM session_students WHERE session_id = ? AND student_id = ?');
        for (const sessionId of futureSessionIds) {
          for (const studentId of removedStudentIds) del.run(sessionId, studentId);
        }
      }

      if (students !== undefined) setTemplateStudents(id, students);
    });
  },

  // 取消樣板所有未來已展開的課堂，atomic（SELECT + UPDATE 一起做），回傳被取消的 session id 清單。
  // 注意：呼叫端刪除整堂固定課時，要先呼叫這個、再呼叫 addToTrash（此時 template 列還在，
  // captureScheduleTemplate 才讀得到資料）、最後才呼叫 deleteTemplate，順序不能顛倒。
  cancelFutureSessionsByTemplate(id) {
    let cancelledSessionIds = [];
    runInTransaction(() => {
      cancelledSessionIds = db
        .prepare(`SELECT id FROM class_sessions WHERE template_id = ? AND session_date >= date('now') AND cancelled = 0`)
        .all(id)
        .map((r) => r.id);
      db.prepare(`UPDATE class_sessions SET cancelled = 1 WHERE template_id = ? AND session_date >= date('now') AND cancelled = 0`).run(id);
    });
    return cancelledSessionIds;
  },

  deleteTemplate(schoolId, id) {
    db.prepare('DELETE FROM schedule_templates WHERE school_id = ? AND id = ?').run(schoolId, id);
  },

  // ---- template_students ----

  findTemplateStudents(templateId) {
    return db.prepare('SELECT student_id, unit_price FROM template_students WHERE template_id = ?').all(templateId);
  },

  // ---- class_sessions ----

  findSessionById(schoolId, id) {
    return db.prepare('SELECT * FROM class_sessions WHERE school_id = ? AND id = ?').get(schoolId, id);
  },

  findSessionByIdAny(id) {
    return db.prepare('SELECT * FROM class_sessions WHERE id = ?').get(id);
  },

  findSessionsByDate(schoolId, date) {
    return db
      .prepare('SELECT * FROM class_sessions WHERE school_id = ? AND session_date = ? AND cancelled = 0 ORDER BY start_slot')
      .all(schoolId, date);
  },

  findSessionsByDateAndTeacher(schoolId, date, teacherId) {
    return db
      .prepare(
        'SELECT * FROM class_sessions WHERE school_id = ? AND session_date = ? AND teacher_id = ? AND cancelled = 0 ORDER BY start_slot'
      )
      .all(schoolId, date, teacherId || '');
  },

  findSessionByTemplateAndDate(templateId, date) {
    return db.prepare('SELECT id FROM class_sessions WHERE template_id = ? AND session_date = ?').get(templateId, date);
  },

  // 教師當天候選課堂（同一天，排除自己），實際時段重疊判斷留在 service
  findSessionsByTeacherAndDate(schoolId, teacherId, date, excludeSessionId) {
    return db
      .prepare('SELECT * FROM class_sessions WHERE school_id = ? AND teacher_id = ? AND session_date = ? AND cancelled = 0 AND id != ?')
      .all(schoolId, teacherId, date, excludeSessionId || '');
  },

  // 學生當天候選課堂（排除已請假的，因為請假視為該時段對這位學生是空的）
  findSessionsByStudentAndDateExcludingLeave(schoolId, studentId, date, excludeSessionId) {
    return db
      .prepare(
        `SELECT cs.* FROM class_sessions cs JOIN session_students ss ON ss.session_id = cs.id
         WHERE cs.school_id = ? AND ss.student_id = ? AND cs.session_date = ? AND cs.cancelled = 0 AND cs.id != ?
         AND NOT EXISTS (
           SELECT 1 FROM attendance_records ar
           WHERE ar.session_id = cs.id AND ar.person_type = 'student' AND ar.person_id = ? AND ar.status = 'leave'
         )`
      )
      .all(schoolId, studentId, date, excludeSessionId || '', studentId);
  },

  // 教師當天已經有學生的課堂時段（用於新增行政時段時自動避開）
  findSessionsWithStudentsByTeacherAndDate(schoolId, teacherId, date) {
    return db
      .prepare(
        `SELECT cs.* FROM class_sessions cs
         WHERE cs.school_id = ? AND cs.teacher_id = ? AND cs.session_date = ? AND cs.cancelled = 0
         AND EXISTS (SELECT 1 FROM session_students ss WHERE ss.session_id = cs.id)`
      )
      .all(schoolId, teacherId, date);
  },

  findDownstreamSession(originSessionId) {
    return db.prepare('SELECT 1 FROM class_sessions WHERE origin_session_id = ? AND cancelled = 0').get(originSessionId);
  },

  hasLeaveRecord(sessionId) {
    return !!db.prepare(`SELECT 1 FROM attendance_records WHERE session_id = ? AND status = 'leave'`).get(sessionId);
  },

  // 建立課堂（regular 展開用，單筆）+ 從樣板複製學生關聯，atomic
  createSessionFromTemplate({ id, schoolId, templateId, teacherId, subject, sessionDate, startSlot, durationSlots, rateOverride }) {
    runInTransaction(() => {
      db.prepare(
        `INSERT INTO class_sessions (id, school_id, template_id, teacher_id, subject, session_date, start_slot, duration_slots, type, rate_override)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'regular', ?)`
      ).run(id, schoolId, templateId, teacherId, subject, sessionDate, startSlot, durationSlots, rateOverride ?? null);
      const students = db.prepare('SELECT student_id, unit_price FROM template_students WHERE template_id = ?').all(templateId);
      const insert = db.prepare('INSERT INTO session_students (session_id, student_id, unit_price) VALUES (?, ?, ?)');
      for (const { student_id, unit_price } of students) insert.run(id, student_id, unit_price);
    });
  },

  // 建立 makeup/extra 課堂（可能多段）+ 學生關聯 + （選擇性）連結原本請假紀錄的調課，整組 atomic
  createSessions(sessions, { linkMakeupToAttendance } = {}) {
    const createdIds = [];
    runInTransaction(() => {
      const insertSession = db.prepare(
        `INSERT INTO class_sessions (id, school_id, teacher_id, subject, session_date, start_slot, duration_slots, type, origin_session_id, note, rate_override)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const insertStudent = db.prepare('INSERT INTO session_students (session_id, student_id, unit_price) VALUES (?, ?, ?)');
      for (const s of sessions) {
        insertSession.run(
          s.id, s.schoolId, s.teacherId, s.subject, s.sessionDate, s.startSlot, s.durationSlots,
          s.type, s.originSessionId, s.note, s.rateOverride
        );
        for (const { student_id, unit_price } of s.students || []) insertStudent.run(s.id, student_id, unit_price || 0);
        createdIds.push(s.id);
      }

      if (linkMakeupToAttendance) {
        const { originSessionId, studentIds, makeupSessionId } = linkMakeupToAttendance;
        db.prepare(
          `UPDATE attendance_records SET makeup_arranged = 1, makeup_session_id = ?
           WHERE session_id = ? AND person_type = 'student' AND person_id IN (${studentIds.map(() => '?').join(',')})`
        ).run(makeupSessionId, originSessionId, ...studentIds);
      }
    });
    return createdIds;
  },

  // 更新課堂欄位 + （選擇性）取代學生名單，整組 atomic
  updateSession(id, fields, students) {
    runInTransaction(() => {
      db.prepare(
        `UPDATE class_sessions SET teacher_id=?, subject=?, session_date=?, start_slot=?, duration_slots=?, note=?, rate_override=?
         WHERE id = ?`
      ).run(fields.teacherId, fields.subject, fields.sessionDate, fields.startSlot, fields.durationSlots, fields.note, fields.rateOverride, id);
      if (students !== null) {
        db.prepare('DELETE FROM session_students WHERE session_id = ?').run(id);
        const insert = db.prepare('INSERT INTO session_students (session_id, student_id, unit_price) VALUES (?, ?, ?)');
        for (const { student_id, unit_price } of students) insert.run(id, student_id, unit_price || 0);
      }
    });
  },

  cancelSession(id) {
    db.prepare('UPDATE class_sessions SET cancelled = 1 WHERE id = ?').run(id);
  },

  deleteSession(id) {
    db.prepare('DELETE FROM class_sessions WHERE id = ?').run(id);
  },

  // ---- session_students ----

  findSessionStudentIds(sessionId) {
    return db.prepare('SELECT student_id FROM session_students WHERE session_id = ?').all(sessionId).map((r) => r.student_id);
  },

  findSessionStudentsWithNames(sessionId) {
    return db
      .prepare(`SELECT s.id, s.name, ss.unit_price FROM session_students ss JOIN students s ON s.id = ss.student_id WHERE ss.session_id = ?`)
      .all(sessionId);
  },
};

function setTemplateStudents(templateId, students) {
  db.prepare('DELETE FROM template_students WHERE template_id = ?').run(templateId);
  const insert = db.prepare('INSERT INTO template_students (template_id, student_id, unit_price) VALUES (?, ?, ?)');
  for (const { student_id, unit_price } of students || []) insert.run(templateId, student_id, unit_price || 0);
}
