import { Router } from 'express';
import { nanoid } from 'nanoid';
import { schedulingRepository, teachersRepository, studentsRepository } from '../repositories/index.js';
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
import { logEvent } from '../services/auditLog.service.js';
import { PAGE_KEYS } from '../constants/pageKeys.js';

export const sessionsRouter = Router({ mergeParams: true });
sessionsRouter.use(requireMembership());

// 檢查教師與每位學生在該日期/時段是否已有其他課堂重疊，回傳第一個衝突的錯誤訊息（無衝突則回傳 null）
function checkSessionConflicts(schoolId, { teacherId, studentIds, date, startSlot, durationSlots, excludeSessionId }) {
  const teacherConflict = findTeacherSessionConflict(schoolId, teacherId, date, startSlot, durationSlots, excludeSessionId);
  if (teacherConflict) {
    const teacher = teachersRepository.findById(schoolId, teacherId);
    return `教師「${teacher?.name || ''}」${date} ${slotRangeLabel(startSlot, durationSlots)} 已有其他課堂（${teacherConflict.subject}），時段重疊`;
  }
  for (const studentId of studentIds || []) {
    const conflict = findStudentSessionConflict(schoolId, studentId, date, startSlot, durationSlots, excludeSessionId);
    if (conflict) {
      const student = studentsRepository.findById(schoolId, studentId);
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
      ? schedulingRepository.findSessionsByDate(req.params.schoolId, date)
      : schedulingRepository.findSessionsByDateAndTeacher(req.params.schoolId, date, req.membership.teacher_id);
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

  const sessionsToCreate = segments.map(([segStart, segEnd]) => ({
    id: nanoid(),
    schoolId: req.params.schoolId,
    teacherId: teacher_id,
    subject,
    sessionDate: session_date,
    startSlot: segStart,
    durationSlots: segEnd - segStart,
    type,
    originSessionId: origin_session_id || null,
    note: note || null,
    rateOverride: rate_override != null ? Number(rate_override) : null,
    students,
  }));

  const linkMakeupToAttendance =
    origin_session_id && students.length > 0
      ? { originSessionId: origin_session_id, studentIds: students.map((s) => s.student_id), makeupSessionId: sessionsToCreate[0].id }
      : undefined;

  const createdIds = schedulingRepository.createSessions(sessionsToCreate, { linkMakeupToAttendance });

  broadcastChange(req.params.schoolId, 'sessions');
  logEvent({
    category: 'DATA_CHANGE', pageKey: PAGE_KEYS.SCHEDULE, action: `session.create.${type}`,
    message: `新增${type === 'makeup' ? '調課' : '加課'}「${subject}」`, userId: req.user.id, schoolId: req.params.schoolId,
    entityType: 'class_session', entityId: createdIds[0], metadata: { count: createdIds.length },
  });
  res.status(201).json({
    sessions: createdIds.map((sid) => serializeSession(schedulingRepository.findSessionByIdAny(sid))),
    auto_adjusted: autoAdjusted,
  });
});

sessionsRouter.put('/:id', requireMembership(['admin', 'front_desk']), (req, res) => {
  const existing = schedulingRepository.findSessionById(req.params.schoolId, req.params.id);
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
  const studentIds = studentsProvided ? students.map((s) => s.student_id) : schedulingRepository.findSessionStudentIds(req.params.id);

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

  schedulingRepository.updateSession(
    req.params.id,
    {
      teacherId: teacher_id,
      subject,
      sessionDate: session_date,
      startSlot: start_slot,
      durationSlots: duration_slots,
      note,
      rateOverride: rate_override != null ? Number(rate_override) : null,
    },
    studentsProvided ? students : null
  );

  broadcastChange(req.params.schoolId, 'sessions');
  logEvent({
    category: 'DATA_CHANGE', pageKey: PAGE_KEYS.SCHEDULE, action: 'session.update',
    message: `更新課堂「${subject}」`, userId: req.user.id, schoolId: req.params.schoolId,
    entityType: 'class_session', entityId: req.params.id,
  });
  res.json(serializeSession(schedulingRepository.findSessionByIdAny(req.params.id)));
});

// regular（固定課展開的單日）用軟刪除（cancelled=1），避免懶生成時被樣板重新展開回來；
// makeup/extra 本來就沒有樣板可展開，直接硬刪除即可
// 刪除優先級：已請假/已調課的課堂不能直接刪除（需先取消請假/取消調課）；已被調往較晚時段的課堂也要先處理較晚的紀錄才能刪除較早的
sessionsRouter.delete('/:id', requireMembership(['admin', 'front_desk']), (req, res) => {
  const existing = schedulingRepository.findSessionById(req.params.schoolId, req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  if (schedulingRepository.hasLeaveRecord(req.params.id)) {
    return res.status(400).json({ error: '此堂已請假或調課，請先取消請假/取消調課才能刪除' });
  }
  if (schedulingRepository.findDownstreamSession(req.params.id)) {
    return res.status(400).json({ error: '此堂已被調往較晚的時段，請先處理較晚的調課紀錄才能刪除' });
  }

  const teacher = teachersRepository.findById(req.params.schoolId, existing.teacher_id);
  const label = `${existing.session_date} ${slotRangeLabel(existing.start_slot, existing.duration_slots)} ${existing.subject}（${teacher?.name || '未知教師'}）`;
  const studentIds = schedulingRepository.findSessionStudentIds(req.params.id);
  const related = { studentIds, teacherId: existing.teacher_id };

  if (existing.type === 'regular') {
    addToTrash(req.params.schoolId, 'session_cancelled', label, { sessionId: req.params.id }, req.user.id, related);
    schedulingRepository.cancelSession(req.params.id);
  } else {
    addToTrash(req.params.schoolId, 'session', label, captureSession(req.params.id), req.user.id, related);
    schedulingRepository.deleteSession(req.params.id);
  }

  broadcastChange(req.params.schoolId, 'sessions');
  logEvent({
    category: 'DATA_CHANGE', pageKey: PAGE_KEYS.SCHEDULE, action: 'session.delete',
    message: `刪除課堂「${label}」`, userId: req.user.id, schoolId: req.params.schoolId,
    entityType: 'class_session', entityId: req.params.id,
  });
  res.status(204).end();
});
