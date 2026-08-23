import { Router } from 'express';
import { nanoid } from 'nanoid';
import { db } from '../db/index.js';
import { requireMembership } from '../auth/middleware.js';
import { broadcastChange } from '../realtime/index.js';
import { calcTeacherSalary } from '../services/finance.js';
import { ensureSessionsForRange } from '../services/sessions.js';

export const teachersRouter = Router({ mergeParams: true });
teachersRouter.use(requireMembership());

function serialize(row) {
  return { ...row, subjects: JSON.parse(row.subjects || '[]') };
}

// 依編號排序（編號視為數字排序，沒有編號的排在最後，再依姓名排序）
const ORDER_BY_TEACHER_NO = "ORDER BY (teacher_no IS NULL OR teacher_no = ''), CAST(teacher_no AS INTEGER), name";

// 教師只能查看自己的教師檔案（唯讀），管理者可查看全部
teachersRouter.get('/', (req, res) => {
  const rows =
    req.membership.role !== 'teacher'
      ? db.prepare(`SELECT * FROM teachers WHERE school_id = ? ${ORDER_BY_TEACHER_NO}`).all(req.params.schoolId)
      : db
          .prepare('SELECT * FROM teachers WHERE school_id = ? AND id = ?')
          .all(req.params.schoolId, req.membership.teacher_id || '');
  res.json(rows.map(serialize));
});

teachersRouter.get('/:id', (req, res) => {
  const row = db
    .prepare('SELECT * FROM teachers WHERE school_id = ? AND id = ?')
    .get(req.params.schoolId, req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (req.membership.role === 'teacher' && row.id !== req.membership.teacher_id) {
    return res.status(403).json({ error: 'forbidden' });
  }
  res.json(serialize(row));
});

// 該教師在區間內的課堂（含行政課堂）與對應薪資明細，給教師詳細頁的課堂明細/薪資試算用
// 這是薪資計算資料（金額/時薪），不屬於櫃台（front_desk）的五項子系統範圍，僅管理者或教師本人可查看
teachersRouter.get('/:id/sessions', (req, res) => {
  const teacher = db
    .prepare('SELECT * FROM teachers WHERE school_id = ? AND id = ?')
    .get(req.params.schoolId, req.params.id);
  if (!teacher) return res.status(404).json({ error: 'not found' });
  if (req.membership.role !== 'admin' && teacher.id !== req.membership.teacher_id) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end required' });

  ensureSessionsForRange(req.params.schoolId, start, end);
  res.json(calcTeacherSalary(req.params.schoolId, req.params.id, start, end).items);
});

teachersRouter.post('/', requireMembership(['admin', 'front_desk']), (req, res) => {
  const {
    teacher_no,
    name,
    subjects,
    rate_grade_1_6,
    rate_grade_7_9,
    rate_grade_10_12,
    rate_admin,
    note,
  } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  // 編號不可重複（同一補習班內），姓名重複則不擋，只在回傳結果中提醒
  if (teacher_no) {
    const dupNo = db
      .prepare('SELECT id FROM teachers WHERE school_id = ? AND teacher_no = ?')
      .get(req.params.schoolId, teacher_no);
    if (dupNo) return res.status(409).json({ error: `編號「${teacher_no}」已存在，請確認編號是否重複` });
  }
  const dupName = db.prepare('SELECT id FROM teachers WHERE school_id = ? AND name = ?').get(req.params.schoolId, name);

  const id = nanoid();
  db.prepare(
    `INSERT INTO teachers (id, school_id, teacher_no, name, subjects, rate_grade_1_6, rate_grade_7_9, rate_grade_10_12, rate_admin, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    req.params.schoolId,
    teacher_no || null,
    name,
    JSON.stringify(subjects || []),
    rate_grade_1_6 || 0,
    rate_grade_7_9 || 0,
    rate_grade_10_12 || 0,
    rate_admin || 0,
    note || null
  );

  broadcastChange(req.params.schoolId, 'teachers');
  res.status(201).json({ ...serialize(db.prepare('SELECT * FROM teachers WHERE id = ?').get(id)), duplicate_name: !!dupName });
});

teachersRouter.put('/:id', requireMembership(['admin', 'front_desk']), (req, res) => {
  const existing = db
    .prepare('SELECT * FROM teachers WHERE school_id = ? AND id = ?')
    .get(req.params.schoolId, req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  const {
    teacher_no = existing.teacher_no,
    name = existing.name,
    subjects = JSON.parse(existing.subjects),
    rate_grade_1_6 = existing.rate_grade_1_6,
    rate_grade_7_9 = existing.rate_grade_7_9,
    rate_grade_10_12 = existing.rate_grade_10_12,
    rate_admin = existing.rate_admin,
    note = existing.note,
    status = existing.status,
  } = req.body;

  if (teacher_no) {
    const dupNo = db
      .prepare('SELECT id FROM teachers WHERE school_id = ? AND teacher_no = ? AND id != ?')
      .get(req.params.schoolId, teacher_no, req.params.id);
    if (dupNo) return res.status(409).json({ error: `編號「${teacher_no}」已存在，請確認編號是否重複` });
  }
  const dupName = db
    .prepare('SELECT id FROM teachers WHERE school_id = ? AND name = ? AND id != ?')
    .get(req.params.schoolId, name, req.params.id);

  db.prepare(
    `UPDATE teachers SET teacher_no=?, name=?, subjects=?, rate_grade_1_6=?, rate_grade_7_9=?, rate_grade_10_12=?, rate_admin=?, note=?, status=?, updated_at=datetime('now')
     WHERE id = ?`
  ).run(
    teacher_no,
    name,
    JSON.stringify(subjects),
    rate_grade_1_6,
    rate_grade_7_9,
    rate_grade_10_12,
    rate_admin,
    note,
    status,
    req.params.id
  );

  broadcastChange(req.params.schoolId, 'teachers');
  res.json({ ...serialize(db.prepare('SELECT * FROM teachers WHERE id = ?').get(req.params.id)), duplicate_name: !!dupName });
});

teachersRouter.delete('/:id', requireMembership(['admin', 'front_desk']), (req, res) => {
  db.prepare('DELETE FROM teachers WHERE school_id = ? AND id = ?').run(
    req.params.schoolId,
    req.params.id
  );
  broadcastChange(req.params.schoolId, 'teachers');
  res.status(204).end();
});
