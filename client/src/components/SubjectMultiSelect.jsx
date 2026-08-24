import { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { parseSubjects } from '../lib/subjects';

// 科目多選：只能勾選「設定」子系統裡已存在的科目，不開放自由輸入；可在此或設定頁增刪/恢復預設
export default function SubjectMultiSelect({ value, onChange }) {
  const { currentSchoolId, schoolSettings } = useAuth();
  const subjects = parseSubjects(schoolSettings);
  const [managing, setManaging] = useState(false);
  const [newSubject, setNewSubject] = useState('');
  const [error, setError] = useState('');

  const saveSubjects = async (next) => {
    setError('');
    try {
      await api.put(`/api/schools/${currentSchoolId}/subjects`, { subjects: next });
    } catch (err) {
      setError(err.message);
    }
  };

  const addSubject = () => {
    const v = newSubject.trim();
    if (!v || subjects.includes(v)) return;
    saveSubjects([...subjects, v]);
    setNewSubject('');
  };

  const removeSubject = (s) => {
    saveSubjects(subjects.filter((x) => x !== s));
    if (value.includes(s)) onChange(value.filter((v) => v !== s));
  };

  const toggle = (s) => {
    onChange(value.includes(s) ? value.filter((v) => v !== s) : [...value, s]);
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {subjects.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => toggle(s)}
            className="pill"
            style={
              value.includes(s)
                ? { background: 'var(--accent)', color: '#fff', border: 'none' }
                : { background: 'transparent', border: '1px solid var(--border-strong)' }
            }
          >
            {s}
          </button>
        ))}
        <button type="button" onClick={() => setManaging((v) => !v)}>{managing ? '完成' : '管理'}</button>
      </div>
      {error && <p style={{ margin: '4px 0 0', color: 'var(--danger)', fontSize: 13 }}>{error}</p>}
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
