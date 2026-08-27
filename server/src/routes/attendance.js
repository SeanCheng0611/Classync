import { Router } from 'express';
import { attendanceRepository, schedulingRepository } from '../repositories/index.js';
import { requireMembership } from '../auth/middleware.js';
import { broadcastChange } from '../realtime/index.js';
import { setAttendance, revokeAttendance } from '../services/attendance.service.js';
import { logEvent } from '../services/auditLog.service.js';
import { PAGE_KEYS } from '../constants/pageKeys.js';

export const attendanceRouter = Router({ mergeParams: true });
attendanceRouter.use(requireMembership());

// 教師只能查看自己任教課程的點名紀錄（唯讀），管理者可查看全部
attendanceRouter.get('/', (req, res) => {
  const { date, session_id } = req.query;
  const teacherFilter = req.membership.role !== 'teacher' ? null : req.membership.teacher_id || '';
  let rows;
  if (session_id) {
    rows = teacherFilter
      ? attendanceRepository.findBySessionAndTeacher(session_id, teacherFilter)
      : attendanceRepository.findBySession(session_id);
  } else if (date) {
    rows = teacherFilter
      ? attendanceRepository.findByDateAndTeacher(req.params.schoolId, date, teacherFilter)
      : attendanceRepository.findByDate(req.params.schoolId, date);
  } else {
    return res.status(400).json({ error: 'date or session_id query param required' });
  }
  res.json(rows.map((r) => ({ ...r, makeup_arranged: !!r.makeup_arranged })));
});

// 新增或更新一筆點名紀錄：僅管理者可點名，教師僅能查看
attendanceRouter.post('/', requireMembership(['admin', 'front_desk']), (req, res) => {
  const { session_id, person_type, person_id, status, makeup_arranged, note } = req.body;
  if (!session_id || !person_type || !person_id || !status) {
    return res.status(400).json({ error: 'session_id, person_type, person_id, status required' });
  }
  if (person_type !== 'student') {
    return res.status(400).json({ error: '教師點名已停用，教師薪資改依排課自動計算' });
  }
  if (!['present', 'absent', 'leave'].includes(status)) {
    return res.status(400).json({ error: 'invalid status' });
  }

  const session = schedulingRepository.findSessionById(req.params.schoolId, session_id);
  if (!session) return res.status(404).json({ error: 'session not found' });

  const { record, wasUpdate } = setAttendance({
    schoolId: req.params.schoolId,
    sessionId: session_id,
    personType: person_type,
    personId: person_id,
    status,
    makeupArranged: !!makeup_arranged,
    note: note || null,
  });

  broadcastChange(req.params.schoolId, 'attendance');
  logEvent({
    level: 'INFO',
    category: 'DATA_CHANGE',
    pageKey: PAGE_KEYS.ATTENDANCE,
    action: 'attendance.set',
    message: `點名紀錄設為「${status}」`,
    userId: req.user.id,
    schoolId: req.params.schoolId,
    entityType: 'attendance_record',
    entityId: record.id,
    metadata: { session_id, person_type, person_id, status },
  });
  res.status(wasUpdate ? 200 : 201).json({ ...record, makeup_arranged: !!record.makeup_arranged });
});

// 撤銷一筆點名紀錄（請假/調課可逆）：若該紀錄已排定調課課堂，一併刪除該調課課堂，恢復成「尚未點名」
attendanceRouter.delete('/', requireMembership(['admin', 'front_desk']), (req, res) => {
  const { session_id, person_type, person_id } = req.query;
  if (!session_id || !person_type || !person_id) {
    return res.status(400).json({ error: 'session_id, person_type, person_id required' });
  }

  const result = revokeAttendance({ sessionId: session_id, personType: person_type, personId: person_id });
  if (!result) return res.status(404).json({ error: 'not found' });

  if (result.makeupCancelled) broadcastChange(req.params.schoolId, 'sessions');
  broadcastChange(req.params.schoolId, 'attendance');
  logEvent({
    level: 'INFO',
    category: 'DATA_CHANGE',
    pageKey: PAGE_KEYS.ATTENDANCE,
    action: 'attendance.revoke',
    message: '撤銷點名紀錄',
    userId: req.user.id,
    schoolId: req.params.schoolId,
    entityType: 'attendance_record',
    entityId: result.record.id,
    metadata: { session_id, person_type, person_id, makeup_cancelled: result.makeupCancelled },
  });
  res.status(204).end();
});
