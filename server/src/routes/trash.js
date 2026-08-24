import { Router } from 'express';
import { db } from '../db/index.js';
import { requireMembership } from '../auth/middleware.js';
import { broadcastChange } from '../realtime/index.js';
import { restoreEntity } from '../services/trash.js';

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
  const rows = db
    .prepare(
      `SELECT t.*, u.display_name as deleted_by_name FROM trash t
       LEFT JOIN users u ON u.id = t.deleted_by
       WHERE t.school_id = ? ORDER BY t.deleted_at DESC`
    )
    .all(req.params.schoolId);
  const filtered = rows.filter((r) => {
    if (types && !types.includes(r.entity_type)) return false;
    if (teacher_id && r.related_teacher_id !== teacher_id) return false;
    if (student_id && !JSON.parse(r.related_student_ids || '[]').includes(student_id)) return false;
    return true;
  });
  res.json(filtered.map((r) => ({ ...r, payload: undefined })));
});

trashRouter.post('/:id/restore', (req, res) => {
  const row = db.prepare('SELECT * FROM trash WHERE id = ? AND school_id = ?').get(req.params.id, req.params.schoolId);
  if (!row) return res.status(404).json({ error: 'not found' });

  try {
    restoreEntity(row.entity_type, JSON.parse(row.payload));
  } catch (err) {
    return res.status(409).json({ error: '復原失敗，可能是關聯資料已不存在或衝突：' + err.message });
  }
  db.prepare('DELETE FROM trash WHERE id = ?').run(req.params.id);

  broadcastChange(req.params.schoolId, 'trash');
  for (const resource of AFFECTED_RESOURCES[row.entity_type] || []) broadcastChange(req.params.schoolId, resource);
  res.status(204).end();
});

// 永久刪除（清空單筆回收桶項目，不還原）
trashRouter.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM trash WHERE id = ? AND school_id = ?').run(req.params.id, req.params.schoolId);
  broadcastChange(req.params.schoolId, 'trash');
  res.status(204).end();
});
