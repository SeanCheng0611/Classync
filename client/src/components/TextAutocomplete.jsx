import { useEffect, useRef, useState } from 'react';

// 自由文字輸入＋下拉建議：可直接打字新增新選項，也能從既有清單點選；
// 聚焦時一律顯示建議清單（不像原生 datalist 在文字剛好完全符合時會自動收起）
export default function TextAutocomplete({ options, value, onChange, placeholder }) {
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

  // 選項清單通常很短（分類數量少），聚焦時直接顯示完整清單，不依目前文字過濾，
  // 避免像「待辦」這種預設分類因為欄位裡已經是別的文字而被濾掉、找不到
  const filtered = options;

  const pick = (opt) => {
    onChange(opt);
    setOpen(false);
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        style={{ width: '100%' }}
      />
      {open && filtered.length > 0 && (
        <ul
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            zIndex: 20,
            marginTop: 2,
            maxHeight: 240,
            overflowY: 'auto',
            padding: 4,
            listStyle: 'none',
            background: 'var(--surface)',
            border: '1px solid var(--border-strong)',
            borderRadius: 6,
            boxShadow: 'var(--shadow)',
          }}
        >
          {filtered.map((opt) => (
            <li key={opt}>
              <button
                type="button"
                onClick={() => pick(opt)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '4px 8px',
                  border: 'none',
                  background: opt === value ? 'var(--accent-soft)' : 'transparent',
                  cursor: 'pointer',
                }}
              >
                {opt}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
