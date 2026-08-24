import TimeInput from './TimeInput';
import { WEEKDAY_LABELS } from '../lib/time';
import { FLEXIBLE_SCHEDULE_WEEKDAYS } from '../lib/flexibleSchedule';

// 固定星期一到六，每天一段起訖時間（留空代表當天沒有彈性時段）
export default function FlexibleScheduleEditor({ value, onChange }) {
  const setDay = (weekday, patch) => {
    onChange({ ...value, [weekday]: { ...value[weekday], ...patch } });
  };

  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {FLEXIBLE_SCHEDULE_WEEKDAYS.map((w) => (
        <div key={w} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 56, flexShrink: 0, whiteSpace: 'nowrap' }}>星期{WEEKDAY_LABELS[w]}</span>
          <TimeInput value={value[w]?.start || ''} onChange={(v) => setDay(w, { start: v })} />
          <span>~</span>
          <TimeInput value={value[w]?.end || ''} onChange={(v) => setDay(w, { end: v })} />
        </div>
      ))}
    </div>
  );
}
