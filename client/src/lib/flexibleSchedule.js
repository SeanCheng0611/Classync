export const FLEXIBLE_SCHEDULE_WEEKDAYS = [1, 2, 3, 4, 5, 6, 0];

export function emptyFlexibleScheduleForm() {
  return Object.fromEntries(FLEXIBLE_SCHEDULE_WEEKDAYS.map((w) => [w, { start: '', end: '' }]));
}

export function flexibleScheduleToForm(schedule) {
  const form = emptyFlexibleScheduleForm();
  for (const w of FLEXIBLE_SCHEDULE_WEEKDAYS) {
    const slot = schedule?.[w];
    if (slot) form[w] = { start: slot.start, end: slot.end };
  }
  return form;
}

// 只保留起訖都有填、且結束晚於開始的星期
export function flexibleScheduleFormToPayload(form) {
  const payload = {};
  for (const w of FLEXIBLE_SCHEDULE_WEEKDAYS) {
    const { start, end } = form[w] || {};
    if (start && end && end > start) payload[w] = { start, end };
  }
  return payload;
}
