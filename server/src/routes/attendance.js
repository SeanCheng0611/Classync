import { Router } from 'express';
import { nanoid } from 'nanoid';
import { db } from '../db/index.js';
import { requireMembership } from '../auth/middleware.js';
import { broadcastChange } from '../realtime/index.js';

export const attendanceRouter = Router({ mergeParams: true });
attendanceRouter.use(requireMembership());

// 教師只能查看自己任教課程的點名紀錄（唯讀），管理者可查看全部
attendanceRouter.get('/', (req, res) => {
  const { date, session_id } = req.query;
  const teacherFilter = req.membership.role !== 'teacher' ? null : req.membership.teacher_id || '';
  let rows;
  if (session_id) {
    rows = teacherFilter
      ? db
          .prepare(
            `SELECT ar.* FROM attendance_records ar JOIN class_sessions cs ON cs.id = ar.session_id
             WHERE ar.session_id = ? AND cs.teacher_id = ?`
          )
          .all(session_id, teacherFilter)
      : db.prepare('SELECT * FROM attendance_records WHERE session_id = ?').all(session_id);
  } else if (date) {
    rows = teacherFilter
      ? db
          .prepare(
            `SELECT ar.* FROM attendance_records ar JOIN class_sessions cs ON cs.id = ar.session_id
             WHERE ar.school_id = ? AND cs.session_date = ? AND cs.teacher_id = ?`
          )
          .all(req.params.schoolId, date, teacherFilter)
      : db
          .prepare(
            `SELECT ar.* FROM attendance_records ar JOIN class_sessions cs ON cs.id = ar.session_id
             WHERE ar.school_id = ? AND cs.session_date = ?`
          )
          .all(req.params.schoolId, date);
  } else {
    return res.status(400).json({ error: 'date or session_id query param required' });
  }
  res.json(rows.map((r) => ({ ...r, makeup_arranged: !!r.makeup_arranged })));
});

// 新增或更新一筆點名紀錄（依 session_id + person_type + person_id upsert）：僅管理者可點名，教師僅能查看
attendanceRouter.post('/', requireMembership(['admin', 'front_desk']), (req, res) => {
  const { session_id, person_type, person_id, status, makeup_arranged, note } = req.body;
  if (!session_id || !person_type || !person_id || !status) {
    return res.status(400).json({ error: 'session_id, person_type, person_id, status required' });
  }
  if (person_type !== 'student') {
    return res.status(400).json({ error: '教師點名已停用，教師薪資改依排課自動計算' });
  }
  if (!['present', 'absent', 'leave'].includes(status)) {
    return res.status(400).json({ error: 'invalid status' });
  }

  const session = db
    .prepare('SELECT * FROM class_sessions WHERE id = ? AND school_id = ?')
    .get(session_id, req.params.schoolId);
  if (!session) return res.status(404).json({ error: 'session not found' });

  const existing = db
    .prepare('SELECT * FROM attendance_records WHERE session_id = ? AND person_type = ? AND person_id = ?')
    .get(session_id, person_type, person_id);

  if (existing) {
    // 取消安排調課時一併清掉 makeup_session_id，避免殘留指向已無關聯的調課課堂
    const makeupSessionId = makeup_arranged ? existing.makeup_session_id : null;
    db.prepare(
      `UPDATE attendance_records SET status=?, makeup_arranged=?, makeup_session_id=?, note=?, recorded_at=datetime('now')
       WHERE id = ?`
    ).run(status, makeup_arranged ? 1 : 0, makeupSessionId, note || null, existing.id);
  } else {
    db.prepare(
      `INSERT INTO attendance_records (id, school_id, session_id, person_type, person_id, status, makeup_arranged, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(nanoid(), req.params.schoolId, session_id, person_type, person_id, status, makeup_arranged ? 1 : 0, note || null);
  }

  broadcastChange(req.params.schoolId, 'attendance');
  const record = db
    .prepare('SELECT * FROM attendance_records WHERE session_id = ? AND person_type = ? AND person_id = ?')
    .get(session_id, person_type, person_id);
  res.status(existing ? 200 : 201).json({ ...record, makeup_arranged: !!record.makeup_arranged });
});

// 撤銷一筆點名紀錄（請假/調課可逆）：若該紀錄已排定調課課堂，一併刪除該調課課堂，恢復成「尚未點名」
attendanceRouter.delete('/', requireMembership(['admin', 'front_desk']), (req, res) => {
  const { session_id, person_type, person_id } = req.query;
  if (!session_id || !person_type || !person_id) {
    return res.status(400).json({ error: 'session_id, person_type, person_id required' });
  }

  const record = db
    .prepare('SELECT * FROM attendance_records WHERE session_id = ? AND person_type = ? AND person_id = ?')
    .get(session_id, person_type, person_id);
  if (!record) return res.status(404).json({ error: 'not found' });

  if (record.makeup_session_id) {
    const makeupSession = db.prepare('SELECT * FROM class_sessions WHERE id = ?').get(record.makeup_session_id);
    if (makeupSession) {
      if (makeupSession.type === 'regular') {
        db.prepare('UPDATE class_sessions SET cancelled = 1 WHERE id = ?').run(makeupSession.id);
      } else {
        db.prepare('DELETE FROM class_sessions WHERE id = ?').run(makeupSession.id);
      }
      broadcastChange(req.params.schoolId, 'sessions');
    }
  }

  db.prepare('DELETE FROM attendance_records WHERE id = ?').run(record.id);
  broadcastChange(req.params.schoolId, 'attendance');
  res.status(204).end();
});
