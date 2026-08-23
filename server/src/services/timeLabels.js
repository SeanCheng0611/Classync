export const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

export function slotToTime(slot) {
  const h = Math.floor(slot / 2);
  const m = slot % 2 === 0 ? '00' : '30';
  return `${String(h).padStart(2, '0')}:${m}`;
}

export function slotRangeLabel(startSlot, durationSlots) {
  return `${slotToTime(startSlot)} - ${slotToTime(startSlot + durationSlots)}`;
}
