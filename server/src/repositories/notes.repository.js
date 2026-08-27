import { db, runInTransaction } from '../db/index.js';

const SELECT_WITH_JOINS = `
  SELECT n.*, u.display_name as author_name,
         s.name as related_student_name, t.name as related_teacher_name
  FROM notes n
  LEFT JOIN users u ON u.id = n.author_user_id
  LEFT JOIN students s ON s.id = n.related_student_id
  LEFT JOIN teachers t ON t.id = n.related_teacher_id
`;

export const notesRepository = {
  findAllBySchool(schoolId) {
    return db.prepare(`${SELECT_WITH_JOINS} WHERE n.school_id = ?`).all(schoolId);
  },

  findByStudent(schoolId, studentId) {
    return db.prepare(`${SELECT_WITH_JOINS} WHERE n.school_id = ? AND n.related_student_id = ?`).all(schoolId, studentId);
  },

  findByTeacher(schoolId, teacherId) {
    return db.prepare(`${SELECT_WITH_JOINS} WHERE n.school_id = ? AND n.related_teacher_id = ?`).all(schoolId, teacherId);
  },

  search(schoolId, q) {
    return db
      .prepare(`${SELECT_WITH_JOINS} WHERE n.school_id = ? AND (n.content LIKE ? OR s.name LIKE ? OR t.name LIKE ?)`)
      .all(schoolId, `%${q}%`, `%${q}%`, `%${q}%`);
  },

  findById(schoolId, id) {
    return db.prepare(`${SELECT_WITH_JOINS} WHERE n.school_id = ? AND n.id = ?`).get(schoolId, id);
  },

  // 未經 school 過濾的單筆讀取，只給已經在別處驗證過歸屬的呼叫端用（例如新增/更新後重新查詢剛寫入的那筆）
  findByIdUnscoped(id) {
    return db.prepare(`${SELECT_WITH_JOINS} WHERE n.id = ?`).get(id);
  },

  // 給分類清單頁彙總用（各筆的 categories 原始 JSON 字串，由呼叫端解析）
  findRawCategoriesBySchool(schoolId) {
    return db.prepare('SELECT categories FROM notes WHERE school_id = ?').all(schoolId);
  },

  create({ id, schoolId, authorUserId, categoriesJson, done, content, noteDate, relatedStudentId, relatedTeacherId }) {
    db.prepare(
      `INSERT INTO notes (id, school_id, author_user_id, categories, done, content, note_date, related_student_id, related_teacher_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, schoolId, authorUserId, categoriesJson, done ? 1 : 0, content, noteDate, relatedStudentId || null, relatedTeacherId || null);
  },

  update(id, { content, noteDate, categoriesJson, done, relatedStudentId, relatedTeacherId }) {
    db.prepare(
      `UPDATE notes SET content=?, note_date=?, categories=?, done=?, related_student_id=?, related_teacher_id=?, updated_at=datetime('now')
       WHERE id = ?`
    ).run(content, noteDate, categoriesJson, done ? 1 : 0, relatedStudentId || null, relatedTeacherId || null, id);
  },

  delete(schoolId, id) {
    db.prepare('DELETE FROM notes WHERE id = ? AND school_id = ?').run(id, schoolId);
  },

  // 刪除分類時批次改寫多筆記事的 categories，同一個 aggregate（notes 表）內的多列寫入，
  // repository 自帶 transaction（不橫跨其他 repository），符合 Wave 2 建立的 repository-local transaction 慣例
  updateCategoriesBulk(updates) {
    if (updates.length === 0) return;
    runInTransaction(() => {
      const update = db.prepare('UPDATE notes SET categories = ? WHERE id = ?');
      for (const { id, categoriesJson } of updates) update.run(categoriesJson, id);
    });
  },
};
