import { TIME_OPTIONS } from '../lib/time';

export default function TimeSelect({ value, onChange, ...rest }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} {...rest}>
      <option value="" disabled>請選擇</option>
      {TIME_OPTIONS.map((t) => (
        <option key={t} value={t}>{t}</option>
      ))}
    </select>
  );
}
