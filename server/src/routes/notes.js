import { Router } from 'express';
import { nanoid } from 'nanoid';
import { db } from '../db/index.js';
import { requireMembership } from '../auth/middleware.js';
import { broadcastChange } from '../realtime/index.js';

export const notesRouter = Router({ mergeParams: true });
notesRouter.use(requireMembership(['admin']));

const SELECT_WITH_JOINS = `
  SELECT n.*, u.display_name as author_name,
         s.name as related_student_name, t.name as related_teacher_name
  FROM notes n
  LEFT JOIN users u ON u.id = n.author_user_id
  LEFT JOIN students s ON s.id = n.related_student_id
  LEFT JOIN teachers t ON t.id = n.related_teacher_id
`;

// 分類為自由文字（使用者可自訂新分類）；「待辦」分類優先顯示，其餘分類單純依日期排列
const ORDER_BY_CATEGORY_THEN_DATE =
  "ORDER BY CASE WHEN n.category = '待辦' THEN 0 ELSE 1 END, n.note_date ASC, n.created_at ASC";

notesRouter.get('/', (req, res) => {
  const { q } = req.query;
  const rows = q
    ? db
        .prepare(
          `${SELECT_WITH_JOINS} WHERE n.school_id = ? AND (n.content LIKE ? OR s.name LIKE ? OR t.name LIKE ?) ${ORDER_BY_CATEGORY_THEN_DATE}`
        )
        .all(req.params.schoolId, `%${q}%`, `%${q}%`, `%${q}%`)
    : db
        .prepare(`${SELECT_WITH_JOINS} WHERE n.school_id = ? ${ORDER_BY_CATEGORY_THEN_DATE}`)
        .all(req.params.schoolId);
  res.json(rows);
});

// 分類清單（供前端下拉/自動完成使用），依使用次數排序
notesRouter.get('/categories', (req, res) => {
  const rows = db
    .prepare(
      `SELECT category FROM notes WHERE school_id = ? GROUP BY category ORDER BY COUNT(*) DESC, MAX(created_at) DESC`
    )
    .all(req.params.schoolId);
  res.json(rows.map((r) => r.category));
});

notesRouter.post('/', (req, res) => {
  const { content, note_date, category, done, related_student_id, related_teacher_id } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'content required' });

  const id = nanoid();
  db.prepare(
    `INSERT INTO notes (id, school_id, author_user_id, category, done, content, note_date, related_student_id, related_teacher_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    req.params.schoolId,
    req.user.id,
    (category || '').trim() || '備註',
    done ? 1 : 0,
    content.trim(),
    note_date || new Date().toISOString().slice(0, 10),
    related_student_id || null,
    related_teacher_id || null
  );

  broadcastChange(req.params.schoolId, 'notes');
  res.status(201).json(db.prepare(`${SELECT_WITH_JOINS} WHERE n.id = ?`).get(id));
});

notesRouter.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM notes WHERE id = ? AND school_id = ?').get(req.params.id, req.params.schoolId);
  if (!existing) return res.status(404).json({ error: 'not found' });

  const {
    content = existing.content,
    note_date = existing.note_date,
    category = existing.category,
    done = !!existing.done,
    related_student_id = existing.related_student_id,
    related_teacher_id = existing.related_teacher_id,
  } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'content required' });
  const nextCategory = (category || '').trim() || '備註';

  db.prepare(
    `UPDATE notes SET content=?, note_date=?, category=?, done=?, related_student_id=?, related_teacher_id=?, updated_at=datetime('now')
     WHERE id = ?`
  ).run(content.trim(), note_date, nextCategory, done ? 1 : 0, related_student_id || null, related_teacher_id || null, req.params.id);

  broadcastChange(req.params.schoolId, 'notes');
  res.json(db.prepare(`${SELECT_WITH_JOINS} WHERE n.id = ?`).get(req.params.id));
});

notesRouter.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM notes WHERE id = ? AND school_id = ?').run(req.params.id, req.params.schoolId);
  broadcastChange(req.params.schoolId, 'notes');
  res.status(204).end();
});
