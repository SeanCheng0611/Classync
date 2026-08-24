import { useState } from 'react';

// Excel 匯入時遇到「設定選單裡沒有的科目」跳出詢問：選擇要對應到選單裡的哪一項，或直接把它新增為新科目
export default function SubjectMappingModal({ rawText, options, onSelect, onAddNew, onSkip }) {
  const [newSubject, setNewSubject] = useState(rawText || '');

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
      }}
    >
      <div
        className="card"
        style={{ background: 'var(--surface)', padding: 20, borderRadius: 'var(--radius)', width: 420, maxWidth: '90%' }}
      >
        <h3 style={{ marginTop: 0 }}>發現未設定的科目</h3>
        <p style={{ fontSize: 14 }}>
          Excel 中的科目「<strong>{rawText}</strong>」不在設定選單裡，請選擇要對應到哪一個既有科目，或新增為新科目。
        </p>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {options.map((s) => (
            <button key={s} type="button" className="pill" onClick={() => onSelect(s)}>
              {s}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 16, alignItems: 'center' }}>
          <input value={newSubject} onChange={(e) => setNewSubject(e.target.value)} style={{ flex: 1 }} />
          <button
            type="button"
            onClick={() => {
              const v = newSubject.trim();
              if (v) onAddNew(v);
            }}
          >
            新增為新科目
          </button>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 20, flexWrap: 'wrap' }}>
          <button type="button" onClick={onSkip}>略過此科目</button>
        </div>
      </div>
    </div>
  );
}
