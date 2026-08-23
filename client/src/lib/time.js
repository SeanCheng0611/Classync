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

// 下拉選單顯示順序從 18:00 開始（補習班主要上課時段），往後排到隔天 17:30 再循環回來
const TIME_OPTIONS_START_SLOT = 36; // 18:00
export const TIME_OPTIONS = (() => {
  const all = Array.from({ length: 48 }, (_, slot) => slotToTime(slot));
  return [...all.slice(TIME_OPTIONS_START_SLOT), ...all.slice(0, TIME_OPTIONS_START_SLOT)];
})();

// 時長以「小時」為單位輸入（可半小時級距），內部仍以半小時 slot 數儲存
export function hoursToDurationSlots(hours) {
  return Math.round(Number(hours) * 2);
}

export function durationSlotsToHours(slots) {
  return slots / 2;
}

export function todayStr() {
  const d = new Date();
  const tzOffset = d.getTimezoneOffset() * 60000;
  return new Date(d - tzOffset).toISOString().slice(0, 10);
}
