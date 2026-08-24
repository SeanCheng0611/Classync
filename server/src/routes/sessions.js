import { Router } from 'express';
import { nanoid } from 'nanoid';
import { db } from '../db/index.js';
import { requireMembership } from '../auth/middleware.js';
import { broadcastChange } from '../realtime/index.js';
import { ensureSessionsForDate, serializeSession } from '../services/sessions.js';
import {
  findTeacherSessionConflict,
  findStudentSessionConflict,
  checkGroupSizeLimit,
  subtractBusyRanges,
  findTeacherTeachingRangesOnDate,
} from '../services/conflicts.js';
import { slotRangeLabel } from '../services/timeLabels.js';
import { addToTrash, captureSession } from '../services/trash.js';

export const sessionsRouter = Router({ mergeParams: true });
sessionsRouter.use(requireMembership());

// 檢查教師與每位學生在該日期/時段是否已有其他課堂重疊，回傳第一個衝突的錯誤訊息（無衝突則回傳 null）
function checkSessionConflicts(schoolId, { teacherId, studentIds, date, startSlot, durationSlots, excludeSessionId }) {
  const teacherConflict = findTeacherSessionConflict(schoolId, teacherId, date, startSlot, durationSlots, excludeSessionId);
  if (teacherConflict) {
    const teacher = db.prepare('SELECT name FROM teachers WHERE id = ?').get(teacherId);
    return `教師「${teacher?.name || ''}」${date} ${slotRangeLabel(startSlot, durationSlots)} 已有其他課堂（${teacherConflict.subject}），時段重疊`;
  }
  for (const studentId of studentIds || []) {
    const conflict = findStudentSessionConflict(schoolId, studentId, date, startSlot, durationSlots, excludeSessionId);
    if (conflict) {
      const student = db.prepare('SELECT name FROM students WHERE id = ?').get(studentId);
      return `學生「${student?.name || ''}」${date} ${slotRangeLabel(startSlot, durationSlots)} 已有其他課堂（${conflict.subject}），時段重疊`;
    }
  }
  return null;
}

// 相容兩種輸入格式：students: [{student_id, unit_price}] 或舊版 student_ids: [id]
function normalizeStudents(body) {
  if (Array.isArray(body.students)) return body.students;
  if (Array.isArray(body.student_ids)) return body.student_ids.map((id) => ({ student_id: id, unit_price: 0 }));
  return [];
}

sessionsRouter.get('/', (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date query param required (YYYY-MM-DD)' });

  ensureSessionsForDate(req.params.schoolId, date);

  const rows =
    req.membership.role !== 'teacher'
      ? db
          .prepare(
            'SELECT * FROM class_sessions WHERE school_id = ? AND session_date = ? AND cancelled = 0 ORDER BY start_slot'
          )
          .all(req.params.schoolId, date)
      : db
          .prepare(
            'SELECT * FROM class_sessions WHERE school_id = ? AND session_date = ? AND teacher_id = ? AND cancelled = 0 ORDER BY start_slot'
          )
          .all(req.params.schoolId, date, req.membership.teacher_id || '');
  res.json(rows.map(serializeSession));
});

// 建立調課(makeup)或加課(extra)：固定課(regular)由樣板自動展開，不透過此端點手動建立
sessionsRouter.post('/', requireMembership(['admin', 'front_desk']), (req, res) => {
  const {
    teacher_id,
    subject,
    session_date,
    start_slot,
    duration_slots,
    type,
    origin_session_id,
    note,
    rate_override,
  } = req.body;
  const students = normalizeStudents(req.body);

  if (!teacher_id || !subject || !session_date || start_slot === undefined) {
    return res.status(400).json({ error: 'teacher_id, subject, session_date, start_slot required' });
  }
  if (!['makeup', 'extra'].includes(type)) {
    return res.status(400).json({ error: "type must be 'makeup' or 'extra'" });
  }

  const capacityMsg = checkGroupSizeLimit(req.params.schoolId, students.length);
  if (capacityMsg) return res.status(400).json({ error: capacityMsg });

  const requestedDuration = duration_slots || 2;
  let segments = [[start_slot, start_slot + requestedDuration]];
  let autoAdjusted = false;

  // 行政時段（無學生）新增時，自動避開該教師當天已經有學生的課堂時段，不需要手動閃開
  if (students.length === 0) {
    const busy = findTeacherTeachingRangesOnDate(req.params.schoolId, teacher_id, session_date);
    const free = subtractBusyRanges(start_slot, start_slot + requestedDuration, busy);
    if (free.length === 0) {
      return res.status(409).json({ error: '教師該時段已被課堂佔滿，無法新增行政時段' });
    }
    if (free.length !== 1 || free[0][0] !== start_slot || free[0][1] !== start_slot + requestedDuration) {
      autoAdjusted = true;
    }
    segments = free;
  }

  for (const [segStart, segEnd] of segments) {
    const conflictMsg = checkSessionConflicts(req.params.schoolId, {
      teacherId: teacher_id,
      studentIds: students.map((s) => s.student_id),
      date: session_date,
      startSlot: segStart,
      durationSlots: segEnd - segStart,
    });
    if (conflictMsg) return res.status(409).json({ error: conflictMsg });
  }

  const insertStudent = db.prepare(
    'INSERT INTO session_students (session_id, student_id, unit_price) VALUES (?, ?, ?)'
  );
  const createdIds = [];
  for (const [segStart, segEnd] of segments) {
    const id = nanoid();
    db.prepare(
      `INSERT INTO class_sessions (id, school_id, teacher_id, subject, session_date, start_slot, duration_slots, type, origin_session_id, note, rate_override)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      req.params.schoolId,
      teacher_id,
      subject,
      session_date,
      segStart,
      segEnd - segStart,
      type,
      origin_session_id || null,
      note || null,
      rate_override != null ? Number(rate_override) : null
    );
    for (const { student_id, unit_price } of students) insertStudent.run(id, student_id, unit_price || 0);
    createdIds.push(id);
  }

  if (origin_session_id && students.length > 0) {
    const studentIds = students.map((s) => s.student_id);
    db.prepare(
      `UPDATE attendance_records SET makeup_arranged = 1, makeup_session_id = ?
       WHERE session_id = ? AND person_type = 'student' AND person_id IN (${studentIds.map(() => '?').join(',')})`
    ).run(createdIds[0], origin_session_id, ...studentIds);
  }

  broadcastChange(req.params.schoolId, 'sessions');
  res.status(201).json({
    sessions: createdIds.map((sid) => serializeSession(db.prepare('SELECT * FROM class_sessions WHERE id = ?').get(sid))),
    auto_adjusted: autoAdjusted,
  });
});

sessionsRouter.put('/:id', requireMembership(['admin', 'front_desk']), (req, res) => {
  const existing = db
    .prepare('SELECT * FROM class_sessions WHERE school_id = ? AND id = ?')
    .get(req.params.schoolId, req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  const {
    teacher_id = existing.teacher_id,
    subject = existing.subject,
    session_date = existing.session_date,
    start_slot = existing.start_slot,
    duration_slots = existing.duration_slots,
    note = existing.note,
    rate_override = existing.rate_override,
  } = req.body;

  const studentsProvided = req.body.students !== undefined || req.body.student_ids !== undefined;
  const students = studentsProvided ? normalizeStudents(req.body) : null;
  const studentIds = studentsProvided
    ? students.map((s) => s.student_id)
    : db.prepare('SELECT student_id FROM session_students WHERE session_id = ?').all(req.params.id).map((r) => r.student_id);

  const capacityMsg = checkGroupSizeLimit(req.params.schoolId, studentIds.length);
  if (capacityMsg) return res.status(400).json({ error: capacityMsg });

  const conflictMsg = checkSessionConflicts(req.params.schoolId, {
    teacherId: teacher_id,
    studentIds,
    date: session_date,
    startSlot: start_slot,
    durationSlots: duration_slots,
    excludeSessionId: req.params.id,
  });
  if (conflictMsg) return res.status(409).json({ error: conflictMsg });

  db.prepare(
    `UPDATE class_sessions SET teacher_id=?, subject=?, session_date=?, start_slot=?, duration_slots=?, note=?, rate_override=?
     WHERE id = ?`
  ).run(teacher_id, subject, session_date, start_slot, duration_slots, note, rate_override != null ? Number(rate_override) : null, req.params.id);

  if (studentsProvided) {
    db.prepare('DELETE FROM session_students WHERE session_id = ?').run(req.params.id);
    const insert = db.prepare(
      'INSERT INTO session_students (session_id, student_id, unit_price) VALUES (?, ?, ?)'
    );
    for (const { student_id, unit_price } of students) insert.run(req.params.id, student_id, unit_price || 0);
  }

  broadcastChange(req.params.schoolId, 'sessions');
  res.json(serializeSession(db.prepare('SELECT * FROM class_sessions WHERE id = ?').get(req.params.id)));
});

// regular（固定課展開的單日）用軟刪除（cancelled=1），避免懶生成時被樣板重新展開回來；
// makeup/extra 本來就沒有樣板可展開，直接硬刪除即可
// 刪除優先級：已請假/已調課的課堂不能直接刪除（需先取消請假/取消調課）；已被調往較晚時段的課堂也要先處理較晚的紀錄才能刪除較早的
sessionsRouter.delete('/:id', requireMembership(['admin', 'front_desk']), (req, res) => {
  const existing = db
    .prepare('SELECT * FROM class_sessions WHERE school_id = ? AND id = ?')
    .get(req.params.schoolId, req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  const hasLeave = db
    .prepare(`SELECT 1 FROM attendance_records WHERE session_id = ? AND status = 'leave'`)
    .get(req.params.id);
  if (hasLeave) {
    return res.status(400).json({ error: '此堂已請假或調課，請先取消請假/取消調課才能刪除' });
  }
  const hasDownstream = db
    .prepare('SELECT 1 FROM class_sessions WHERE origin_session_id = ? AND cancelled = 0')
    .get(req.params.id);
  if (hasDownstream) {
    return res.status(400).json({ error: '此堂已被調往較晚的時段，請先處理較晚的調課紀錄才能刪除' });
  }

  const teacher = db.prepare('SELECT name FROM teachers WHERE id = ?').get(existing.teacher_id);
  const label = `${existing.session_date} ${slotRangeLabel(existing.start_slot, existing.duration_slots)} ${existing.subject}（${teacher?.name || '未知教師'}）`;
  const studentIds = db.prepare('SELECT student_id FROM session_students WHERE session_id = ?').all(req.params.id).map((r) => r.student_id);
  const related = { studentIds, teacherId: existing.teacher_id };

  if (existing.type === 'regular') {
    addToTrash(req.params.schoolId, 'session_cancelled', label, { sessionId: req.params.id }, req.user.id, related);
    db.prepare('UPDATE class_sessions SET cancelled = 1 WHERE id = ?').run(req.params.id);
  } else {
    addToTrash(req.params.schoolId, 'session', label, captureSession(req.params.id), req.user.id, related);
    db.prepare('DELETE FROM class_sessions WHERE id = ?').run(req.params.id);
  }

  broadcastChange(req.params.schoolId, 'sessions');
  res.status(204).end();
});
