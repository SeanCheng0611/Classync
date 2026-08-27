import { Router } from 'express';
import { financeRepository, teachersRepository, schedulingRepository } from '../repositories/index.js';
import { requireMembership } from '../auth/middleware.js';
import { broadcastChange } from '../realtime/index.js';
import { ensureSessionsForRange } from '../services/sessions.js';
import { monthRange, calcSessionPay, createPayslip, deletePayslip, FinanceError } from '../services/finance.js';
import { logEvent } from '../services/auditLog.service.js';
import { PAGE_KEYS } from '../constants/pageKeys.js';

export const payslipsRouter = Router({ mergeParams: true });
payslipsRouter.use(requireMembership(['admin']));

// 該教師某月的課堂清單（含試算金額與是否已開立過薪資條），供開立薪資條頁勾選用
payslipsRouter.get('/sessions', (req, res) => {
  const { teacher_id, month } = req.query;
  if (!teacher_id || !month) return res.status(400).json({ error: 'teacher_id and month required' });

  const teacher = teachersRepository.findById(req.params.schoolId, teacher_id);
  if (!teacher) return res.status(404).json({ error: 'teacher not found' });

  const [start, end] = monthRange(month);
  ensureSessionsForRange(req.params.schoolId, start, end);

  const sessions = schedulingRepository.findSessionsByTeacherAndDateRange(req.params.schoolId, teacher_id, start, end);

  const rows = sessions.map((session) => {
    const pay = calcSessionPay(teacher, session);
    const issued = financeRepository.hasPayslipItemForSession(session.id);
    return { ...pay, issued };
  });

  res.json(rows);
});

// 某教師已開立的薪資條列表
payslipsRouter.get('/', (req, res) => {
  const { teacher_id } = req.query;
  if (!teacher_id) return res.status(400).json({ error: 'teacher_id required' });

  res.json(financeRepository.findPayslipsByTeacher(req.params.schoolId, teacher_id));
});

// 開立薪資條：從指定的課堂（須屬於該教師、尚未開立過）挑選建立，可跨月
//
// Wave 3B：驗證（含「未來日期不可開薪資」規則）+ 寫入（payslips + payslip_items）都在
// financeService.createPayslip 裡的同一個 transaction 完成，任何失敗都不留下 partial state。
payslipsRouter.post('/', (req, res) => {
  const { teacher_id, session_ids, note } = req.body;
  let result;
  try {
    result = createPayslip(req.params.schoolId, { teacherId: teacher_id, sessionIds: session_ids, note });
  } catch (err) {
    if (err instanceof FinanceError) return res.status(err.status).json({ error: err.message });
    throw err;
  }

  broadcastChange(req.params.schoolId, 'finance');
  logEvent({
    category: 'DATA_CHANGE', pageKey: PAGE_KEYS.PAYSLIPS, action: 'payslip.create',
    message: `開立薪資條（${result.teacherName}）`, userId: req.user.id, schoolId: req.params.schoolId,
    entityType: 'payslip', entityId: result.payslipId, metadata: { item_count: result.itemCount },
  });
  res.status(201).json(financeRepository.findPayslipById(req.params.schoolId, result.payslipId));
});

// 單張薪資條明細（逐堂課清單）
payslipsRouter.get('/:id', (req, res) => {
  const payslip = financeRepository.findPayslipById(req.params.schoolId, req.params.id);
  if (!payslip) return res.status(404).json({ error: 'not found' });

  const items = financeRepository.findPayslipItemsWithSession(req.params.id);
  const withStudents = items.map((i) => {
    const names = financeRepository.findSessionStudentNames(i.session_id);
    return { ...i, student_names: names, is_admin: names.length === 0 };
  });

  res.json({ ...payslip, items: withStudents });
});

// 刪除薪資條：釋放其中的課堂讓它們可以被重新開立，若已產生對應的收支明細也一併刪除
//
// Wave 3B：trash capture + ledger 刪除 + payslip 刪除都在 financeService.deletePayslip 的同一個
// transaction 完成；trash 寫入用 insertTrashRow（不 broadcast），避免半途 rollback 時已經先廣播「東西被刪了」。
payslipsRouter.delete('/:id', (req, res) => {
  let result;
  try {
    result = deletePayslip(req.params.schoolId, req.params.id, req.user.id);
  } catch (err) {
    if (err instanceof FinanceError) return res.status(err.status).json({ error: err.message });
    throw err;
  }

  broadcastChange(req.params.schoolId, 'trash');
  broadcastChange(req.params.schoolId, 'finance');
  logEvent({
    category: 'DATA_CHANGE', pageKey: PAGE_KEYS.PAYSLIPS, action: 'payslip.delete',
    message: `刪除薪資條「${result.label}」`, userId: req.user.id, schoolId: req.params.schoolId,
    entityType: 'payslip', entityId: req.params.id,
  });
  res.status(204).end();
});
