import { Router } from 'express';
import { nanoid } from 'nanoid';
import { studentsRepository, schedulingRepository, financeRepository } from '../repositories/index.js';
import { requireMembership } from '../auth/middleware.js';
import { broadcastChange } from '../realtime/index.js';
import { ensureSessionsForRange } from '../services/sessions.js';
import { calcStudentTuitionForMonth } from '../services/finance.js';
import { addToTrash, captureStudent } from '../services/trash.js';
import { sortStudents } from '../services/nameSort.js';
import { logEvent } from '../services/auditLog.service.js';
import { PAGE_KEYS } from '../constants/pageKeys.js';

export const studentsRouter = Router({ mergeParams: true });
studentsRouter.use(requireMembership());

function serialize(row) {
  return { ...row, subjects: JSON.parse(row.subjects || '[]') };
}

// 教師只能查看自己名下的學生（唯讀），管理者可查看全部
// 排序：1. 年級低到高 2. 學校名筆畫 3. 學生姓名筆畫；前端列表的「編號」欄位依這個順序從 1 編起，純顯示用不寫回資料庫
studentsRouter.get('/', (req, res) => {
  const rows =
    req.membership.role !== 'teacher'
      ? studentsRepository.findAllBySchool(req.params.schoolId)
      : studentsRepository.findAllBySchoolAndTeacher(req.params.schoolId, req.membership.teacher_id);
  res.json(sortStudents(rows).map(serialize));
});

studentsRouter.get('/:id', (req, res) => {
  const row = studentsRepository.findById(req.params.schoolId, req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (req.membership.role === 'teacher' && row.teacher_id !== req.membership.teacher_id) {
    return res.status(403).json({ error: 'forbidden' });
  }
  res.json(serialize(row));
});

// 該學生在區間內的課堂與對應出缺勤狀態（詳細頁的課堂/出缺勤紀錄用）
studentsRouter.get('/:id/sessions', (req, res) => {
  const student = studentsRepository.findById(req.params.schoolId, req.params.id);
  if (!student) return res.status(404).json({ error: 'not found' });
  if (req.membership.role === 'teacher' && student.teacher_id !== req.membership.teacher_id) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end required' });

  ensureSessionsForRange(req.params.schoolId, start, end);

  const rows = schedulingRepository.findStudentSessionsInRange(req.params.schoolId, req.params.id, start, end);
  res.json(rows.map((r) => ({ ...r, makeup_arranged: !!r.makeup_arranged })));
});

// 該學生某月的應收/實收金額紀錄（財務資料，僅管理者）
studentsRouter.get('/:id/tuition', requireMembership(['admin']), (req, res) => {
  const { month } = req.query;
  if (!month) return res.status(400).json({ error: 'month required (YYYY-MM)' });

  const student = studentsRepository.findById(req.params.schoolId, req.params.id);
  if (!student) return res.status(404).json({ error: 'not found' });

  const calc = calcStudentTuitionForMonth(req.params.schoolId, req.params.id, month);
  const record = financeRepository.findTuitionRecord(req.params.id, month);

  // 若本月已存檔，但上個月的紀錄在存檔「之後」又被修改（例如事後才補標記未收/併入次月），
  // 存檔當下寫死的結轉金額就會過期，這裡比對現在重新試算的結轉金額，不同就提醒管理者重新確認
  let rolloverStale = false;
  if (record) {
    const frozenRollover = record.expected_amount - record.session_count * record.unit_price;
    rolloverStale = frozenRollover !== calc.rollover_amount;
  }

  res.json({
    month,
    session_count: record ? record.session_count : calc.suggested_session_count,
    unit_price: record ? record.unit_price : calc.suggested_unit_price,
    rollover_amount: calc.rollover_amount,
    rollover_unsaved: calc.rollover_unsaved,
    rollover_stale: rolloverStale,
    items: calc.items,
    estimated: calc.estimated,
    expected_amount: record ? record.expected_amount : calc.expected_amount,
    actual_amount: record ? record.actual_amount : calc.expected_amount,
    rollover: record ? !!record.rollover : false,
    note: record ? record.note : null,
    saved: !!record,
  });
});

studentsRouter.put('/:id/tuition', requireMembership(['admin']), (req, res) => {
  const { month, session_count, unit_price, actual_amount, rollover, note } = req.body;
  if (!month) return res.status(400).json({ error: 'month required (YYYY-MM)' });

  const student = studentsRepository.findById(req.params.schoolId, req.params.id);
  if (!student) return res.status(404).json({ error: 'not found' });

  const calc = calcStudentTuitionForMonth(req.params.schoolId, req.params.id, month);
  const sessionCount = Number(session_count) || 0;
  const unitPrice = Number(unit_price) || 0;
  const expectedAmount = sessionCount * unitPrice + calc.rollover_amount;

  const existing = financeRepository.findTuitionRecord(req.params.id, month);

  if (existing) {
    financeRepository.updateTuitionRecord(existing.id, {
      sessionCount,
      unitPrice,
      expectedAmount,
      actualAmount: Number(actual_amount) || 0,
      rollover,
      note: note || null,
    });
  } else {
    financeRepository.createTuitionRecord({
      id: nanoid(),
      schoolId: req.params.schoolId,
      studentId: req.params.id,
      month,
      sessionCount,
      unitPrice,
      expectedAmount,
      actualAmount: Number(actual_amount) || 0,
      rollover,
      note: note || null,
    });
  }

  broadcastChange(req.params.schoolId, 'finance');
  logEvent({
    category: 'DATA_CHANGE', pageKey: PAGE_KEYS.STUDENTS, action: 'tuition_record.upsert',
    message: `更新學費紀錄（${month}）`, userId: req.user.id, schoolId: req.params.schoolId, entityType: 'tuition_record', entityId: req.params.id,
  });
  const record = financeRepository.findTuitionRecord(req.params.id, month);
  res.json({ ...record, rollover: !!record.rollover });
});

studentsRouter.delete('/:id/tuition', requireMembership(['admin']), (req, res) => {
  const { month } = req.query;
  if (!month) return res.status(400).json({ error: 'month required (YYYY-MM)' });

  const existing = financeRepository.findTuitionRecordScoped(req.params.schoolId, req.params.id, month);
  if (existing) {
    const student = studentsRepository.findById(req.params.schoolId, req.params.id);
    addToTrash(
      req.params.schoolId,
      'tuition_record',
      `${student?.name || '未知學生'} ${month} 學費紀錄`,
      { tables: [{ table: 'tuition_records', rows: [existing] }] },
      req.user.id,
      { studentIds: [req.params.id] }
    );
  }

  financeRepository.deleteTuitionRecord(req.params.schoolId, req.params.id, month);

  broadcastChange(req.params.schoolId, 'finance');
  logEvent({
    category: 'DATA_CHANGE', pageKey: PAGE_KEYS.STUDENTS, action: 'tuition_record.delete',
    message: `刪除學費紀錄（${month}）`, userId: req.user.id, schoolId: req.params.schoolId, entityType: 'tuition_record', entityId: req.params.id,
  });
  res.status(204).end();
});

studentsRouter.post('/', requireMembership(['admin', 'front_desk']), (req, res) => {
  const { name, grade, school_name, subjects, teacher_id, tuition_monthly, note, status } = req.body;
  if (!name || !grade) return res.status(400).json({ error: 'name and grade required' });

  // 姓名重複不擋，只在回傳結果中提醒（前端匯入/新增流程改成在送出前先跳視窗詢問，這裡只當保險）
  const dupName = studentsRepository.findByName(req.params.schoolId, name);

  const id = nanoid();
  studentsRepository.create({
    id,
    schoolId: req.params.schoolId,
    name,
    grade,
    schoolName: school_name || null,
    subjects: subjects || [],
    teacherId: teacher_id || null,
    tuitionMonthly: tuition_monthly || 0,
    note: note || null,
    status: status === 'inactive' ? 'inactive' : 'active',
  });

  broadcastChange(req.params.schoolId, 'students');
  logEvent({
    category: 'DATA_CHANGE', pageKey: PAGE_KEYS.STUDENTS, action: 'student.create',
    message: `新增學生「${name}」`, userId: req.user.id, schoolId: req.params.schoolId, entityType: 'student', entityId: id,
  });
  res.status(201).json({ ...serialize(studentsRepository.findById(req.params.schoolId, id)), duplicate_name: !!dupName });
});

studentsRouter.put('/:id', requireMembership(['admin', 'front_desk']), (req, res) => {
  const existing = studentsRepository.findById(req.params.schoolId, req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  const {
    name = existing.name,
    grade = existing.grade,
    school_name = existing.school_name,
    subjects = JSON.parse(existing.subjects),
    teacher_id = existing.teacher_id,
    tuition_monthly = existing.tuition_monthly,
    note = existing.note,
    status = existing.status,
  } = req.body;

  const dupName = studentsRepository.findByName(req.params.schoolId, name, req.params.id);

  studentsRepository.update(req.params.id, {
    name,
    grade,
    schoolName: school_name,
    subjects,
    teacherId: teacher_id,
    tuitionMonthly: tuition_monthly,
    note,
    status,
  });

  broadcastChange(req.params.schoolId, 'students');
  logEvent({
    category: 'DATA_CHANGE', pageKey: PAGE_KEYS.STUDENTS, action: 'student.update',
    message: `更新學生「${name}」`, userId: req.user.id, schoolId: req.params.schoolId, entityType: 'student', entityId: req.params.id,
  });
  res.json({ ...serialize(studentsRepository.findById(req.params.schoolId, req.params.id)), duplicate_name: !!dupName });
});

studentsRouter.delete('/:id', requireMembership(['admin', 'front_desk']), (req, res) => {
  const existing = studentsRepository.findById(req.params.schoolId, req.params.id);
  if (!existing) return res.status(204).end();

  addToTrash(req.params.schoolId, 'student', existing.name, captureStudent(req.params.id), req.user.id);

  studentsRepository.delete(req.params.schoolId, req.params.id);
  broadcastChange(req.params.schoolId, 'students');
  logEvent({
    category: 'DATA_CHANGE', pageKey: PAGE_KEYS.STUDENTS, action: 'student.delete',
    message: `刪除學生「${existing.name}」`, userId: req.user.id, schoolId: req.params.schoolId, entityType: 'student', entityId: req.params.id,
  });
  res.status(204).end();
});
