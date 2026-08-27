import { Router } from 'express';
import { nanoid } from 'nanoid';
import { schedulingRepository, teachersRepository, studentsRepository } from '../repositories/index.js';
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
import { logEvent } from '../services/auditLog.service.js';
import { PAGE_KEYS } from '../constants/pageKeys.js';

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
    const teacher = teachersRepository.findById(schoolId, teacherId);
    return `教師「${teacher?.name || ''}」星期${WEEKDAY_LABELS[weekday]} ${slotRangeLabel(startSlot, durationSlots)} 已有其他固定課（${teacherConflict.subject}），時段重疊`;
  }
  for (const studentId of studentIds || []) {
    const conflict = findStudentTemplateConflict(
      schoolId, studentId, weekday, startSlot, durationSlots, excludeTemplateId, activeFrom, activeUntil
    );
    if (conflict) {
      const student = studentsRepository.findById(schoolId, studentId);
      return `學生「${student?.name || ''}」星期${WEEKDAY_LABELS[weekday]} ${slotRangeLabel(startSlot, durationSlots)} 已有其他固定課（${conflict.subject}），時段重疊`;
    }
  }
  return null;
}

function withStudents(row) {
  const students = schedulingRepository.findTemplateStudents(row.id);
  return { ...row, students, student_ids: students.map((s) => s.student_id) };
}

// 相容兩種輸入格式：students: [{student_id, unit_price}] 或舊版 student_ids: [id]
function normalizeStudents(body) {
  if (Array.isArray(body.students)) return body.students;
  if (Array.isArray(body.student_ids)) return body.student_ids.map((id) => ({ student_id: id, unit_price: 0 }));
  return undefined;
}

// 教師只能查看自己任教的固定課（唯讀），管理者可查看全部
scheduleTemplatesRouter.get('/', (req, res) => {
  const rows =
    req.membership.role !== 'teacher'
      ? schedulingRepository.findTemplatesBySchool(req.params.schoolId)
      : schedulingRepository.findTemplatesBySchoolAndTeacher(req.params.schoolId, req.membership.teacher_id);
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
    schedulingRepository.createTemplate({
      id,
      schoolId: req.params.schoolId,
      teacherId: teacher_id,
      subject,
      weekday: weekdayNum,
      startSlot: segStart,
      durationSlots: segEnd - segStart,
      activeFrom: activeFromVal,
      activeUntil: activeUntilVal,
      note: note || null,
      rateOverride: rate_override != null ? Number(rate_override) : null,
      students: studentEntries,
    });
    createdIds.push(id);
  }

  broadcastChange(req.params.schoolId, 'schedule');
  logEvent({
    category: 'DATA_CHANGE', pageKey: PAGE_KEYS.SCHEDULE, action: 'schedule_template.create',
    message: `新增固定課「${subject}」`, userId: req.user.id, schoolId: req.params.schoolId,
    entityType: 'schedule_template', entityId: createdIds[0], metadata: { count: createdIds.length },
  });
  res.status(201).json({
    templates: createdIds.map((tid) => withStudents(schedulingRepository.findTemplateById(req.params.schoolId, tid))),
    auto_adjusted: autoAdjusted,
  });
});

scheduleTemplatesRouter.put('/:id', requireMembership(['admin', 'front_desk']), (req, res) => {
  const existing = schedulingRepository.findTemplateById(req.params.schoolId, req.params.id);
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

  // 移除的學生（從既有名單比對，樣板移除學生時要一併把「尚未發生」的已展開課堂移除該生）
  let removedStudentIds;
  if (normalized !== undefined) {
    const prevStudentIds = withStudents(existing).student_ids;
    removedStudentIds = prevStudentIds.filter((sid) => !studentIds.includes(sid));
  }

  const shouldCancelFutureSessions = req.body.active_until !== undefined && !!req.body.active_until;

  schedulingRepository.updateTemplate(req.params.id, {
    fields: {
      teacherId: teacher_id,
      subject,
      weekday,
      startSlot: start_slot,
      durationSlots: duration_slots,
      activeFrom: active_from,
      activeUntil: active_until,
      note,
      rateOverride: nextRateOverride,
    },
    // 樣板時薪覆寫值變動時，把已展開但尚未發生的課堂一併同步，避免舊課堂還沿用舊值
    syncRateOverride: rate_override !== existing.rate_override ? nextRateOverride : undefined,
    // 縮短樣板有效期間時，把已展開但落在新結束日之後、尚未發生的課堂一併取消
    cancelSessionsAfterDate: shouldCancelFutureSessions ? req.body.active_until : null,
    students: normalized,
    removedStudentIds,
  });

  // 跟原本邏輯一致：這兩個條件各自獨立、都基於「輸入是否要求這麼做」而非「實際有沒有列被動到」，
  // 都成立時會各自觸發一次 'sessions' 廣播（可能共兩次，跟原本行為一致）
  if (shouldCancelFutureSessions) broadcastChange(req.params.schoolId, 'sessions');
  if (removedStudentIds && removedStudentIds.length > 0) broadcastChange(req.params.schoolId, 'sessions');

  broadcastChange(req.params.schoolId, 'schedule');
  logEvent({
    category: 'DATA_CHANGE', pageKey: PAGE_KEYS.SCHEDULE, action: 'schedule_template.update',
    message: `更新固定課「${subject}」`, userId: req.user.id, schoolId: req.params.schoolId,
    entityType: 'schedule_template', entityId: req.params.id,
  });
  res.json(withStudents(schedulingRepository.findTemplateById(req.params.schoolId, req.params.id)));
});

scheduleTemplatesRouter.delete('/:id', requireMembership(['admin', 'front_desk']), (req, res) => {
  const existing = schedulingRepository.findTemplateById(req.params.schoolId, req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  const teacher = teachersRepository.findById(req.params.schoolId, existing.teacher_id);
  const label = `${existing.subject} 星期${WEEKDAY_LABELS[existing.weekday]} ${slotRangeLabel(existing.start_slot, existing.duration_slots)}（${teacher?.name || '未知教師'}）`;
  const studentIds = schedulingRepository.findTemplateStudents(req.params.id).map((r) => r.student_id);

  // 停開整堂固定課：已展開但尚未發生的課堂一併取消（atomic），接著在 template 列還存在時擷取快照存進回收桶，
  // 最後才真正刪除 template——captureScheduleTemplate 需要讀到還沒被刪除的 template 列，順序不能顛倒
  const toCancel = schedulingRepository.cancelFutureSessionsByTemplate(req.params.id);

  addToTrash(req.params.schoolId, 'schedule_template', label, captureScheduleTemplate(req.params.id, toCancel), req.user.id, {
    studentIds,
    teacherId: existing.teacher_id,
  });

  schedulingRepository.deleteTemplate(req.params.schoolId, req.params.id);

  broadcastChange(req.params.schoolId, 'schedule');
  broadcastChange(req.params.schoolId, 'sessions');
  logEvent({
    category: 'DATA_CHANGE', pageKey: PAGE_KEYS.SCHEDULE, action: 'schedule_template.delete',
    message: `刪除固定課「${label}」`, userId: req.user.id, schoolId: req.params.schoolId,
    entityType: 'schedule_template', entityId: req.params.id,
  });
  res.status(204).end();
});
