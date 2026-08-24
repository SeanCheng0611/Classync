import PillListSummary from './PillListSummary';
import { WEEKDAY_LABELS, slotRangeLabel } from '../lib/time';

// 學生目前的固定課摘要，跟教師彈性上課時段一樣：超過預設筆數就收合，用「展開/收合」切換
export default function FixedClassSummary({ templates, maxWidth = 260 }) {
  const entries = templates
    .slice()
    .sort((a, b) => a.weekday - b.weekday || a.start_slot - b.start_slot)
    .map((t) => ({
      key: t.id,
      label: `星期${WEEKDAY_LABELS[t.weekday]} ${slotRangeLabel(t.start_slot, t.duration_slots)} ${t.subject}`,
    }));

  return <PillListSummary entries={entries} maxWidth={maxWidth} emptyText="無固定課" />;
}
