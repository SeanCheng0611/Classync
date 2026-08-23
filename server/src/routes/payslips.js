import { Router } from 'express';
import { nanoid } from 'nanoid';
import { db } from '../db/index.js';
import { requireMembership } from '../auth/middleware.js';
import { broadcastChange } from '../realtime/index.js';
import { ensureSessionsForRange } from '../services/sessions.js';
import { monthRange, calcSessionPay } from '../services/finance.js';

export const payslipsRouter = Router({ mergeParams: true });
payslipsRouter.use(requireMembership(['admin']));

// 該教師某月的課堂清單（含試算金額與是否已開立過薪資條），供開立薪資條頁勾選用
payslipsRouter.get('/sessions', (req, res) => {
  const { teacher_id, month } = req.query;
  if (!teacher_id || !month) return res.status(400).json({ error: 'teacher_id and month required' });

  const teacher = db.prepare('SELECT * FROM teachers WHERE id = ? AND school_id = ?').get(teacher_id, req.params.schoolId);
  if (!teacher) return res.status(404).json({ error: 'teacher not found' });

  const [start, end] = monthRange(month);
  ensureSessionsForRange(req.params.schoolId, start, end);

  const sessions = db
    .prepare(
      `SELECT * FROM class_sessions WHERE school_id = ? AND teacher_id = ? AND session_date >= ? AND session_date < ? AND cancelled = 0
       ORDER BY session_date, start_slot`
    )
    .all(req.params.schoolId, teacher_id, start, end);

  const rows = sessions.map((session) => {
    const pay = calcSessionPay(teacher, session);
    const issued = !!db.prepare('SELECT 1 FROM payslip_items WHERE session_id = ?').get(session.id);
    return { ...pay, issued };
  });

  res.json(rows);
});

// 某教師已開立的薪資條列表
payslipsRouter.get('/', (req, res) => {
  const { teacher_id } = req.query;
  if (!teacher_id) return res.status(400).json({ error: 'teacher_id required' });

  const rows = db
    .prepare(
      `SELECT p.*, (SELECT COUNT(*) FROM payslip_items WHERE payslip_id = p.id) as item_count
       FROM payslips p WHERE p.school_id = ? AND p.teacher_id = ?
       ORDER BY p.issued_date DESC, p.created_at DESC`
    )
    .all(req.params.schoolId, teacher_id);
  res.json(rows);
});

// 開立薪資條：從指定的課堂（須屬於該教師、尚未開立過）挑選建立，可跨月
payslipsRouter.post('/', (req, res) => {
  const { teacher_id, session_ids, note } = req.body;
  if (!teacher_id || !Array.isArray(session_ids) || session_ids.length === 0) {
    return res.status(400).json({ error: 'teacher_id and session_ids required' });
  }

  const teacher = db.prepare('SELECT * FROM teachers WHERE id = ? AND school_id = ?').get(teacher_id, req.params.schoolId);
  if (!teacher) return res.status(404).json({ error: 'teacher not found' });

  const items = [];
  for (const sessionId of session_ids) {
    const session = db
      .prepare('SELECT * FROM class_sessions WHERE id = ? AND school_id = ? AND teacher_id = ?')
      .get(sessionId, req.params.schoolId, teacher_id);
    if (!session) return res.status(400).json({ error: `課堂不存在或不屬於此教師（${sessionId}）` });
    const already = db.prepare('SELECT 1 FROM payslip_items WHERE session_id = ?').get(sessionId);
    if (already) {
      return res.status(409).json({ error: `${session.session_date} ${session.subject} 已開立過薪資條，無法重複開立` });
    }
    const item = calcSessionPay(teacher, session);
    if (item.fully_on_leave) {
      const label = item.leave_is_makeup ? '已調課' : '已請假';
      return res.status(400).json({ error: `${session.session_date} ${session.subject}（${label}）無法計入薪資` });
    }
    items.push(item);
  }

  const total = items.reduce((sum, i) => sum + i.pay, 0);
  const payslipId = nanoid();
  db.prepare(
    `INSERT INTO payslips (id, school_id, teacher_id, total_amount, note) VALUES (?, ?, ?, ?, ?)`
  ).run(payslipId, req.params.schoolId, teacher_id, Math.round(total), note || null);

  const insertItem = db.prepare(
    'INSERT INTO payslip_items (id, payslip_id, session_id, hours, rate, pay) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const i of items) insertItem.run(nanoid(), payslipId, i.session_id, i.hours, i.rate, Math.round(i.pay));

  broadcastChange(req.params.schoolId, 'finance');
  res.status(201).json(db.prepare('SELECT * FROM payslips WHERE id = ?').get(payslipId));
});

// 單張薪資條明細（逐堂課清單）
payslipsRouter.get('/:id', (req, res) => {
  const payslip = db.prepare('SELECT * FROM payslips WHERE id = ? AND school_id = ?').get(req.params.id, req.params.schoolId);
  if (!payslip) return res.status(404).json({ error: 'not found' });

  const items = db
    .prepare(
      `SELECT pi.id, pi.hours, pi.rate, pi.pay, cs.session_date, cs.subject, cs.type,
              origin.session_date as origin_session_date, origin.start_slot as origin_start_slot
       FROM payslip_items pi JOIN class_sessions cs ON cs.id = pi.session_id
       LEFT JOIN class_sessions origin ON origin.id = cs.origin_session_id
       WHERE pi.payslip_id = ? ORDER BY cs.session_date`
    )
    .all(req.params.id);

  res.json({ ...payslip, items });
});

// 刪除薪資條：釋放其中的課堂讓它們可以被重新開立，若已產生對應的收支明細也一併刪除
payslipsRouter.delete('/:id', (req, res) => {
  const payslip = db.prepare('SELECT * FROM payslips WHERE id = ? AND school_id = ?').get(req.params.id, req.params.schoolId);
  if (!payslip) return res.status(404).json({ error: 'not found' });

  db.prepare('DELETE FROM ledger_entries WHERE related_payslip_id = ?').run(req.params.id);
  db.prepare('DELETE FROM payslips WHERE id = ?').run(req.params.id);

  broadcastChange(req.params.schoolId, 'finance');
  res.status(204).end();
});
