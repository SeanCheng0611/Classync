import { nanoid } from 'nanoid';
import { schedulingRepository } from '../repositories/index.js';

// date: 'YYYY-MM-DD' -> JS getDay() weekday (0=Sun..6=Sat), matches our schema's weekday column
function weekdayOf(dateStr) {
  return new Date(`${dateStr}T00:00:00`).getDay();
}

// 依當週固定課表樣板，確保該日期已展開出對應的 class_sessions（懶生成，第一次查詢該日期時才建立）
export function ensureSessionsForDate(schoolId, dateStr) {
  const weekday = weekdayOf(dateStr);
  const templates = schedulingRepository.findTemplatesActiveOnDate(schoolId, weekday, dateStr);

  for (const template of templates) {
    const existing = schedulingRepository.findSessionByTemplateAndDate(template.id, dateStr);
    if (existing) continue;

    schedulingRepository.createSessionFromTemplate({
      id: nanoid(),
      schoolId,
      templateId: template.id,
      teacherId: template.teacher_id,
      subject: template.subject,
      sessionDate: dateStr,
      startSlot: template.start_slot,
      durationSlots: template.duration_slots,
      rateOverride: template.rate_override,
    });
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
  const students = schedulingRepository.findSessionStudentsWithNames(row.id);
  const origin = row.type === 'makeup' && row.origin_session_id ? schedulingRepository.findSessionByIdAny(row.origin_session_id) : null;
  return {
    ...row,
    students,
    origin_session_date: origin?.session_date || null,
    origin_start_slot: origin?.start_slot ?? null,
  };
}
