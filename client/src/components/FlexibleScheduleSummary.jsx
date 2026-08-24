import PillListSummary from './PillListSummary';
import { WEEKDAY_LABELS } from '../lib/time';

// 固定寬度顯示彈性上課時段，超過預設筆數就隱藏，用「展開/收合」切換，避免撐開表格列高／欄寬
export default function FlexibleScheduleSummary({ schedule, maxWidth = 220 }) {
  const entries = Object.entries(schedule || {})
    .map(([weekday, range]) => ({ weekday: Number(weekday), ...range }))
    .sort((a, b) => a.weekday - b.weekday)
    .map((e) => ({ key: e.weekday, label: `${WEEKDAY_LABELS[e.weekday]} ${e.start}-${e.end}` }));

  return <PillListSummary entries={entries} maxWidth={maxWidth} />;
}
