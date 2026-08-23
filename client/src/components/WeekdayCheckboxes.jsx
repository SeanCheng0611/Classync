import { WEEKDAY_LABELS } from '../lib/time';

// 可複選星期：一次新增多個星期的固定課堂/行政時段
export default function WeekdayCheckboxes({ value, onChange }) {
  const toggle = (day) => {
    onChange(value.includes(day) ? value.filter((d) => d !== day) : [...value, day].sort());
  };

  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {WEEKDAY_LABELS.map((label, day) => (
        <label key={day} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <input type="checkbox" checked={value.includes(day)} onChange={() => toggle(day)} />
          {label}
        </label>
      ))}
    </div>
  );
}
