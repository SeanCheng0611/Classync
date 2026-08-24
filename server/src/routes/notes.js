import { Router } from 'express';
import { nanoid } from 'nanoid';
import { db, runInTransaction } from '../db/index.js';
import { requireMembership } from '../auth/middleware.js';
import { broadcastChange } from '../realtime/index.js';
import { addToTrash, captureNote } from '../services/trash.js';

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

function parseCategories(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed.filter((c) => typeof c === 'string' && c.trim()) : [];
  } catch {
    return [];
  }
}

function normalizeCategories(input) {
  if (!Array.isArray(input)) return [];
  const trimmed = input.map((c) => String(c).trim()).filter(Boolean);
  return Array.from(new Set(trimmed));
}

// 分類為自由文字、可複選（使用者可自訂新分類）；含「待辦」分類的記事優先顯示，其餘單純依日期排列
function serialize(row) {
  return { ...row, categories: parseCategories(row.categories) };
}

function sortNotes(rows) {
  return rows
    .map(serialize)
    .sort((a, b) => {
      const aTodo = a.categories.includes('待辦') ? 0 : 1;
      const bTodo = b.categories.includes('待辦') ? 0 : 1;
      if (aTodo !== bTodo) return aTodo - bTodo;
      if (a.note_date !== b.note_date) return a.note_date < b.note_date ? -1 : 1;
      return a.created_at < b.created_at ? -1 : 1;
    });
}

const DEFAULT_CATEGORIES = ['待辦', '學生', '教師', '生活', '雜項'];

function getRemovedDefaultCategories(schoolId) {
  const row = db.prepare('SELECT removed_default_categories FROM schools WHERE id = ?').get(schoolId);
  return parseCategories(row?.removed_default_categories);
}

// student_id/teacher_id：篩出跟某位學生/教師連結的記事，供學生/教師詳細頁的「相關記事」區塊使用
notesRouter.get('/', (req, res) => {
  const { q, student_id, teacher_id } = req.query;
  let rows;
  if (student_id) {
    rows = db.prepare(`${SELECT_WITH_JOINS} WHERE n.school_id = ? AND n.related_student_id = ?`).all(req.params.schoolId, student_id);
  } else if (teacher_id) {
    rows = db.prepare(`${SELECT_WITH_JOINS} WHERE n.school_id = ? AND n.related_teacher_id = ?`).all(req.params.schoolId, teacher_id);
  } else if (q) {
    rows = db
      .prepare(`${SELECT_WITH_JOINS} WHERE n.school_id = ? AND (n.content LIKE ? OR s.name LIKE ? OR t.name LIKE ?)`)
      .all(req.params.schoolId, `%${q}%`, `%${q}%`, `%${q}%`);
  } else {
    rows = db.prepare(`${SELECT_WITH_JOINS} WHERE n.school_id = ?`).all(req.params.schoolId);
  }
  res.json(sortNotes(rows));
});

// 分類清單（供前端下拉/自動完成、篩選使用）：未被刪除的預設分類在前，其餘依使用次數排序
notesRouter.get('/categories', (req, res) => {
  const rows = db.prepare('SELECT categories FROM notes WHERE school_id = ?').all(req.params.schoolId);
  const counts = new Map();
  for (const row of rows) {
    for (const c of parseCategories(row.categories)) {
      counts.set(c, (counts.get(c) || 0) + 1);
    }
  }
  const removedDefaults = new Set(getRemovedDefaultCategories(req.params.schoolId));
  const activeDefaults = DEFAULT_CATEGORIES.filter((c) => !removedDefaults.has(c));
  const usedExtras = [...counts.entries()]
    .filter(([c]) => !activeDefaults.includes(c))
    .sort((a, b) => b[1] - a[1])
    .map(([c]) => c);
  res.json([...activeDefaults, ...usedExtras]);
});

// 刪除分類：從所有記事的分類清單中移除該分類文字（不會刪除記事本身），
// 若移除後某則記事變成沒有分類，補上「未分類」以維持每則記事至少一個分類的限制；
// 若刪的是內建預設分類，記到 schools.removed_default_categories，避免下次又被強制補回選單
notesRouter.delete('/categories/:name', (req, res) => {
  const name = req.params.name.trim();
  if (!name) return res.status(400).json({ error: 'name required' });

  const rows = db.prepare('SELECT id, categories FROM notes WHERE school_id = ?').all(req.params.schoolId);
  const update = db.prepare(`UPDATE notes SET categories = ? WHERE id = ?`);

  const affected = [];
  for (const row of rows) {
    const current = parseCategories(row.categories);
    if (!current.includes(name)) continue;
    const remaining = current.filter((c) => c !== name);
    affected.push({ id: row.id, nextCategories: remaining.length > 0 ? remaining : ['未分類'] });
  }
  if (affected.length > 0) {
    runInTransaction(() => {
      for (const { id, nextCategories } of affected) update.run(JSON.stringify(nextCategories), id);
    });
  }

  if (DEFAULT_CATEGORIES.includes(name)) {
    const removedDefaults = new Set(getRemovedDefaultCategories(req.params.schoolId));
    removedDefaults.add(name);
    db.prepare('UPDATE schools SET removed_default_categories = ? WHERE id = ?').run(
      JSON.stringify([...removedDefaults]),
      req.params.schoolId
    );
  }

  broadcastChange(req.params.schoolId, 'notes');
  res.status(204).end();
});

notesRouter.post('/', (req, res) => {
  const { content, note_date, categories, done, related_student_id, related_teacher_id } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'content required' });
  const nextCategories = normalizeCategories(categories);
  if (nextCategories.length === 0) return res.status(400).json({ error: '請至少選擇一個分類' });

  const id = nanoid();
  db.prepare(
    `INSERT INTO notes (id, school_id, author_user_id, categories, done, content, note_date, related_student_id, related_teacher_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    req.params.schoolId,
    req.user.id,
    JSON.stringify(nextCategories),
    done ? 1 : 0,
    content.trim(),
    note_date || new Date().toISOString().slice(0, 10),
    related_student_id || null,
    related_teacher_id || null
  );

  broadcastChange(req.params.schoolId, 'notes');
  res.status(201).json(serialize(db.prepare(`${SELECT_WITH_JOINS} WHERE n.id = ?`).get(id)));
});

notesRouter.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM notes WHERE id = ? AND school_id = ?').get(req.params.id, req.params.schoolId);
  if (!existing) return res.status(404).json({ error: 'not found' });

  const {
    content = existing.content,
    note_date = existing.note_date,
    categories = parseCategories(existing.categories),
    done = !!existing.done,
    related_student_id = existing.related_student_id,
    related_teacher_id = existing.related_teacher_id,
  } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'content required' });
  const nextCategories = normalizeCategories(categories);
  if (nextCategories.length === 0) return res.status(400).json({ error: '請至少選擇一個分類' });

  db.prepare(
    `UPDATE notes SET content=?, note_date=?, categories=?, done=?, related_student_id=?, related_teacher_id=?, updated_at=datetime('now')
     WHERE id = ?`
  ).run(
    content.trim(),
    note_date,
    JSON.stringify(nextCategories),
    done ? 1 : 0,
    related_student_id || null,
    related_teacher_id || null,
    req.params.id
  );

  broadcastChange(req.params.schoolId, 'notes');
  res.json(serialize(db.prepare(`${SELECT_WITH_JOINS} WHERE n.id = ?`).get(req.params.id)));
});

notesRouter.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM notes WHERE id = ? AND school_id = ?').get(req.params.id, req.params.schoolId);
  if (!existing) return res.status(204).end();

  const label = existing.content.length > 30 ? `${existing.content.slice(0, 30)}...` : existing.content;
  addToTrash(req.params.schoolId, 'note', label, captureNote(req.params.id), req.user.id, {
    studentIds: existing.related_student_id ? [existing.related_student_id] : [],
    teacherId: existing.related_teacher_id || null,
  });

  db.prepare('DELETE FROM notes WHERE id = ? AND school_id = ?').run(req.params.id, req.params.schoolId);
  broadcastChange(req.params.schoolId, 'notes');
  res.status(204).end();
});
