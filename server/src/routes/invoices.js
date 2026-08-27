import { Router } from 'express';
import { financeRepository, studentsRepository } from '../repositories/index.js';
import { requireMembership } from '../auth/middleware.js';
import { broadcastChange } from '../realtime/index.js';
import { ensureSessionsForRange } from '../services/sessions.js';
import { monthRange, createInvoice, deleteInvoice, FinanceError } from '../services/finance.js';
import { logEvent } from '../services/auditLog.service.js';
import { PAGE_KEYS } from '../constants/pageKeys.js';

export const invoicesRouter = Router({ mergeParams: true });
invoicesRouter.use(requireMembership(['admin']));

// 該學生某月的課堂清單（含出缺勤狀態與是否已開立過繳費單），供開立繳費單頁勾選用
invoicesRouter.get('/sessions', (req, res) => {
  const { student_id, month } = req.query;
  if (!student_id || !month) return res.status(400).json({ error: 'student_id and month required' });

  const student = studentsRepository.findById(req.params.schoolId, student_id);
  if (!student) return res.status(404).json({ error: 'student not found' });

  const [start, end] = monthRange(month);
  ensureSessionsForRange(req.params.schoolId, start, end);

  const rows = financeRepository.findInvoiceableSessionsForStudent(req.params.schoolId, student_id, start, end);
  res.json(rows.map((r) => ({ ...r, invoiced: !!r.invoiced })));
});

// 某學生已開立的繳費單列表
invoicesRouter.get('/', (req, res) => {
  const { student_id } = req.query;
  if (!student_id) return res.status(400).json({ error: 'student_id required' });

  res.json(financeRepository.findInvoicesByStudent(req.params.schoolId, student_id));
});

// 開立繳費單：從指定的課堂（須為該學生、尚未開立過）挑選建立，可跨月；不論日期到了沒或出缺勤狀態都能開立
//
// Wave 3B：驗證 + 寫入（invoices + invoice_items）都在 financeService.createInvoice 裡的同一個
// transaction 完成，中途任何失敗都不會留下 invoice 存在但 items 不完整的 partial state。
invoicesRouter.post('/', (req, res) => {
  const { student_id, session_ids, note } = req.body;
  let result;
  try {
    result = createInvoice(req.params.schoolId, { studentId: student_id, sessionIds: session_ids, note });
  } catch (err) {
    if (err instanceof FinanceError) return res.status(err.status).json({ error: err.message });
    throw err;
  }

  broadcastChange(req.params.schoolId, 'finance');
  logEvent({
    category: 'DATA_CHANGE', pageKey: PAGE_KEYS.INVOICES, action: 'invoice.create',
    message: `開立繳費單（${result.studentName}）`, userId: req.user.id, schoolId: req.params.schoolId,
    entityType: 'invoice', entityId: result.invoiceId, metadata: { item_count: result.itemCount, total: result.total },
  });
  res.status(201).json(financeRepository.findInvoiceById(req.params.schoolId, result.invoiceId));
});

// 單張繳費單明細（逐堂課清單）
invoicesRouter.get('/:id', (req, res) => {
  const invoice = financeRepository.findInvoiceById(req.params.schoolId, req.params.id);
  if (!invoice) return res.status(404).json({ error: 'not found' });

  const items = financeRepository.findInvoiceItemsWithSession(req.params.id);
  res.json({ ...invoice, items });
});

// 刪除繳費單：釋放其中的課堂讓它們可以被重新開立，若已產生對應的收支明細也一併刪除
//
// Wave 3B：trash capture + ledger 刪除 + invoice 刪除都在 financeService.deleteInvoice 的同一個
// transaction 完成；trash 寫入用 insertTrashRow（不 broadcast），避免半途 rollback 時已經先廣播「東西被刪了」。
invoicesRouter.delete('/:id', (req, res) => {
  let result;
  try {
    result = deleteInvoice(req.params.schoolId, req.params.id, req.user.id);
  } catch (err) {
    if (err instanceof FinanceError) return res.status(err.status).json({ error: err.message });
    throw err;
  }

  broadcastChange(req.params.schoolId, 'trash');
  broadcastChange(req.params.schoolId, 'finance');
  logEvent({
    category: 'DATA_CHANGE', pageKey: PAGE_KEYS.INVOICES, action: 'invoice.delete',
    message: `刪除繳費單「${result.label}」`, userId: req.user.id, schoolId: req.params.schoolId,
    entityType: 'invoice', entityId: req.params.id,
  });
  res.status(204).end();
});
