import { useEffect, useRef, useState } from 'react';

// 可搜尋的下拉選單：輸入文字即時過濾選項，取代長串的原生 <select>
export default function SearchSelect({ options, value, onChange, placeholder = '輸入姓名搜尋...' }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  const selected = options.find((o) => o.id === value);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  const filtered = query.trim() ? options.filter((o) => o.name.includes(query.trim())) : options;

  const pick = (opt) => {
    onChange(opt.id);
    setQuery('');
    setOpen(false);
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <input
        type="text"
        value={open ? query : selected?.name || ''}
        placeholder={placeholder}
        onFocus={() => {
          setOpen(true);
          setQuery('');
        }}
        onChange={(e) => setQuery(e.target.value)}
        style={{ width: '100%' }}
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
          {filtered.map((o) => (
            <li key={o.id}>
              <button
                type="button"
                onClick={() => pick(o)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '4px 8px',
                  border: 'none',
                  background: o.id === value ? 'var(--accent-soft)' : 'transparent',
                  cursor: 'pointer',
                }}
              >
                {o.name}
              </button>
            </li>
          ))}
          {filtered.length === 0 && (
            <li style={{ padding: '4px 8px', color: 'var(--text-muted)', fontSize: 13 }}>查無符合的結果</li>
          )}
        </ul>
      )}
    </div>
  );
}
