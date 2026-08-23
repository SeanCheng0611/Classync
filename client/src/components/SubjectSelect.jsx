import { useState } from 'react';

const STORAGE_KEY = 'subjectOptions';
const DEFAULT_SUBJECTS = ['C', 'E', 'M', 'N', 'S'];

function loadSubjects() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch {
    // ignore malformed storage, fall back to defaults
  }
  return DEFAULT_SUBJECTS;
}

function saveSubjects(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // storage unavailable, option list just won't persist
  }
}

// 科目下拉選單：預設 C/E/M/N/S，可自行新增/刪除選項（存在瀏覽器本機，跨頁面共用）
export default function SubjectSelect({ value, onChange }) {
  const [subjects, setSubjects] = useState(loadSubjects);
  const [managing, setManaging] = useState(false);
  const [newSubject, setNewSubject] = useState('');

  const addSubject = () => {
    const v = newSubject.trim();
    if (!v || subjects.includes(v)) return;
    const next = [...subjects, v];
    setSubjects(next);
    saveSubjects(next);
    setNewSubject('');
  };

  const removeSubject = (s) => {
    const next = subjects.filter((x) => x !== s);
    setSubjects(next);
    saveSubjects(next);
    if (value === s) onChange('');
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: 8 }}>
        <select value={value} onChange={(e) => onChange(e.target.value)} style={{ flex: 1 }}>
          <option value="">請選擇</option>
          {subjects.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <button type="button" onClick={() => setManaging((v) => !v)}>{managing ? '完成' : '管理'}</button>
      </div>
      {managing && (
        <div style={{ marginTop: 8, padding: 8, border: '1px solid var(--border)', borderRadius: 6, display: 'grid', gap: 6 }}>
          {subjects.map((s) => (
            <div key={s} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>{s}</span>
              <button type="button" onClick={() => removeSubject(s)}>刪除</button>
            </div>
          ))}
          {subjects.length === 0 && <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 13 }}>尚無選項</p>}
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={newSubject}
              onChange={(e) => setNewSubject(e.target.value)}
              placeholder="新增科目"
              style={{ flex: 1 }}
            />
            <button type="button" onClick={addSubject}>新增</button>
          </div>
        </div>
      )}
    </div>
  );
}
