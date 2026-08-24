export const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

export function slotToTime(slot) {
  const h = Math.floor(slot / 2);
  const m = slot % 2 === 0 ? '00' : '30';
  return `${String(h).padStart(2, '0')}:${m}`;
}

export function timeToSlot(hhmm) {
  const [h, m] = (hhmm || '0:0').split(':').map(Number);
  return (h || 0) * 2 + (m >= 30 ? 1 : 0);
}

// 依開始/結束時間（"HH:MM"）算出總時長（小時），結束時間需晚於開始時間，否則回傳 0
export function durationHoursBetween(startHHMM, endHHMM) {
  const startSlot = timeToSlot(startHHMM);
  const endSlot = timeToSlot(endHHMM);
  const slots = endSlot - startSlot;
  return slots > 0 ? slots / 2 : 0;
}

export function slotRangeLabel(startSlot, durationSlots) {
  return `${slotToTime(startSlot)} - ${slotToTime(startSlot + durationSlots)}`;
}

// 下拉選單顯示順序：[起始,結束) 範圍內的時段（補習班主要上課時段，「設定」子系統可調整）排最前面，
// 其餘時段接在後面照時間順序排列繞回來；純粹影響排序，不限制可選擇的時間
export function computeTimeOptions(rangeStart, rangeEnd) {
  const all = Array.from({ length: 48 }, (_, slot) => slotToTime(slot));
  const startSlot = timeToSlot(rangeStart || '18:00');
  const endSlot = timeToSlot(rangeEnd || '21:00');
  if (endSlot <= startSlot) return [...all.slice(startSlot), ...all.slice(0, startSlot)];
  return [...all.slice(startSlot, endSlot + 1), ...all.slice(endSlot + 1), ...all.slice(0, startSlot)];
}

export const TIME_OPTIONS = computeTimeOptions('18:00', '21:00');

// TimeInput 下拉選單固定從 17:00 開始列（不受「設定」子系統的起始/結束時間影響——那組設定只用來決定表單欄位直接帶入的預設值）
export const DROPDOWN_TIME_OPTIONS = computeTimeOptions('17:00', '17:00');

// 時長以「小時」為單位輸入（可半小時級距），內部仍以半小時 slot 數儲存
export function hoursToDurationSlots(hours) {
  return Math.round(Number(hours) * 2);
}

export function durationSlotsToHours(slots) {
  return slots / 2;
}

// 依起始時間＋預設堂課時長（小時）算出結束時間，超過當日最後一個時段（23:30）時鎖在 23:30
export function addHoursToTime(startHHMM, hours) {
  const startSlot = timeToSlot(startHHMM);
  const endSlot = Math.min(47, startSlot + hoursToDurationSlots(hours));
  return slotToTime(endSlot);
}

export function todayStr() {
  const d = new Date();
  const tzOffset = d.getTimezoneOffset() * 60000;
  return new Date(d - tzOffset).toISOString().slice(0, 10);
}
