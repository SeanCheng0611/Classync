import { Router } from 'express';
import { nanoid } from 'nanoid';
import { db } from '../db/index.js';
import { requireMembership } from '../auth/middleware.js';
import { broadcastChange } from '../realtime/index.js';
import { findTeacherTemplateConflict, findStudentTemplateConflict } from '../services/conflicts.js';
import { WEEKDAY_LABELS, slotRangeLabel } from '../services/timeLabels.js';

export const scheduleTemplatesRouter = Router({ mergeParams: true });
scheduleTemplatesRouter.use(requireMembership());

// 檢查教師與每位學生在該星期/時段、且生效區間重疊時是否已有其他固定課衝突，回傳第一個衝突的錯誤訊息（無衝突則回傳 null）
function checkTemplateConflicts(
  schoolId,
  { teacherId, studentIds, weekday, startSlot, durationSlots, excludeTemplateId, activeFrom, activeUntil }
) {
  const teacherConflict = findTeacherTemplateConflict(
    schoolId, teacherId, weekday, startSlot, durationSlots, excludeTemplateId, activeFrom, activeUntil
  );
  if (teacherConflict) {
    const teacher = db.prepare('SELECT name FROM teachers WHERE id = ?').get(teacherId);
    return `教師「${teacher?.name || ''}」星期${WEEKDAY_LABELS[weekday]} ${slotRangeLabel(startSlot, durationSlots)} 已有其他固定課（${teacherConflict.subject}），時段重疊`;
  }
  for (const studentId of studentIds || []) {
    const conflict = findStudentTemplateConflict(
      schoolId, studentId, weekday, startSlot, durationSlots, excludeTemplateId, activeFrom, activeUntil
    );
    if (conflict) {
      const student = db.prepare('SELECT name FROM students WHERE id = ?').get(studentId);
      return `學生「${student?.name || ''}」星期${WEEKDAY_LABELS[weekday]} ${slotRangeLabel(startSlot, durationSlots)} 已有其他固定課（${conflict.subject}），時段重疊`;
    }
  }
  return null;
}

function withStudents(row) {
  const students = db
    .prepare('SELECT student_id, unit_price FROM template_students WHERE template_id = ?')
    .all(row.id);
  return { ...row, students, student_ids: students.map((s) => s.student_id) };
}

// 相容兩種輸入格式：students: [{student_id, unit_price}] 或舊版 student_ids: [id]
function normalizeStudents(body) {
  if (Array.isArray(body.students)) return body.students;
  if (Array.isArray(body.student_ids)) return body.student_ids.map((id) => ({ student_id: id, unit_price: 0 }));
  return undefined;
}

function setStudents(templateId, students) {
  db.prepare('DELETE FROM template_students WHERE template_id = ?').run(templateId);
  const insert = db.prepare(
    'INSERT INTO template_students (template_id, student_id, unit_price) VALUES (?, ?, ?)'
  );
  for (const { student_id, unit_price } of students || []) insert.run(templateId, student_id, unit_price || 0);
}

// 教師只能查看自己任教的固定課（唯讀），管理者可查看全部
scheduleTemplatesRouter.get('/', (req, res) => {
  const rows =
    req.membership.role !== 'teacher'
      ? db
          .prepare('SELECT * FROM schedule_templates WHERE school_id = ? ORDER BY weekday, start_slot')
          .all(req.params.schoolId)
      : db
          .prepare(
            'SELECT * FROM schedule_templates WHERE school_id = ? AND teacher_id = ? ORDER BY weekday, start_slot'
          )
          .all(req.params.schoolId, req.membership.teacher_id || '');
  res.json(rows.map(withStudents));
});

scheduleTemplatesRouter.post('/', requireMembership(['admin', 'front_desk']), (req, res) => {
  const {
    teacher_id,
    subject,
    weekday,
    start_slot,
    duration_slots,
    active_from,
    active_until,
    note,
  } = req.body;

  if (!teacher_id || !subject || weekday === undefined || start_slot === undefined) {
    return res.status(400).json({ error: 'teacher_id, subject, weekday, start_slot required' });
  }

  const studentEntries = normalizeStudents(req.body) || [];
  const conflictMsg = checkTemplateConflicts(req.params.schoolId, {
    teacherId: teacher_id,
    studentIds: studentEntries.map((s) => s.student_id),
    weekday: Number(weekday),
    startSlot: start_slot,
    durationSlots: duration_slots || 2,
    activeFrom: active_from || new Date().toISOString().slice(0, 10),
    activeUntil: active_until || null,
  });
  if (conflictMsg) return res.status(409).json({ error: conflictMsg });

  const id = nanoid();
  db.prepare(
    `INSERT INTO schedule_templates (id, school_id, teacher_id, subject, weekday, start_slot, duration_slots, active_from, active_until, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, date('now')), ?, ?)`
  ).run(
    id,
    req.params.schoolId,
    teacher_id,
    subject,
    weekday,
    start_slot,
    duration_slots || 2,
    active_from || null,
    active_until || null,
    note || null
  );
  setStudents(id, normalizeStudents(req.body));

  broadcastChange(req.params.schoolId, 'schedule');
  res.status(201).json(withStudents(db.prepare('SELECT * FROM schedule_templates WHERE id = ?').get(id)));
});

scheduleTemplatesRouter.put('/:id', requireMembership(['admin', 'front_desk']), (req, res) => {
  const existing = db
    .prepare('SELECT * FROM schedule_templates WHERE school_id = ? AND id = ?')
    .get(req.params.schoolId, req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  const {
    teacher_id = existing.teacher_id,
    subject = existing.subject,
    weekday = existing.weekday,
    start_slot = existing.start_slot,
    duration_slots = existing.duration_slots,
    active_from = existing.active_from,
    active_until = existing.active_until,
    note = existing.note,
  } = req.body;

  const normalized = normalizeStudents(req.body);
  const studentIds = normalized !== undefined ? normalized.map((s) => s.student_id) : withStudents(existing).student_ids;
  const conflictMsg = checkTemplateConflicts(req.params.schoolId, {
    teacherId: teacher_id,
    studentIds,
    weekday: Number(weekday),
    startSlot: start_slot,
    durationSlots: duration_slots,
    excludeTemplateId: req.params.id,
    activeFrom: active_from,
    activeUntil: active_until,
  });
  if (conflictMsg) return res.status(409).json({ error: conflictMsg });

  db.prepare(
    `UPDATE schedule_templates SET teacher_id=?, subject=?, weekday=?, start_slot=?, duration_slots=?, active_from=?, active_until=?, note=?
     WHERE id = ?`
  ).run(teacher_id, subject, weekday, start_slot, duration_slots, active_from, active_until, note, req.params.id);

  if (req.body.active_until !== undefined && req.body.active_until) {
    // 縮短樣板有效期間時，把已展開但落在新結束日之後、尚未發生的課堂一併取消
    db.prepare(
      `UPDATE class_sessions SET cancelled = 1
       WHERE template_id = ? AND session_date > ? AND session_date >= date('now') AND cancelled = 0`
    ).run(req.params.id, req.body.active_until);
    broadcastChange(req.params.schoolId, 'sessions');
  }

  if (normalized !== undefined) {
    // 從樣板移除的學生，把「尚未發生」的已展開課堂也一併移除該生，避免課堂與出缺勤紀錄殘留失效的固定課
    const prevStudentIds = withStudents(existing).student_ids;
    const removedIds = prevStudentIds.filter((sid) => !studentIds.includes(sid));
    if (removedIds.length > 0) {
      const futureSessions = db
        .prepare(`SELECT id FROM class_sessions WHERE template_id = ? AND session_date >= date('now')`)
        .all(req.params.id);
      const delStudent = db.prepare('DELETE FROM session_students WHERE session_id = ? AND student_id = ?');
      for (const s of futureSessions) {
        for (const sid of removedIds) delStudent.run(s.id, sid);
      }
      broadcastChange(req.params.schoolId, 'sessions');
    }
    setStudents(req.params.id, normalized);
  }

  broadcastChange(req.params.schoolId, 'schedule');
  res.json(withStudents(db.prepare('SELECT * FROM schedule_templates WHERE id = ?').get(req.params.id)));
});

scheduleTemplatesRouter.delete('/:id', requireMembership(['admin', 'front_desk']), (req, res) => {
  const existing = db
    .prepare('SELECT * FROM schedule_templates WHERE school_id = ? AND id = ?')
    .get(req.params.schoolId, req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  // 停開整堂固定課：已展開但尚未發生的課堂一併取消，避免課堂與出缺勤紀錄殘留失效的固定課
  db.prepare(
    `UPDATE class_sessions SET cancelled = 1 WHERE template_id = ? AND session_date >= date('now') AND cancelled = 0`
  ).run(req.params.id);

  db.prepare('DELETE FROM schedule_templates WHERE school_id = ? AND id = ?').run(
    req.params.schoolId,
    req.params.id
  );
  broadcastChange(req.params.schoolId, 'schedule');
  broadcastChange(req.params.schoolId, 'sessions');
  res.status(204).end();
});
