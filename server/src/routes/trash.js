import { Router } from 'express';
import { trashRepository } from '../repositories/index.js';
import { requireMembership } from '../auth/middleware.js';
import { broadcastChange } from '../realtime/index.js';
import { restoreTrashEntry } from '../services/trash.js';

export const trashRouter = Router({ mergeParams: true });
// 回收桶匯集所有刪除操作（含只有管理者能看的財務資料如繳費單/收支明細），統一僅開放管理者查看與復原
trashRouter.use(requireMembership(['admin']));

// 復原後會連動改變的頁面資源，依 entity_type 決定要 broadcast 哪些，讓其他裝置即時重新拉取
const AFFECTED_RESOURCES = {
  note: ['notes'],
  teacher: ['teachers', 'schedule', 'sessions', 'finance'],
  student: ['students', 'schedule', 'sessions', 'finance', 'seats'],
  session: ['sessions', 'schedule'],
  session_cancelled: ['sessions', 'schedule'],
  schedule_template: ['schedule', 'sessions'],
  ledger_entry: ['finance'],
  payslip: ['finance'],
  invoice: ['finance'],
  tuition_record: ['finance'],
  membership: ['members'],
  invite_code: ['members'],
};

// 每個子系統頁面（或學生/教師詳細頁）各自一個獨立回收桶頁面：
// ?types=a,b,c 只拉相關的 entity_type；?student_id= / ?teacher_id= 進一步篩成「只跟這個人有關」
trashRouter.get('/', (req, res) => {
  const types = req.query.types ? String(req.query.types).split(',').filter(Boolean) : null;
  const { student_id, teacher_id } = req.query;
  const rows = trashRepository.findAllBySchool(req.params.schoolId);
  const filtered = rows.filter((r) => {
    if (types && !types.includes(r.entity_type)) return false;
    if (teacher_id && r.related_teacher_id !== teacher_id) return false;
    if (student_id && !JSON.parse(r.related_student_ids || '[]').includes(student_id)) return false;
    return true;
  });
  res.json(filtered.map((r) => ({ ...r, payload: undefined })));
});

// 還原 + 刪掉 trash 這一列是同一個 transaction（見 services/trash.js 的 restoreTrashEntry），
// 任何一步失敗都會整個回滾，不會出現「還原了一半」的狀態
trashRouter.post('/:id/restore', (req, res) => {
  let row;
  try {
    row = restoreTrashEntry(req.params.schoolId, req.params.id);
  } catch (err) {
    return res.status(409).json({ error: '復原失敗，可能是關聯資料已不存在或衝突：' + err.message });
  }
  if (!row) return res.status(404).json({ error: 'not found' });

  broadcastChange(req.params.schoolId, 'trash');
  for (const resource of AFFECTED_RESOURCES[row.entity_type] || []) broadcastChange(req.params.schoolId, resource);
  res.status(204).end();
});

// 永久刪除（清空單筆回收桶項目，不還原）：單一資料表單筆 DELETE，本身就是原子操作，不需要額外 transaction
trashRouter.delete('/:id', (req, res) => {
  trashRepository.deleteByIdScoped(req.params.schoolId, req.params.id);
  broadcastChange(req.params.schoolId, 'trash');
  res.status(204).end();
});
