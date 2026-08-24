// 課堂類型標籤（課表／點名子系統顯示用）的顏色，可在「設定」子系統挑選，存在 schools.type_colors（JSON）
// 只開放挑選這組固定的莫蘭迪色票，不開放任意色碼，維持整體風格一致
export const SWATCHES = {
  camel: { label: '駝色', color: 'var(--accent)' },
  red: { label: '紅', color: 'var(--danger)' },
  green: { label: '綠', color: 'var(--success)' },
  blue: { label: '藍', color: 'var(--info)' },
  purple: { label: '紫', color: 'var(--accent-purple)' },
  gray: { label: '灰', color: 'var(--text-muted)' },
};

// regular/extra/makeup 對應 session.type；leave 對應「已請假」（已調課直接沿用 makeup 的顏色，不需要另外設定）
export const TAG_TYPES = [
  { key: 'regular', label: '固定課' },
  { key: 'extra', label: '加課' },
  { key: 'makeup', label: '調課' },
  { key: 'leave', label: '請假' },
];

export const DEFAULT_TYPE_COLORS = { regular: 'camel', extra: 'green', makeup: 'blue', leave: 'red' };

export function parseTypeColors(schoolSettings) {
  try {
    const parsed = JSON.parse(schoolSettings?.type_colors || '{}');
    return { ...DEFAULT_TYPE_COLORS, ...parsed };
  } catch {
    return DEFAULT_TYPE_COLORS;
  }
}

function swatchColor(colors, key) {
  return (SWATCHES[colors[key]] || SWATCHES[DEFAULT_TYPE_COLORS[key]]).color;
}

export function sessionTypeLabel(session) {
  if (session.type === 'makeup') return '調課';
  if (session.type === 'regular') return '固定課';
  return '加課';
}

export function sessionTypeColor(session, schoolSettings) {
  const colors = parseTypeColors(schoolSettings);
  const key = session.type === 'makeup' || session.type === 'regular' ? session.type : 'extra';
  return swatchColor(colors, key);
}

// 已請假的標籤顏色（已調課則沿用調課的顏色，見 sessionTypeColor）
export function leaveColor(schoolSettings) {
  return swatchColor(parseTypeColors(schoolSettings), 'leave');
}
