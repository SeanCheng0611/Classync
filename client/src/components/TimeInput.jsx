import { useEffect, useRef, useState } from 'react';
import { DROPDOWN_TIME_OPTIONS } from '../lib/time';

// 輸入為主、選擇為輔：可直接輸入 HH:MM（打完兩位數字會自動補冒號），也可點開下拉選單挑選
// 下拉選單固定顯示全部半小時級距選項，不會因為已輸入文字而被瀏覽器過濾
function formatTimeInput(raw) {
  const digits = raw.replace(/\D/g, '').slice(0, 4);
  if (digits.length <= 2) return digits;
  return `${digits.slice(0, 2)}:${digits.slice(2)}`;
}

export default function TimeInput({ value, onChange, style, ...rest }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  const pick = (t) => {
    onChange(t);
    setOpen(false);
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative', width: 90, ...style }}>
      <input
        type="text"
        placeholder="HH:MM"
        value={value}
        onChange={(e) => onChange(formatTimeInput(e.target.value))}
        onFocus={() => setOpen(true)}
        style={{ width: '100%' }}
        {...rest}
      />
      {open && (
        <ul
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            zIndex: 20,
            marginTop: 2,
            maxHeight: 220,
            overflowY: 'auto',
            padding: 4,
            listStyle: 'none',
            background: 'var(--surface)',
            border: '1px solid var(--border-strong)',
            borderRadius: 6,
            boxShadow: 'var(--shadow)',
          }}
        >
          {DROPDOWN_TIME_OPTIONS.map((t) => (
            <li key={t}>
              <button
                type="button"
                onClick={() => pick(t)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '4px 8px',
                  border: 'none',
                  background: t === value ? 'var(--accent-soft)' : 'transparent',
                  cursor: 'pointer',
                }}
              >
                {t}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
