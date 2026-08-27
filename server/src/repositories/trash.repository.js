import { db } from '../db/index.js';

// Trash 是唯一一個天生需要「泛用、跨很多張表」存取的 domain：刪除任何實體前都要把它（與它牽連的子資料）
// 序列化存起來，還原時再逐表插回去。table/column 名稱在下面這幾個 generic helper 裡永遠是程式內部寫死的
// 字面值（呼叫端見 services/trash.js 的 capture*/RESTORE_HANDLERS），從未來自使用者輸入，不是 SQL injection
// 風險，也不是「Generic Repository」（見 REPOSITORY_ARCHITECTURE.md 的「為什麼不做 Generic Repository」）——
// 這裡表達的是 Trash 這個 domain 自己的 persistence 需求，不是給其他 domain 共用的抽象查詢介面。
export const trashRepository = {
  findRowsByColumn(table, column, value) {
    return db.prepare(`SELECT * FROM ${table} WHERE ${column} = ?`).all(value);
  },

  findRowById(table, id) {
    return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  },

  insertRow(table, row) {
    const cols = Object.keys(row);
    db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(
      ...cols.map((c) => row[c])
    );
  },

  updateSessionCancelled(sessionId, cancelled) {
    db.prepare('UPDATE class_sessions SET cancelled = ? WHERE id = ?').run(cancelled ? 1 : 0, sessionId);
  },

  reattachCancelledSession(templateId, sessionId) {
    db.prepare('UPDATE class_sessions SET cancelled = 0, template_id = ? WHERE id = ?').run(templateId, sessionId);
  },

  // ---- trash 表本體 ----

  findAllBySchool(schoolId) {
    return db
      .prepare(
        `SELECT t.*, u.display_name as deleted_by_name FROM trash t
         LEFT JOIN users u ON u.id = t.deleted_by
         WHERE t.school_id = ? ORDER BY t.deleted_at DESC`
      )
      .all(schoolId);
  },

  findById(schoolId, id) {
    return db.prepare('SELECT * FROM trash WHERE id = ? AND school_id = ?').get(id, schoolId);
  },

  insert({ id, schoolId, entityType, label, payloadJson, relatedStudentIdsJson, relatedTeacherId, deletedBy }) {
    db.prepare(
      `INSERT INTO trash (id, school_id, entity_type, label, payload, related_student_ids, related_teacher_id, deleted_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, schoolId, entityType, label, payloadJson, relatedStudentIdsJson, relatedTeacherId || null, deletedBy || null);
  },

  deleteById(id) {
    db.prepare('DELETE FROM trash WHERE id = ?').run(id);
  },

  deleteByIdScoped(schoolId, id) {
    db.prepare('DELETE FROM trash WHERE id = ? AND school_id = ?').run(id, schoolId);
  },

  deleteExpired(retentionDays) {
    db.prepare(`DELETE FROM trash WHERE deleted_at < datetime('now', '-' || ? || ' days')`).run(retentionDays);
  },
};
