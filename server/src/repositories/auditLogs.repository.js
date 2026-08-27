import { db } from '../db/index.js';

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

function clampLimit(limit) {
  const n = Number(limit) || DEFAULT_LIMIT;
  return Math.min(Math.max(n, 1), MAX_LIMIT);
}

export const auditLogsRepository = {
  append({ id, logType, level, category, pageKey, action, message, userId, schoolId, entityType, entityId, requestId, metadataJson }) {
    db.prepare(
      `INSERT INTO audit_logs (id, log_type, level, category, page_key, action, message, user_id, school_id, entity_type, entity_id, request_id, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, logType, level, category, pageKey, action, message, userId, schoolId, entityType, entityId, requestId, metadataJson);
  },

  // 統一分頁查詢，所有 filter 都是選擇性的（undefined/null 就不套用該條件）。newest first。
  // 回傳 { rows, hasMore }：多撈一筆判斷是否還有下一頁，避免另外下一次 COUNT(*) query。
  find({ logType, pageKey, level, category, userId, schoolId, keyword, startTime, endTime, limit, offset }) {
    const clauses = [];
    const params = [];

    if (logType) { clauses.push('log_type = ?'); params.push(logType); }
    if (pageKey) { clauses.push('page_key = ?'); params.push(pageKey); }
    if (level) { clauses.push('level = ?'); params.push(level); }
    if (category) { clauses.push('category = ?'); params.push(category); }
    if (userId) { clauses.push('user_id = ?'); params.push(userId); }
    if (schoolId) { clauses.push('school_id = ?'); params.push(schoolId); }
    if (startTime) { clauses.push('created_at >= ?'); params.push(startTime); }
    if (endTime) { clauses.push('created_at <= ?'); params.push(endTime); }
    if (keyword) { clauses.push('(message LIKE ? OR action LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`); }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const safeLimit = clampLimit(limit);
    const safeOffset = Math.max(Number(offset) || 0, 0);

    const rows = db
      .prepare(`SELECT * FROM audit_logs ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...params, safeLimit + 1, safeOffset);

    const hasMore = rows.length > safeLimit;
    return { rows: rows.slice(0, safeLimit), hasMore };
  },

  // retention policy 用：刪除超過保留天數的舊 log（不自動排程，見 docs/LOGGING_ARCHITECTURE.md）
  deleteOlderThan(cutoffDateStr) {
    return db.prepare('DELETE FROM audit_logs WHERE created_at < ?').run(cutoffDateStr).changes;
  },
};
