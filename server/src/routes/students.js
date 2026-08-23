import { Router } from 'express';
import { nanoid } from 'nanoid';
import { db } from '../db/index.js';
import { requireMembership } from '../auth/middleware.js';
import { broadcastChange } from '../realtime/index.js';
import { ensureSessionsForRange } from '../services/sessions.js';
import { calcStudentTuitionForMonth } from '../services/finance.js';

export const studentsRouter = Router({ mergeParams: true });
studentsRouter.use(requireMembership());

function serialize(row) {
  return { ...row, subjects: JSON.parse(row.subjects || '[]') };
}

// 教師只能查看自己名下的學生（唯讀），管理者可查看全部
// 依編號排序（編號視為數字排序，沒有編號的排在最後，再依姓名排序）
const ORDER_BY_STUDENT_NO = "ORDER BY (student_no IS NULL OR student_no = ''), CAST(student_no AS INTEGER), name";

studentsRouter.get('/', (req, res) => {
  const rows =
    req.membership.role !== 'teacher'
      ? db.prepare(`SELECT * FROM students WHERE school_id = ? ${ORDER_BY_STUDENT_NO}`).all(req.params.schoolId)
      : db
          .prepare(`SELECT * FROM students WHERE school_id = ? AND teacher_id = ? ${ORDER_BY_STUDENT_NO}`)
          .all(req.params.schoolId, req.membership.teacher_id || '');
  res.json(rows.map(serialize));
});

studentsRouter.get('/:id', (req, res) => {
  const row = db
    .prepare('SELECT * FROM students WHERE school_id = ? AND id = ?')
    .get(req.params.schoolId, req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (req.membership.role === 'teacher' && row.teacher_id !== req.membership.teacher_id) {
    return res.status(403).json({ error: 'forbidden' });
  }
  res.json(serialize(row));
});

// 該學生在區間內的課堂與對應出缺勤狀態（詳細頁的課堂/出缺勤紀錄用）
studentsRouter.get('/:id/sessions', (req, res) => {
  const student = db
    .prepare('SELECT * FROM students WHERE school_id = ? AND id = ?')
    .get(req.params.schoolId, req.params.id);
  if (!student) return res.status(404).json({ error: 'not found' });
  if (req.membership.role === 'teacher' && student.teacher_id !== req.membership.teacher_id) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end required' });

  ensureSessionsForRange(req.params.schoolId, start, end);

  const rows = db
    .prepare(
      `SELECT cs.id as session_id, cs.session_date, cs.start_slot, cs.duration_slots, cs.subject, cs.teacher_id, cs.type,
              ss.unit_price, ar.status as attendance_status, ar.makeup_arranged, ar.makeup_session_id,
              origin.session_date as origin_session_date, origin.start_slot as origin_start_slot
       FROM session_students ss
       JOIN class_sessions cs ON cs.id = ss.session_id
       LEFT JOIN attendance_records ar ON ar.session_id = cs.id AND ar.person_type = 'student' AND ar.person_id = ss.student_id
       LEFT JOIN class_sessions origin ON origin.id = cs.origin_session_id
       WHERE cs.school_id = ? AND ss.student_id = ? AND cs.session_date >= ? AND cs.session_date < ? AND cs.cancelled = 0
       ORDER BY cs.session_date, cs.start_slot`
    )
    .all(req.params.schoolId, req.params.id, start, end);

  res.json(rows.map((r) => ({ ...r, makeup_arranged: !!r.makeup_arranged })));
});

// 該學生某月的應收/實收金額紀錄（財務資料，僅管理者）
studentsRouter.get('/:id/tuition', requireMembership(['admin']), (req, res) => {
  const { month } = req.query;
  if (!month) return res.status(400).json({ error: 'month required (YYYY-MM)' });

  const student = db
    .prepare('SELECT * FROM students WHERE school_id = ? AND id = ?')
    .get(req.params.schoolId, req.params.id);
  if (!student) return res.status(404).json({ error: 'not found' });

  const calc = calcStudentTuitionForMonth(req.params.schoolId, req.params.id, month);
  const record = db
    .prepare('SELECT * FROM tuition_records WHERE student_id = ? AND month = ?')
    .get(req.params.id, month);

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

  const student = db
    .prepare('SELECT * FROM students WHERE school_id = ? AND id = ?')
    .get(req.params.schoolId, req.params.id);
  if (!student) return res.status(404).json({ error: 'not found' });

  const calc = calcStudentTuitionForMonth(req.params.schoolId, req.params.id, month);
  const sessionCount = Number(session_count) || 0;
  const unitPrice = Number(unit_price) || 0;
  const expectedAmount = sessionCount * unitPrice + calc.rollover_amount;

  const existing = db
    .prepare('SELECT * FROM tuition_records WHERE student_id = ? AND month = ?')
    .get(req.params.id, month);

  if (existing) {
    db.prepare(
      `UPDATE tuition_records SET session_count=?, unit_price=?, expected_amount=?, actual_amount=?, rollover=?, note=?, updated_at=datetime('now')
       WHERE id = ?`
    ).run(sessionCount, unitPrice, expectedAmount, Number(actual_amount) || 0, rollover ? 1 : 0, note || null, existing.id);
  } else {
    db.prepare(
      `INSERT INTO tuition_records (id, school_id, student_id, month, session_count, unit_price, expected_amount, actual_amount, rollover, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      nanoid(),
      req.params.schoolId,
      req.params.id,
      month,
      sessionCount,
      unitPrice,
      expectedAmount,
      Number(actual_amount) || 0,
      rollover ? 1 : 0,
      note || null
    );
  }

  broadcastChange(req.params.schoolId, 'finance');
  const record = db.prepare('SELECT * FROM tuition_records WHERE student_id = ? AND month = ?').get(req.params.id, month);
  res.json({ ...record, rollover: !!record.rollover });
});

studentsRouter.delete('/:id/tuition', requireMembership(['admin']), (req, res) => {
  const { month } = req.query;
  if (!month) return res.status(400).json({ error: 'month required (YYYY-MM)' });

  db.prepare('DELETE FROM tuition_records WHERE school_id = ? AND student_id = ? AND month = ?').run(
    req.params.schoolId,
    req.params.id,
    month
  );

  broadcastChange(req.params.schoolId, 'finance');
  res.status(204).end();
});

studentsRouter.post('/', requireMembership(['admin', 'front_desk']), (req, res) => {
  const { student_no, name, grade, school_name, subjects, teacher_id, tuition_monthly, note } = req.body;
  if (!name || !grade) return res.status(400).json({ error: 'name and grade required' });

  // 編號不可重複（同一補習班內），姓名重複則不擋，只在回傳結果中提醒
  if (student_no) {
    const dupNo = db
      .prepare('SELECT id FROM students WHERE school_id = ? AND student_no = ?')
      .get(req.params.schoolId, student_no);
    if (dupNo) return res.status(409).json({ error: `編號「${student_no}」已存在，請確認編號是否重複` });
  }
  const dupName = db.prepare('SELECT id FROM students WHERE school_id = ? AND name = ?').get(req.params.schoolId, name);

  const id = nanoid();
  db.prepare(
    `INSERT INTO students (id, school_id, student_no, name, grade, school_name, subjects, teacher_id, tuition_monthly, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    req.params.schoolId,
    student_no || null,
    name,
    grade,
    school_name || null,
    JSON.stringify(subjects || []),
    teacher_id || null,
    tuition_monthly || 0,
    note || null
  );

  broadcastChange(req.params.schoolId, 'students');
  res.status(201).json({ ...serialize(db.prepare('SELECT * FROM students WHERE id = ?').get(id)), duplicate_name: !!dupName });
});

studentsRouter.put('/:id', requireMembership(['admin', 'front_desk']), (req, res) => {
  const existing = db
    .prepare('SELECT * FROM students WHERE school_id = ? AND id = ?')
    .get(req.params.schoolId, req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  const {
    student_no = existing.student_no,
    name = existing.name,
    grade = existing.grade,
    school_name = existing.school_name,
    subjects = JSON.parse(existing.subjects),
    teacher_id = existing.teacher_id,
    tuition_monthly = existing.tuition_monthly,
    note = existing.note,
    status = existing.status,
  } = req.body;

  if (student_no) {
    const dupNo = db
      .prepare('SELECT id FROM students WHERE school_id = ? AND student_no = ? AND id != ?')
      .get(req.params.schoolId, student_no, req.params.id);
    if (dupNo) return res.status(409).json({ error: `編號「${student_no}」已存在，請確認編號是否重複` });
  }
  const dupName = db
    .prepare('SELECT id FROM students WHERE school_id = ? AND name = ? AND id != ?')
    .get(req.params.schoolId, name, req.params.id);

  db.prepare(
    `UPDATE students SET student_no=?, name=?, grade=?, school_name=?, subjects=?, teacher_id=?, tuition_monthly=?, note=?, status=?, updated_at=datetime('now')
     WHERE id = ?`
  ).run(
    student_no,
    name,
    grade,
    school_name,
    JSON.stringify(subjects),
    teacher_id,
    tuition_monthly,
    note,
    status,
    req.params.id
  );

  broadcastChange(req.params.schoolId, 'students');
  res.json({ ...serialize(db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id)), duplicate_name: !!dupName });
});

studentsRouter.delete('/:id', requireMembership(['admin', 'front_desk']), (req, res) => {
  db.prepare('DELETE FROM students WHERE school_id = ? AND id = ?').run(
    req.params.schoolId,
    req.params.id
  );
  broadcastChange(req.params.schoolId, 'students');
  res.status(204).end();
});
