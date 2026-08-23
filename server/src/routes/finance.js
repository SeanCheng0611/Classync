import { Router } from 'express';
import { nanoid } from 'nanoid';
import { db } from '../db/index.js';
import { requireMembership } from '../auth/middleware.js';
import { broadcastChange } from '../realtime/index.js';
import { calcTeacherSalary, calcAllTeachersSalary, calcStudentTuition, calcStudentTuitionForMonth, monthRange, shiftMonth } from '../services/finance.js';
import { ensureSessionsForRange } from '../services/sessions.js';

// 財務資料屬敏感資訊，整個模組僅管理者可存取
export const financeRouter = Router({ mergeParams: true });
financeRouter.use(requireMembership(['admin']));

financeRouter.get('/ledger', (req, res) => {
  const { start, end, category } = req.query;
  let sql = 'SELECT * FROM ledger_entries WHERE school_id = ?';
  const params = [req.params.schoolId];
  if (start) {
    sql += ' AND entry_date >= ?';
    params.push(start);
  }
  if (end) {
    sql += ' AND entry_date < ?';
    params.push(end);
  }
  if (category) {
    sql += ' AND category = ?';
    params.push(category);
  }
  sql += ' ORDER BY entry_date DESC, created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

financeRouter.get('/summary', (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end required' });

  const rows = db
    .prepare(
      `SELECT entry_type, category, SUM(amount) as total FROM ledger_entries
       WHERE school_id = ? AND entry_date >= ? AND entry_date < ?
       GROUP BY entry_type, category`
    )
    .all(req.params.schoolId, start, end);

  const income = rows.filter((r) => r.entry_type === 'income').reduce((s, r) => s + r.total, 0);
  const expense = rows.filter((r) => r.entry_type === 'expense').reduce((s, r) => s + r.total, 0);
  res.json({ income, expense, net: income - expense, by_category: rows });
});

financeRouter.post('/ledger', (req, res) => {
  const { entry_type, amount, entry_date, note, related_student_id, related_teacher_id } = req.body;
  if (!entry_type || !amount || !entry_date) {
    return res.status(400).json({ error: 'entry_type, amount, entry_date required' });
  }
  if (!['income', 'expense'].includes(entry_type)) {
    return res.status(400).json({ error: 'invalid entry_type' });
  }

  const id = nanoid();
  db.prepare(
    `INSERT INTO ledger_entries (id, school_id, entry_type, category, amount, entry_date, related_student_id, related_teacher_id, note)
     VALUES (?, ?, ?, 'manual', ?, ?, ?, ?, ?)`
  ).run(id, req.params.schoolId, entry_type, amount, entry_date, related_student_id || null, related_teacher_id || null, note || null);

  broadcastChange(req.params.schoolId, 'finance');
  res.status(201).json(db.prepare('SELECT * FROM ledger_entries WHERE id = ?').get(id));
});

// 編輯一筆已存在的收支明細（含自動產生的學費/薪資），用來填入實收/實付金額或修正日期、備註
financeRouter.put('/ledger/:id', (req, res) => {
  const existing = db
    .prepare('SELECT * FROM ledger_entries WHERE id = ? AND school_id = ?')
    .get(req.params.id, req.params.schoolId);
  if (!existing) return res.status(404).json({ error: 'not found' });

  const { amount = existing.amount, entry_date = existing.entry_date, note = existing.note } = req.body;
  db.prepare('UPDATE ledger_entries SET amount = ?, entry_date = ?, note = ? WHERE id = ?').run(
    amount,
    entry_date,
    note,
    req.params.id
  );

  broadcastChange(req.params.schoolId, 'finance');
  res.json(db.prepare('SELECT * FROM ledger_entries WHERE id = ?').get(req.params.id));
});

financeRouter.delete('/ledger/:id', (req, res) => {
  db.prepare('DELETE FROM ledger_entries WHERE id = ? AND school_id = ?').run(req.params.id, req.params.schoolId);
  broadcastChange(req.params.schoolId, 'finance');
  res.status(204).end();
});

// 某筆明細的逐堂課清單（薪資=該教師當月所有課堂；學費=該學生當月所有計價課堂，含學生/科目名稱）
financeRouter.get('/ledger/:id/detail', (req, res) => {
  const entry = db
    .prepare('SELECT * FROM ledger_entries WHERE id = ? AND school_id = ?')
    .get(req.params.id, req.params.schoolId);
  if (!entry) return res.status(404).json({ error: 'not found' });

  const month = entry.entry_date.slice(0, 7);
  const [start, end] = monthRange(month);

  if (entry.category === 'salary' && entry.related_payslip_id) {
    const items = db
      .prepare(
        `SELECT pi.id as session_id, pi.session_id as class_session_id, pi.hours, pi.rate, pi.pay, cs.session_date, cs.subject, cs.type,
                origin.session_date as origin_session_date, origin.start_slot as origin_start_slot
         FROM payslip_items pi JOIN class_sessions cs ON cs.id = pi.session_id
         LEFT JOIN class_sessions origin ON origin.id = cs.origin_session_id
         WHERE pi.payslip_id = ? ORDER BY cs.session_date`
      )
      .all(entry.related_payslip_id);
    const withStudents = items.map((i) => {
      const students = db
        .prepare(`SELECT s.name FROM session_students ss JOIN students s ON s.id = ss.student_id WHERE ss.session_id = ?`)
        .all(i.class_session_id);
      return { ...i, student_names: students.map((s) => s.name), is_admin: students.length === 0 };
    });
    return res.json(withStudents);
  }
  if (entry.category === 'salary' && entry.related_teacher_id) {
    return res.json(calcTeacherSalary(req.params.schoolId, entry.related_teacher_id, start, end).items);
  }
  if (entry.category === 'tuition' && entry.related_invoice_id) {
    const items = db
      .prepare(
        `SELECT ii.id as session_id, cs.session_date, cs.subject, cs.type, ii.unit_price,
                origin.session_date as origin_session_date, origin.start_slot as origin_start_slot
         FROM invoice_items ii JOIN class_sessions cs ON cs.id = ii.session_id
         LEFT JOIN class_sessions origin ON origin.id = cs.origin_session_id
         WHERE ii.invoice_id = ? ORDER BY cs.session_date`
      )
      .all(entry.related_invoice_id);
    return res.json(items);
  }
  if (entry.category === 'tuition' && entry.related_student_id) {
    const items = calcStudentTuition(req.params.schoolId, entry.related_student_id, start, end).items;
    const calc = calcStudentTuitionForMonth(req.params.schoolId, entry.related_student_id, month);
    if (calc.rollover_amount > 0) {
      const prevMonth = shiftMonth(month, -1);
      items.unshift({
        session_id: 'rollover',
        session_date: null,
        subject: `由 ${prevMonth} 併入`,
        unit_price: calc.rollover_amount,
      });
    }
    return res.json(items);
  }
  res.json([]);
});

// 試算某教師（或全體）在指定月份的薪資明細，不寫入資料庫，供產生前先核對
financeRouter.get('/salary-preview', (req, res) => {
  const { month, teacher_id } = req.query;
  if (!month) return res.status(400).json({ error: 'month required (YYYY-MM)' });
  const [start, end] = monthRange(month);
  ensureSessionsForRange(req.params.schoolId, start, end);

  if (teacher_id) {
    res.json([{ teacher_id, ...calcTeacherSalary(req.params.schoolId, teacher_id, start, end) }]);
  } else {
    res.json(calcAllTeachersSalary(req.params.schoolId, start, end));
  }
});

// 產生本月教師薪資支出：讀取「本月開立」的薪資條（依 issued_date 所在月份），每張薪資條對應一筆收支明細。
// 若該薪資條已產生過明細，會同步更新金額（例如事後刪除薪資條裡的項目後金額變動），而不是略過不處理。
financeRouter.post('/generate-salary', (req, res) => {
  const { month } = req.body;
  if (!month) return res.status(400).json({ error: 'month required (YYYY-MM)' });
  const [start, end] = monthRange(month);

  const payslips = db
    .prepare(
      `SELECT p.*, t.name as teacher_name FROM payslips p
       JOIN teachers t ON t.id = p.teacher_id
       WHERE p.school_id = ? AND p.issued_date >= ? AND p.issued_date < ?`
    )
    .all(req.params.schoolId, start, end);

  const created = [];
  const updated = [];
  for (const payslip of payslips) {
    const note = `${month} 薪資 - ${payslip.teacher_name}（薪資條 ${payslip.issued_date}）`;
    const existing = db
      .prepare(`SELECT id FROM ledger_entries WHERE school_id = ? AND category = 'salary' AND related_payslip_id = ?`)
      .get(req.params.schoolId, payslip.id);

    if (existing) {
      db.prepare('UPDATE ledger_entries SET amount = ?, note = ? WHERE id = ?').run(payslip.total_amount, note, existing.id);
      updated.push(existing.id);
      continue;
    }

    const id = nanoid();
    db.prepare(
      `INSERT INTO ledger_entries (id, school_id, entry_type, category, amount, entry_date, related_teacher_id, related_payslip_id, note)
       VALUES (?, ?, 'expense', 'salary', ?, ?, ?, ?, ?)`
    ).run(id, req.params.schoolId, payslip.total_amount, payslip.issued_date, payslip.teacher_id, payslip.id, note);
    created.push(id);
  }

  broadcastChange(req.params.schoolId, 'finance');
  res.status(201).json({ created: created.length, updated: updated.length });
});

// 產生本月學費收入明細：讀取「本月開立」的繳費單（依 issued_date 所在月份），每張繳費單對應一筆收支明細。
// 若該繳費單已產生過明細，會同步更新金額（例如事後刪除繳費單裡的項目後金額變動），而不是略過不處理。
financeRouter.post('/generate-tuition', (req, res) => {
  const { month } = req.body;
  if (!month) return res.status(400).json({ error: 'month required (YYYY-MM)' });
  const [start, end] = monthRange(month);

  const invoices = db
    .prepare(
      `SELECT inv.*, s.name as student_name FROM invoices inv
       JOIN students s ON s.id = inv.student_id
       WHERE inv.school_id = ? AND inv.issued_date >= ? AND inv.issued_date < ?`
    )
    .all(req.params.schoolId, start, end);

  const created = [];
  const updated = [];
  for (const invoice of invoices) {
    if (!invoice.total_amount) continue;
    const note = `${month} 學費 - ${invoice.student_name}（繳費單 ${invoice.issued_date}）`;
    const existing = db
      .prepare(`SELECT id FROM ledger_entries WHERE school_id = ? AND category = 'tuition' AND related_invoice_id = ?`)
      .get(req.params.schoolId, invoice.id);

    if (existing) {
      db.prepare('UPDATE ledger_entries SET amount = ?, note = ? WHERE id = ?').run(invoice.total_amount, note, existing.id);
      updated.push(existing.id);
      continue;
    }

    const id = nanoid();
    db.prepare(
      `INSERT INTO ledger_entries (id, school_id, entry_type, category, amount, entry_date, related_student_id, related_invoice_id, note)
       VALUES (?, ?, 'income', 'tuition', ?, ?, ?, ?, ?)`
    ).run(id, req.params.schoolId, invoice.total_amount, invoice.issued_date, invoice.student_id, invoice.id, note);
    created.push(id);
  }

  broadcastChange(req.params.schoolId, 'finance');
  res.status(201).json({ created: created.length, updated: updated.length });
});
