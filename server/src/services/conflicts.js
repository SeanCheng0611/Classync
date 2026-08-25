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

// 檢查某學生在指定日期是否已有課堂時段重疊（含固定課展開、調課、加課），排除自己正在編輯的那堂；
// 該學生已請假的課堂不算佔用時段（請假＝該時段對這位學生來說是空的，可以另外安排課程）
export function findStudentSessionConflict(schoolId, studentId, date, startSlot, durationSlots, excludeSessionId) {
  ensureSessionsForDate(schoolId, date);
  const rows = db
    .prepare(
      `SELECT cs.* FROM class_sessions cs JOIN session_students ss ON ss.session_id = cs.id
       WHERE cs.school_id = ? AND ss.student_id = ? AND cs.session_date = ? AND cs.cancelled = 0 AND cs.id != ?
       AND NOT EXISTS (
         SELECT 1 FROM attendance_records ar
         WHERE ar.session_id = cs.id AND ar.person_type = 'student' AND ar.person_id = ? AND ar.status = 'leave'
       )`
    )
    .all(schoolId, studentId, date, excludeSessionId || '', studentId);
  return rows.find((r) => overlaps(startSlot, durationSlots, r.start_slot, r.duration_slots)) || null;
}

// 檢查學生人數是否超過該補習班在「設定」子系統設定的一對多班級人數上限，超過回傳錯誤訊息（未超過回傳 null）
export function checkGroupSizeLimit(schoolId, studentCount) {
  const school = db.prepare('SELECT group_class_max_students FROM schools WHERE id = ?').get(schoolId);
  const max = school?.group_class_max_students ?? 2;
  if (studentCount > max) return `這堂課學生人數（${studentCount}）超過設定上限（一對 ${max}）`;
  return null;
}

// 通用時間區間扣除：從 [startSlot, endSlot) 扣掉每一段 busyRanges 重疊的部分，回傳剩下的區段（可能拆成多段，也可能是空陣列）；
// 新增教師行政時段時用來自動避開該教師已經有學生的課堂時段
export function subtractBusyRanges(startSlot, endSlot, busyRanges) {
  let free = [[startSlot, endSlot]];
  for (const [busyStart, busyEnd] of busyRanges) {
    const next = [];
    for (const [freeStart, freeEnd] of free) {
      if (busyEnd <= freeStart || busyStart >= freeEnd) {
        next.push([freeStart, freeEnd]);
        continue;
      }
      if (busyStart > freeStart) next.push([freeStart, busyStart]);
      if (busyEnd < freeEnd) next.push([busyEnd, freeEnd]);
    }
    free = next;
  }
  return free.filter(([s, e]) => e > s);
}

// 教師在指定日期、已經有學生的課堂時段（固定課展開、加課、調課皆算），用來讓新增行政時段時自動避開
export function findTeacherTeachingRangesOnDate(schoolId, teacherId, date) {
  ensureSessionsForDate(schoolId, date);
  const rows = db
    .prepare(
      `SELECT cs.start_slot, cs.duration_slots FROM class_sessions cs
       WHERE cs.school_id = ? AND cs.teacher_id = ? AND cs.session_date = ? AND cs.cancelled = 0
       AND EXISTS (SELECT 1 FROM session_students ss WHERE ss.session_id = cs.id)`
    )
    .all(schoolId, teacherId, date);
  return rows.map((r) => [r.start_slot, r.start_slot + r.duration_slots]);
}

// 教師在指定星期、已經有學生的固定課樣板時段，且生效區間與 [activeFrom, activeUntil] 重疊，用來讓新增固定行政時段時自動避開
export function findTeacherTeachingRangesOnWeekday(schoolId, teacherId, weekday, activeFrom, activeUntil) {
  const rows = db
    .prepare(
      `SELECT st.start_slot, st.duration_slots, st.active_from, st.active_until FROM schedule_templates st
       WHERE st.school_id = ? AND st.teacher_id = ? AND st.weekday = ?
       AND EXISTS (SELECT 1 FROM template_students ts WHERE ts.template_id = st.id)`
    )
    .all(schoolId, teacherId, weekday);
  return rows
    .filter((r) => activeRangesOverlap(activeFrom, activeUntil, r.active_from, r.active_until))
    .map((r) => [r.start_slot, r.start_slot + r.duration_slots]);
}
