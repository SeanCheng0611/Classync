import { Router } from 'express';
import { nanoid } from 'nanoid';
import { db } from '../db/index.js';
import { requireMembership } from '../auth/middleware.js';
import { broadcastChange } from '../realtime/index.js';
import {
  findTeacherTemplateConflict,
  findStudentTemplateConflict,
  checkGroupSizeLimit,
  subtractBusyRanges,
  findTeacherTeachingRangesOnWeekday,
} from '../services/conflicts.js';
import { WEEKDAY_LABELS, slotRangeLabel } from '../services/timeLabels.js';
import { addToTrash, captureScheduleTemplate } from '../services/trash.js';

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
    rate_override,
  } = req.body;

  if (!teacher_id || !subject || weekday === undefined || start_slot === undefined) {
    return res.status(400).json({ error: 'teacher_id, subject, weekday, start_slot required' });
  }

  const studentEntries = normalizeStudents(req.body) || [];
  const capacityMsg = checkGroupSizeLimit(req.params.schoolId, studentEntries.length);
  if (capacityMsg) return res.status(400).json({ error: capacityMsg });

  const weekdayNum = Number(weekday);
  const requestedDuration = duration_slots || 2;
  const activeFromVal = active_from || new Date().toISOString().slice(0, 10);
  const activeUntilVal = active_until || null;

  let segments = [[start_slot, start_slot + requestedDuration]];
  let autoAdjusted = false;

  // 固定行政時段（無學生）新增時，自動避開該教師同星期已經有學生的固定課時段，不需要手動閃開
  if (studentEntries.length === 0) {
    const busy = findTeacherTeachingRangesOnWeekday(req.params.schoolId, teacher_id, weekdayNum, activeFromVal, activeUntilVal);
    const free = subtractBusyRanges(start_slot, start_slot + requestedDuration, busy);
    if (free.length === 0) {
      return res.status(409).json({ error: `教師星期${WEEKDAY_LABELS[weekdayNum]}該時段已被固定課佔滿，無法新增行政時段` });
    }
    if (free.length !== 1 || free[0][0] !== start_slot || free[0][1] !== start_slot + requestedDuration) {
      autoAdjusted = true;
    }
    segments = free;
  }

  for (const [segStart, segEnd] of segments) {
    const conflictMsg = checkTemplateConflicts(req.params.schoolId, {
      teacherId: teacher_id,
      studentIds: studentEntries.map((s) => s.student_id),
      weekday: weekdayNum,
      startSlot: segStart,
      durationSlots: segEnd - segStart,
      activeFrom: activeFromVal,
      activeUntil: activeUntilVal,
    });
    if (conflictMsg) return res.status(409).json({ error: conflictMsg });
  }

  const createdIds = [];
  for (const [segStart, segEnd] of segments) {
    const id = nanoid();
    db.prepare(
      `INSERT INTO schedule_templates (id, school_id, teacher_id, subject, weekday, start_slot, duration_slots, active_from, active_until, note, rate_override)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      req.params.schoolId,
      teacher_id,
      subject,
      weekdayNum,
      segStart,
      segEnd - segStart,
      activeFromVal,
      activeUntilVal,
      note || null,
      rate_override != null ? Number(rate_override) : null
    );
    setStudents(id, studentEntries);
    createdIds.push(id);
  }

  broadcastChange(req.params.schoolId, 'schedule');
  res.status(201).json({
    templates: createdIds.map((tid) => withStudents(db.prepare('SELECT * FROM schedule_templates WHERE id = ?').get(tid))),
    auto_adjusted: autoAdjusted,
  });
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
    rate_override = existing.rate_override,
  } = req.body;

  const normalized = normalizeStudents(req.body);
  const studentIds = normalized !== undefined ? normalized.map((s) => s.student_id) : withStudents(existing).student_ids;
  const capacityMsg = checkGroupSizeLimit(req.params.schoolId, studentIds.length);
  if (capacityMsg) return res.status(400).json({ error: capacityMsg });

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

  const nextRateOverride = rate_override != null ? Number(rate_override) : null;
  db.prepare(
    `UPDATE schedule_templates SET teacher_id=?, subject=?, weekday=?, start_slot=?, duration_slots=?, active_from=?, active_until=?, note=?, rate_override=?
     WHERE id = ?`
  ).run(teacher_id, subject, weekday, start_slot, duration_slots, active_from, active_until, note, nextRateOverride, req.params.id);

  if (rate_override !== existing.rate_override) {
    // 樣板時薪覆寫值變動時，把已展開但尚未發生的課堂一併同步，避免舊課堂還沿用舊值
    db.prepare(
      `UPDATE class_sessions SET rate_override = ? WHERE template_id = ? AND session_date >= date('now')`
    ).run(nextRateOverride, req.params.id);
  }

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
  const toCancel = db
    .prepare(`SELECT id FROM class_sessions WHERE template_id = ? AND session_date >= date('now') AND cancelled = 0`)
    .all(req.params.id)
    .map((r) => r.id);
  db.prepare(
    `UPDATE class_sessions SET cancelled = 1 WHERE template_id = ? AND session_date >= date('now') AND cancelled = 0`
  ).run(req.params.id);

  const teacher = db.prepare('SELECT name FROM teachers WHERE id = ?').get(existing.teacher_id);
  const label = `${existing.subject} 星期${WEEKDAY_LABELS[existing.weekday]} ${slotRangeLabel(existing.start_slot, existing.duration_slots)}（${teacher?.name || '未知教師'}）`;
  const studentIds = db.prepare('SELECT student_id FROM template_students WHERE template_id = ?').all(req.params.id).map((r) => r.student_id);
  addToTrash(req.params.schoolId, 'schedule_template', label, captureScheduleTemplate(req.params.id, toCancel), req.user.id, {
    studentIds,
    teacherId: existing.teacher_id,
  });

  db.prepare('DELETE FROM schedule_templates WHERE school_id = ? AND id = ?').run(
    req.params.schoolId,
    req.params.id
  );
  broadcastChange(req.params.schoolId, 'schedule');
  broadcastChange(req.params.schoolId, 'sessions');
  res.status(204).end();
});
