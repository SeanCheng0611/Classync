import { nanoid } from 'nanoid';
import { db } from '../db/index.js';

// date: 'YYYY-MM-DD' -> JS getDay() weekday (0=Sun..6=Sat), matches our schema's weekday column
function weekdayOf(dateStr) {
  return new Date(`${dateStr}T00:00:00`).getDay();
}

// 依當週固定課表樣板，確保該日期已展開出對應的 class_sessions（懶生成，第一次查詢該日期時才建立）
export function ensureSessionsForDate(schoolId, dateStr) {
  const weekday = weekdayOf(dateStr);
  const templates = db
    .prepare(
      `SELECT * FROM schedule_templates
       WHERE school_id = ? AND weekday = ?
         AND active_from <= ?
         AND (active_until IS NULL OR active_until >= ?)`
    )
    .all(schoolId, weekday, dateStr, dateStr);

  for (const template of templates) {
    const existing = db
      .prepare('SELECT id FROM class_sessions WHERE template_id = ? AND session_date = ?')
      .get(template.id, dateStr);
    if (existing) continue;

    const sessionId = nanoid();
    db.prepare(
      `INSERT INTO class_sessions (id, school_id, template_id, teacher_id, subject, session_date, start_slot, duration_slots, type, rate_override)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'regular', ?)`
    ).run(
      sessionId,
      schoolId,
      template.id,
      template.teacher_id,
      template.subject,
      dateStr,
      template.start_slot,
      template.duration_slots,
      template.rate_override ?? null
    );

    const students = db
      .prepare('SELECT student_id, unit_price FROM template_students WHERE template_id = ?')
      .all(template.id);
    const insertStudent = db.prepare(
      'INSERT INTO session_students (session_id, student_id, unit_price) VALUES (?, ?, ?)'
    );
    for (const { student_id, unit_price } of students) insertStudent.run(sessionId, student_id, unit_price);
  }
}

// 確保區間內每一天的 regular session 都已由樣板展開（給薪資/學費計算用，避免漏掉還沒被查詢過的未來日期）
export function ensureSessionsForRange(schoolId, startDate, endDateExclusive) {
  const cursor = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDateExclusive}T00:00:00`);
  while (cursor < end) {
    ensureSessionsForDate(schoolId, cursor.toISOString().slice(0, 10));
    cursor.setDate(cursor.getDate() + 1);
  }
}

export function serializeSession(row) {
  const students = db
    .prepare(
      `SELECT s.id, s.name, ss.unit_price FROM session_students ss JOIN students s ON s.id = ss.student_id WHERE ss.session_id = ?`
    )
    .all(row.id);
  const origin =
    row.type === 'makeup' && row.origin_session_id
      ? db.prepare('SELECT session_date, start_slot FROM class_sessions WHERE id = ?').get(row.origin_session_id)
      : null;
  return {
    ...row,
    students,
    origin_session_date: origin?.session_date || null,
    origin_start_slot: origin?.start_slot ?? null,
  };
}
