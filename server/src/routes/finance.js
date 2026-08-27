import { Router } from 'express';
import { nanoid } from 'nanoid';
import { financeRepository } from '../repositories/index.js';
import { requireMembership } from '../auth/middleware.js';
import { broadcastChange } from '../realtime/index.js';
import { calcTeacherSalary, calcAllTeachersSalary, calcStudentTuition, calcStudentTuitionForMonth, monthRange, shiftMonth } from '../services/finance.js';
import { ensureSessionsForRange } from '../services/sessions.js';
import { addToTrash, captureLedgerEntry } from '../services/trash.js';
import { logEvent } from '../services/auditLog.service.js';
import { PAGE_KEYS } from '../constants/pageKeys.js';

// 財務資料屬敏感資訊，整個模組僅管理者可存取
export const financeRouter = Router({ mergeParams: true });
financeRouter.use(requireMembership(['admin']));

financeRouter.get('/ledger', (req, res) => {
  const { start, end, category } = req.query;
  res.json(financeRepository.findLedgerEntries(req.params.schoolId, { start, end, category }));
});

financeRouter.get('/summary', (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end required' });

  const rows = financeRepository.findLedgerSummaryRows(req.params.schoolId, start, end);

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
  financeRepository.createLedgerEntry({
    id,
    schoolId: req.params.schoolId,
    entryType: entry_type,
    category: 'manual',
    amount,
    entryDate: entry_date,
    relatedStudentId: related_student_id,
    relatedTeacherId: related_teacher_id,
    note,
  });

  broadcastChange(req.params.schoolId, 'finance');
  logEvent({
    category: 'DATA_CHANGE', pageKey: PAGE_KEYS.FINANCE, action: 'ledger.create',
    message: `新增收支明細（${entry_type}）`, userId: req.user.id, schoolId: req.params.schoolId, entityType: 'ledger_entry', entityId: id,
  });
  res.status(201).json(financeRepository.findLedgerEntryById(req.params.schoolId, id));
});

// 編輯一筆已存在的收支明細（含自動產生的學費/薪資），用來填入實收/實付金額或修正日期、備註
financeRouter.put('/ledger/:id', (req, res) => {
  const existing = financeRepository.findLedgerEntryById(req.params.schoolId, req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  const { amount = existing.amount, entry_date = existing.entry_date, note = existing.note } = req.body;
  financeRepository.updateLedgerEntryFields(req.params.id, { amount, entryDate: entry_date, note });

  broadcastChange(req.params.schoolId, 'finance');
  logEvent({
    category: 'DATA_CHANGE', pageKey: PAGE_KEYS.FINANCE, action: 'ledger.update',
    message: '更新收支明細', userId: req.user.id, schoolId: req.params.schoolId, entityType: 'ledger_entry', entityId: req.params.id,
  });
  res.json(financeRepository.findLedgerEntryById(req.params.schoolId, req.params.id));
});

financeRouter.delete('/ledger/:id', (req, res) => {
  const existing = financeRepository.findLedgerEntryById(req.params.schoolId, req.params.id);
  if (!existing) return res.status(204).end();

  const label = `${existing.entry_date} ${existing.entry_type === 'income' ? '收入' : '支出'} ${existing.amount}${existing.note ? ` ${existing.note}` : ''}`;
  addToTrash(req.params.schoolId, 'ledger_entry', label, captureLedgerEntry(req.params.id), req.user.id, {
    studentIds: existing.related_student_id ? [existing.related_student_id] : [],
    teacherId: existing.related_teacher_id || null,
  });

  financeRepository.deleteLedgerEntry(req.params.schoolId, req.params.id);
  broadcastChange(req.params.schoolId, 'finance');
  logEvent({
    category: 'DATA_CHANGE', pageKey: PAGE_KEYS.FINANCE, action: 'ledger.delete',
    message: `刪除收支明細「${label}」`, userId: req.user.id, schoolId: req.params.schoolId, entityType: 'ledger_entry', entityId: req.params.id,
  });
  res.status(204).end();
});

// 某筆明細的逐堂課清單（薪資=該教師當月所有課堂；學費=該學生當月所有計價課堂，含學生/科目名稱）
financeRouter.get('/ledger/:id/detail', (req, res) => {
  const entry = financeRepository.findLedgerEntryById(req.params.schoolId, req.params.id);
  if (!entry) return res.status(404).json({ error: 'not found' });

  const month = entry.entry_date.slice(0, 7);
  const [start, end] = monthRange(month);

  if (entry.category === 'salary' && entry.related_payslip_id) {
    const items = financeRepository.findPayslipItemsWithSessionForLedgerDetail(entry.related_payslip_id);
    const withStudents = items.map((i) => {
      const names = financeRepository.findSessionStudentNames(i.class_session_id);
      return { ...i, student_names: names, is_admin: names.length === 0 };
    });
    return res.json(withStudents);
  }
  if (entry.category === 'salary' && entry.related_teacher_id) {
    return res.json(calcTeacherSalary(req.params.schoolId, entry.related_teacher_id, start, end).items);
  }
  if (entry.category === 'tuition' && entry.related_invoice_id) {
    return res.json(financeRepository.findInvoiceItemsWithSession(entry.related_invoice_id));
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

  const payslips = financeRepository.findPayslipsIssuedInRange(req.params.schoolId, start, end);

  const created = [];
  const updated = [];
  for (const payslip of payslips) {
    const note = `${month} 薪資 - ${payslip.teacher_name}`;
    const existing = financeRepository.findLedgerEntryByPayslip(req.params.schoolId, payslip.id);

    if (existing) {
      financeRepository.updateLedgerEntryAmountNote(existing.id, { amount: payslip.total_amount, note });
      updated.push(existing.id);
      continue;
    }

    const id = nanoid();
    financeRepository.createLedgerEntry({
      id,
      schoolId: req.params.schoolId,
      entryType: 'expense',
      category: 'salary',
      amount: payslip.total_amount,
      entryDate: payslip.issued_date,
      relatedTeacherId: payslip.teacher_id,
      relatedPayslipId: payslip.id,
      note,
    });
    created.push(id);
  }

  broadcastChange(req.params.schoolId, 'finance');
  logEvent({
    category: 'DATA_CHANGE', pageKey: PAGE_KEYS.FINANCE, action: 'ledger.generate_salary',
    message: `產生 ${month} 教師薪資支出`, userId: req.user.id, schoolId: req.params.schoolId,
    metadata: { month, created: created.length, updated: updated.length },
  });
  res.status(201).json({ created: created.length, updated: updated.length });
});

// 產生本月學費收入明細：讀取「本月開立」的繳費單（依 issued_date 所在月份），每張繳費單對應一筆收支明細。
// 若該繳費單已產生過明細，會同步更新金額（例如事後刪除繳費單裡的項目後金額變動），而不是略過不處理。
financeRouter.post('/generate-tuition', (req, res) => {
  const { month } = req.body;
  if (!month) return res.status(400).json({ error: 'month required (YYYY-MM)' });
  const [start, end] = monthRange(month);

  const invoices = financeRepository.findInvoicesIssuedInRange(req.params.schoolId, start, end);

  const created = [];
  const updated = [];
  for (const invoice of invoices) {
    if (!invoice.total_amount) continue;
    const note = `${month} 學費 - ${invoice.student_name}`;
    const existing = financeRepository.findLedgerEntryByInvoice(req.params.schoolId, invoice.id);

    if (existing) {
      financeRepository.updateLedgerEntryAmountNote(existing.id, { amount: invoice.total_amount, note });
      updated.push(existing.id);
      continue;
    }

    const id = nanoid();
    financeRepository.createLedgerEntry({
      id,
      schoolId: req.params.schoolId,
      entryType: 'income',
      category: 'tuition',
      amount: invoice.total_amount,
      entryDate: invoice.issued_date,
      relatedStudentId: invoice.student_id,
      relatedInvoiceId: invoice.id,
      note,
    });
    created.push(id);
  }

  broadcastChange(req.params.schoolId, 'finance');
  logEvent({
    category: 'DATA_CHANGE', pageKey: PAGE_KEYS.FINANCE, action: 'ledger.generate_tuition',
    message: `產生 ${month} 學費收入`, userId: req.user.id, schoolId: req.params.schoolId,
    metadata: { month, created: created.length, updated: updated.length },
  });
  res.status(201).json({ created: created.length, updated: updated.length });
});
