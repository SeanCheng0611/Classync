import { Router } from 'express';
import { nanoid } from 'nanoid';
import { db } from '../db/index.js';
import { financeRepository, teachersRepository, schedulingRepository } from '../repositories/index.js';
import { requireMembership } from '../auth/middleware.js';
import { broadcastChange } from '../realtime/index.js';
import { ensureSessionsForRange } from '../services/sessions.js';
import { monthRange, calcSessionPay } from '../services/finance.js';
import { addToTrash, capturePayslip } from '../services/trash.js';
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
// NOTE（Wave 3A）：橫跨 payslips + payslip_items 兩張表寫入，屬於 Wave 3B 範圍，
// 詳見 docs/FINANCE_TRANSACTION_INVENTORY.md 的「Create Payslip」項目，刻意沒有搬進 financeRepository。
payslipsRouter.post('/', (req, res) => {
  const { teacher_id, session_ids, note } = req.body;
  if (!teacher_id || !Array.isArray(session_ids) || session_ids.length === 0) {
    return res.status(400).json({ error: 'teacher_id and session_ids required' });
  }

  const teacher = db.prepare('SELECT * FROM teachers WHERE id = ? AND school_id = ?').get(teacher_id, req.params.schoolId);
  if (!teacher) return res.status(404).json({ error: 'teacher not found' });

  const today = db.prepare(`SELECT date('now') as d`).get().d;

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
    if (session.session_date > today) {
      return res.status(400).json({ error: `${session.session_date} ${session.subject} 尚未發生，無法開立薪資` });
    }
    const item = calcSessionPay(teacher, session);
    if (item.fully_on_leave) {
      const label = item.leave_is_makeup ? '已調課' : '已請假';
      return res.status(400).json({ error: `${session.session_date} ${session.subject}（${label}）無法計入薪資` });
    }
    if (item.not_yet_marked) {
      return res.status(400).json({ error: `${session.session_date} ${session.subject} 尚未點名，無法開立薪資` });
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
  logEvent({
    category: 'DATA_CHANGE', pageKey: PAGE_KEYS.PAYSLIPS, action: 'payslip.create',
    message: `開立薪資條（${teacher.name}）`, userId: req.user.id, schoolId: req.params.schoolId,
    entityType: 'payslip', entityId: payslipId, metadata: { item_count: items.length },
  });
  res.status(201).json(db.prepare('SELECT * FROM payslips WHERE id = ?').get(payslipId));
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
// NOTE（Wave 3A）：橫跨 payslips + ledger_entries 寫入，屬於 Wave 3B 範圍，刻意沒有搬進 financeRepository。
payslipsRouter.delete('/:id', (req, res) => {
  const payslip = db.prepare('SELECT * FROM payslips WHERE id = ? AND school_id = ?').get(req.params.id, req.params.schoolId);
  if (!payslip) return res.status(404).json({ error: 'not found' });

  const teacher = db.prepare('SELECT name FROM teachers WHERE id = ?').get(payslip.teacher_id);
  const label = `${teacher?.name || '未知教師'} ${payslip.issued_date} 薪資條`;
  addToTrash(req.params.schoolId, 'payslip', label, capturePayslip(req.params.id), req.user.id, { teacherId: payslip.teacher_id });

  db.prepare('DELETE FROM ledger_entries WHERE related_payslip_id = ?').run(req.params.id);
  db.prepare('DELETE FROM payslips WHERE id = ?').run(req.params.id);

  broadcastChange(req.params.schoolId, 'finance');
  logEvent({
    category: 'DATA_CHANGE', pageKey: PAGE_KEYS.PAYSLIPS, action: 'payslip.delete',
    message: `刪除薪資條「${label}」`, userId: req.user.id, schoolId: req.params.schoolId,
    entityType: 'payslip', entityId: req.params.id,
  });
  res.status(204).end();
});
