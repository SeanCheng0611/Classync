import { useState } from 'react';

// 收合狀態只顯示 1 筆，確保表格列高固定為一行；展開後才允許換行顯示全部
const MAX_COLLAPSED = 1;

// 用跟旁邊 pill 一樣的形狀（圓角小標籤），只是淡淡地帶一點駝色，不用搶眼的實框按鈕樣式
const TOGGLE_BTN_STYLE = {
  display: 'inline-block',
  fontSize: 12,
  fontWeight: 500,
  padding: '2px 10px',
  border: 'none',
  borderRadius: 999,
  color: 'var(--accent-hover)',
  background: 'var(--accent-soft)',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
};

// 固定寬度顯示一組 pill 標籤，超過預設筆數就收合，用「展開/收合」切換，避免撐開表格列高／欄寬；
// 教師彈性上課時段、學生固定課摘要都共用這個
export default function PillListSummary({ entries, maxWidth = 220, emptyText = '未設定' }) {
  const [expanded, setExpanded] = useState(false);

  if (entries.length === 0) return <span style={{ color: 'var(--text-muted)' }}>{emptyText}</span>;

  const visible = expanded ? entries : entries.slice(0, MAX_COLLAPSED);
  const hiddenCount = entries.length - visible.length;

  return (
    <div
      style={{
        maxWidth,
        display: 'flex',
        flexWrap: expanded ? 'wrap' : 'nowrap',
        overflow: expanded ? 'visible' : 'hidden',
        gap: 4,
        alignItems: 'center',
      }}
    >
      {visible.map((e) => (
        <span key={e.key} className="pill" style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>
          {e.label}
        </span>
      ))}
      {hiddenCount > 0 && (
        <button type="button" onClick={() => setExpanded(true)} style={TOGGLE_BTN_STYLE}>
          +{hiddenCount} 展開
        </button>
      )}
      {expanded && entries.length > MAX_COLLAPSED && (
        <button type="button" onClick={() => setExpanded(false)} style={TOGGLE_BTN_STYLE}>
          收合
        </button>
      )}
    </div>
  );
}
