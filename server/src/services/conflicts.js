import { db } from '../db/index.js';
import { ensureSessionsForDate } from './sessions.js';

function overlaps(aStart, aDuration, bStart, bDuration) {
  return aStart < bStart + bDuration && bStart < aStart + aDuration;
}

// 兩個樣板的生效區間 [from, until] 是否有重疊（until 為 null 代表沒有期限）
function activeRangesOverlap(aFrom, aUntil, bFrom, bUntil) {
  return aFrom <= (bUntil || '9999-12-31') && bFrom <= (aUntil || '9999-12-31');
}

// 檢查某教師在「每週固定課表」中是否已有時段重疊（同星期、生效區間也重疊），排除自己正在編輯的樣板
export function findTeacherTemplateConflict(schoolId, teacherId, weekday, startSlot, durationSlots, excludeTemplateId, activeFrom, activeUntil) {
  const rows = db
    .prepare(
      `SELECT * FROM schedule_templates WHERE school_id = ? AND teacher_id = ? AND weekday = ? AND id != ?`
    )
    .all(schoolId, teacherId, weekday, excludeTemplateId || '');
  return (
    rows.find(
      (r) =>
        overlaps(startSlot, durationSlots, r.start_slot, r.duration_slots) &&
        activeRangesOverlap(activeFrom, activeUntil, r.active_from, r.active_until)
    ) || null
  );
}

// 檢查某學生在「每週固定課表」中是否已有時段重疊（同星期、生效區間也重疊），排除自己正在編輯的樣板
export function findStudentTemplateConflict(schoolId, studentId, weekday, startSlot, durationSlots, excludeTemplateId, activeFrom, activeUntil) {
  const rows = db
    .prepare(
      `SELECT st.* FROM schedule_templates st JOIN template_students ts ON ts.template_id = st.id
       WHERE st.school_id = ? AND ts.student_id = ? AND st.weekday = ? AND st.id != ?`
    )
    .all(schoolId, studentId, weekday, excludeTemplateId || '');
  return (
    rows.find(
      (r) =>
        overlaps(startSlot, durationSlots, r.start_slot, r.duration_slots) &&
        activeRangesOverlap(activeFrom, activeUntil, r.active_from, r.active_until)
    ) || null
  );
}

// 檢查某教師在指定日期是否已有課堂時段重疊（含固定課展開、調課、加課），排除自己正在編輯的那堂
export function findTeacherSessionConflict(schoolId, teacherId, date, startSlot, durationSlots, excludeSessionId) {
  ensureSessionsForDate(schoolId, date);
  const rows = db
    .prepare(
      `SELECT * FROM class_sessions WHERE school_id = ? AND teacher_id = ? AND session_date = ? AND cancelled = 0 AND id != ?`
    )
    .all(schoolId, teacherId, date, excludeSessionId || '');
  return rows.find((r) => overlaps(startSlot, durationSlots, r.start_slot, r.duration_slots)) || null;
}

// 檢查某學生在指定日期是否已有課堂時段重疊（含固定課展開、調課、加課），排除自己正在編輯的那堂
export function findStudentSessionConflict(schoolId, studentId, date, startSlot, durationSlots, excludeSessionId) {
  ensureSessionsForDate(schoolId, date);
  const rows = db
    .prepare(
      `SELECT cs.* FROM class_sessions cs JOIN session_students ss ON ss.session_id = cs.id
       WHERE cs.school_id = ? AND ss.student_id = ? AND cs.session_date = ? AND cs.cancelled = 0 AND cs.id != ?`
    )
    .all(schoolId, studentId, date, excludeSessionId || '');
  return rows.find((r) => overlaps(startSlot, durationSlots, r.start_slot, r.duration_slots)) || null;
}
