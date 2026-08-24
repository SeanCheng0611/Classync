import { Router } from 'express';
import { nanoid } from 'nanoid';
import { db } from '../db/index.js';
import { requireMembership } from '../auth/middleware.js';
import { broadcastChange } from '../realtime/index.js';
import { ensureSessionsForRange } from '../services/sessions.js';
import { monthRange } from '../services/finance.js';
import { addToTrash, captureInvoice } from '../services/trash.js';

export const invoicesRouter = Router({ mergeParams: true });
invoicesRouter.use(requireMembership(['admin']));

// 該學生某月的課堂清單（含出缺勤狀態與是否已開立過繳費單），供開立繳費單頁勾選用
invoicesRouter.get('/sessions', (req, res) => {
  const { student_id, month } = req.query;
  if (!student_id || !month) return res.status(400).json({ error: 'student_id and month required' });

  const student = db.prepare('SELECT * FROM students WHERE id = ? AND school_id = ?').get(student_id, req.params.schoolId);
  if (!student) return res.status(404).json({ error: 'student not found' });

  const [start, end] = monthRange(month);
  ensureSessionsForRange(req.params.schoolId, start, end);

  const rows = db
    .prepare(
      `SELECT cs.id as session_id, cs.session_date, cs.start_slot, cs.duration_slots, cs.subject, cs.teacher_id, cs.type,
              ss.unit_price, ar.status as attendance_status,
              CASE WHEN ii.id IS NOT NULL THEN 1 ELSE 0 END as invoiced,
              origin.session_date as origin_session_date, origin.start_slot as origin_start_slot
       FROM session_students ss
       JOIN class_sessions cs ON cs.id = ss.session_id
       LEFT JOIN attendance_records ar ON ar.session_id = cs.id AND ar.person_type = 'student' AND ar.person_id = ss.student_id
       LEFT JOIN invoice_items ii ON ii.session_id = cs.id
       LEFT JOIN class_sessions origin ON origin.id = cs.origin_session_id
       WHERE cs.school_id = ? AND ss.student_id = ? AND cs.session_date >= ? AND cs.session_date < ? AND cs.cancelled = 0
       ORDER BY cs.session_date, cs.start_slot`
    )
    .all(req.params.schoolId, student_id, start, end);

  res.json(rows.map((r) => ({ ...r, invoiced: !!r.invoiced })));
});

// 某學生已開立的繳費單列表
invoicesRouter.get('/', (req, res) => {
  const { student_id } = req.query;
  if (!student_id) return res.status(400).json({ error: 'student_id required' });

  const rows = db
    .prepare(
      `SELECT i.*, (SELECT COUNT(*) FROM invoice_items WHERE invoice_id = i.id) as item_count
       FROM invoices i WHERE i.school_id = ? AND i.student_id = ?
       ORDER BY i.issued_date DESC, i.created_at DESC`
    )
    .all(req.params.schoolId, student_id);
  res.json(rows);
});

// 開立繳費單：從指定的課堂（須為該學生、尚未開立過）挑選建立，可跨月；不論日期到了沒或出缺勤狀態都能開立
invoicesRouter.post('/', (req, res) => {
  const { student_id, session_ids, note } = req.body;
  if (!student_id || !Array.isArray(session_ids) || session_ids.length === 0) {
    return res.status(400).json({ error: 'student_id and session_ids required' });
  }

  const student = db.prepare('SELECT * FROM students WHERE id = ? AND school_id = ?').get(student_id, req.params.schoolId);
  if (!student) return res.status(404).json({ error: 'student not found' });

  const items = [];
  for (const sessionId of session_ids) {
    const row = db
      .prepare(
        `SELECT cs.id, cs.session_date, cs.subject, ss.unit_price
         FROM class_sessions cs
         JOIN session_students ss ON ss.session_id = cs.id AND ss.student_id = ?
         WHERE cs.id = ? AND cs.school_id = ?`
      )
      .get(student_id, sessionId, req.params.schoolId);
    if (!row) return res.status(400).json({ error: `課堂不存在或不屬於此學生（${sessionId}）` });
    const already = db.prepare('SELECT 1 FROM invoice_items WHERE session_id = ?').get(sessionId);
    if (already) {
      return res.status(409).json({ error: `${row.session_date} ${row.subject} 已開立過繳費單，無法重複開立` });
    }
    items.push(row);
  }

  const total = items.reduce((sum, i) => sum + i.unit_price, 0);
  const invoiceId = nanoid();
  db.prepare(
    `INSERT INTO invoices (id, school_id, student_id, total_amount, note) VALUES (?, ?, ?, ?, ?)`
  ).run(invoiceId, req.params.schoolId, student_id, total, note || null);

  const insertItem = db.prepare('INSERT INTO invoice_items (id, invoice_id, session_id, unit_price) VALUES (?, ?, ?, ?)');
  for (const i of items) insertItem.run(nanoid(), invoiceId, i.id, i.unit_price);

  broadcastChange(req.params.schoolId, 'finance');
  res.status(201).json(db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId));
});

// 單張繳費單明細（逐堂課清單）
invoicesRouter.get('/:id', (req, res) => {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ? AND school_id = ?').get(req.params.id, req.params.schoolId);
  if (!invoice) return res.status(404).json({ error: 'not found' });

  const items = db
    .prepare(
      `SELECT ii.id, ii.unit_price, cs.session_date, cs.subject, cs.type, cs.start_slot, cs.duration_slots, cs.teacher_id,
              origin.session_date as origin_session_date, origin.start_slot as origin_start_slot
       FROM invoice_items ii JOIN class_sessions cs ON cs.id = ii.session_id
       LEFT JOIN class_sessions origin ON origin.id = cs.origin_session_id
       WHERE ii.invoice_id = ? ORDER BY cs.session_date`
    )
    .all(req.params.id);

  res.json({ ...invoice, items });
});

// 刪除繳費單：釋放其中的課堂讓它們可以被重新開立，若已產生對應的收支明細也一併刪除
invoicesRouter.delete('/:id', (req, res) => {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ? AND school_id = ?').get(req.params.id, req.params.schoolId);
  if (!invoice) return res.status(404).json({ error: 'not found' });

  const student = db.prepare('SELECT name FROM students WHERE id = ?').get(invoice.student_id);
  const label = `${student?.name || '未知學生'} ${invoice.issued_date} 繳費單`;
  addToTrash(req.params.schoolId, 'invoice', label, captureInvoice(req.params.id), req.user.id, { studentIds: [invoice.student_id] });

  db.prepare('DELETE FROM ledger_entries WHERE related_invoice_id = ?').run(req.params.id);
  db.prepare('DELETE FROM invoices WHERE id = ?').run(req.params.id);

  broadcastChange(req.params.schoolId, 'finance');
  res.status(204).end();
});
