import { Router } from 'express';
import { nanoid } from 'nanoid';
import { teachersRepository } from '../repositories/index.js';
import { requireMembership } from '../auth/middleware.js';
import { broadcastChange } from '../realtime/index.js';
import { calcTeacherSalary } from '../services/finance.js';
import { ensureSessionsForRange } from '../services/sessions.js';
import { addToTrash, captureTeacher } from '../services/trash.js';
import { sortByName } from '../services/nameSort.js';
import { logEvent } from '../services/auditLog.service.js';
import { PAGE_KEYS } from '../constants/pageKeys.js';

export const teachersRouter = Router({ mergeParams: true });
teachersRouter.use(requireMembership());

function serialize(row) {
  return { ...row, subjects: JSON.parse(row.subjects || '[]'), flexible_schedule: JSON.parse(row.flexible_schedule || '{}') };
}

const HHMM_RE = /^\d{2}:\d{2}$/;

// 彈性上課時段涵蓋一週七天（0=日 ~ 6=六），每天最多一段起訖時間；忽略格式不對或起訖顛倒的天數
function normalizeFlexibleSchedule(input) {
  if (!input || typeof input !== 'object') return {};
  const result = {};
  for (let weekday = 0; weekday <= 6; weekday++) {
    const slot = input[weekday] ?? input[String(weekday)];
    if (!slot) continue;
    const start = typeof slot.start === 'string' ? slot.start.trim() : '';
    const end = typeof slot.end === 'string' ? slot.end.trim() : '';
    if (!HHMM_RE.test(start) || !HHMM_RE.test(end) || end <= start) continue;
    result[weekday] = { start, end };
  }
  return result;
}

// 教師只能查看自己的教師檔案（唯讀），管理者可查看全部
// 依姓名筆劃排序，不用加入時間；前端列表的「編號」欄位依這個順序從 1 編起，純顯示用不寫回資料庫
teachersRouter.get('/', (req, res) => {
  const rows =
    req.membership.role !== 'teacher'
      ? teachersRepository.findAllBySchool(req.params.schoolId)
      : teachersRepository.findAllBySchoolAndId(req.params.schoolId, req.membership.teacher_id);
  res.json(sortByName(rows).map(serialize));
});

teachersRouter.get('/:id', (req, res) => {
  const row = teachersRepository.findById(req.params.schoolId, req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (req.membership.role === 'teacher' && row.id !== req.membership.teacher_id) {
    return res.status(403).json({ error: 'forbidden' });
  }
  res.json(serialize(row));
});

// 該教師在區間內的課堂（含行政課堂）與對應薪資明細，給教師詳細頁的課堂明細/薪資試算用
// 這是薪資計算資料（金額/時薪），不屬於櫃台（front_desk）的五項子系統範圍，僅管理者或教師本人可查看
teachersRouter.get('/:id/sessions', (req, res) => {
  const teacher = teachersRepository.findById(req.params.schoolId, req.params.id);
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
    name,
    subjects,
    rate_grade_1_6,
    rate_grade_7_9,
    rate_grade_10_12,
    rate_admin,
    note,
    flexible_schedule,
  } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  // 姓名重複不擋，只在回傳結果中提醒（前端匯入/新增流程改成在送出前先跳視窗詢問，這裡只當保險）
  const dupName = teachersRepository.findByName(req.params.schoolId, name);

  const id = nanoid();
  teachersRepository.create({
    id,
    schoolId: req.params.schoolId,
    name,
    subjects: subjects || [],
    rateGrade1to6: rate_grade_1_6 || 0,
    rateGrade7to9: rate_grade_7_9 || 0,
    rateGrade10to12: rate_grade_10_12 || 0,
    rateAdmin: rate_admin || 0,
    note: note || null,
    flexibleSchedule: normalizeFlexibleSchedule(flexible_schedule),
  });

  broadcastChange(req.params.schoolId, 'teachers');
  logEvent({
    category: 'DATA_CHANGE', pageKey: PAGE_KEYS.TEACHERS, action: 'teacher.create',
    message: `新增教師「${name}」`, userId: req.user.id, schoolId: req.params.schoolId, entityType: 'teacher', entityId: id,
  });
  res.status(201).json({ ...serialize(teachersRepository.findById(req.params.schoolId, id)), duplicate_name: !!dupName });
});

teachersRouter.put('/:id', requireMembership(['admin', 'front_desk']), (req, res) => {
  const existing = teachersRepository.findById(req.params.schoolId, req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  const {
    name = existing.name,
    subjects = JSON.parse(existing.subjects),
    rate_grade_1_6 = existing.rate_grade_1_6,
    rate_grade_7_9 = existing.rate_grade_7_9,
    rate_grade_10_12 = existing.rate_grade_10_12,
    rate_admin = existing.rate_admin,
    note = existing.note,
    status = existing.status,
    flexible_schedule = JSON.parse(existing.flexible_schedule || '{}'),
  } = req.body;

  const dupName = teachersRepository.findByName(req.params.schoolId, name, req.params.id);

  teachersRepository.update(req.params.id, {
    name,
    subjects,
    rateGrade1to6: rate_grade_1_6,
    rateGrade7to9: rate_grade_7_9,
    rateGrade10to12: rate_grade_10_12,
    rateAdmin: rate_admin,
    note,
    status,
    flexibleSchedule: normalizeFlexibleSchedule(flexible_schedule),
  });

  broadcastChange(req.params.schoolId, 'teachers');
  logEvent({
    category: 'DATA_CHANGE', pageKey: PAGE_KEYS.TEACHERS, action: 'teacher.update',
    message: `更新教師「${name}」`, userId: req.user.id, schoolId: req.params.schoolId, entityType: 'teacher', entityId: req.params.id,
  });
  res.json({ ...serialize(teachersRepository.findById(req.params.schoolId, req.params.id)), duplicate_name: !!dupName });
});

// 彈性上課時段是教師唯一可以自己修改的欄位：管理者/櫃台可改任何教師，教師本人只能改自己的
teachersRouter.put('/:id/flexible-schedule', requireMembership(['admin', 'front_desk', 'teacher']), (req, res) => {
  if (req.membership.role === 'teacher' && req.membership.teacher_id !== req.params.id) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const existing = teachersRepository.findById(req.params.schoolId, req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  const flexibleSchedule = normalizeFlexibleSchedule(req.body.flexible_schedule);
  teachersRepository.updateFlexibleSchedule(req.params.id, flexibleSchedule);

  broadcastChange(req.params.schoolId, 'teachers');
  res.json(serialize(teachersRepository.findById(req.params.schoolId, req.params.id)));
});

teachersRouter.delete('/:id', requireMembership(['admin', 'front_desk']), (req, res) => {
  const existing = teachersRepository.findById(req.params.schoolId, req.params.id);
  if (!existing) return res.status(204).end();

  addToTrash(req.params.schoolId, 'teacher', existing.name, captureTeacher(req.params.id), req.user.id);

  teachersRepository.delete(req.params.schoolId, req.params.id);
  broadcastChange(req.params.schoolId, 'teachers');
  logEvent({
    category: 'DATA_CHANGE', pageKey: PAGE_KEYS.TEACHERS, action: 'teacher.delete',
    message: `刪除教師「${existing.name}」`, userId: req.user.id, schoolId: req.params.schoolId, entityType: 'teacher', entityId: req.params.id,
  });
  res.status(204).end();
});
