import { useEffect, useState, useCallback } from 'react';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { subscribeSchool } from '../socket';

// 記事本子系統的記事可選擇連結到某位學生或教師；這裡把連結到目前這位學生/教師的記事直接顯示在詳細頁，
// 新增/勾選完成/刪除都直接寫回記事本同一份資料，兩邊自動同步，不需要另外跳頁維護
export default function RelatedNotes({ studentId, teacherId }) {
  const { currentSchoolId, currentMembership } = useAuth();
  const isAdmin = currentMembership?.role === 'admin';

  const [notes, setNotes] = useState([]);
  const [content, setContent] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!currentSchoolId) return;
    const param = studentId ? `student_id=${studentId}` : `teacher_id=${teacherId}`;
    try {
      setNotes(await api.get(`/api/schools/${currentSchoolId}/notes?${param}`));
    } catch (err) {
      setError(err.message);
    }
  }, [currentSchoolId, studentId, teacherId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!currentSchoolId) return;
    return subscribeSchool(currentSchoolId, (resource) => {
      if (resource === 'notes') load();
    });
  }, [currentSchoolId, load]);

  if (!isAdmin) return null;

  const addNote = async (e) => {
    e.preventDefault();
    if (!content.trim()) return;
    setError('');
    try {
      await api.post(`/api/schools/${currentSchoolId}/notes`, {
        content: content.trim(),
        categories: [studentId ? '學生' : '教師'],
        related_student_id: studentId || null,
        related_teacher_id: teacherId || null,
      });
      setContent('');
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const toggleDone = async (note) => {
    setError('');
    try {
      await api.put(`/api/schools/${currentSchoolId}/notes/${note.id}`, { done: !note.done });
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const remove = async (note) => {
    if (!confirm('確定要刪除這則記事嗎？')) return;
    setError('');
    try {
      await api.del(`/api/schools/${currentSchoolId}/notes/${note.id}`);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div style={{ marginTop: 24 }}>
      <h3 style={{ margin: '0 0 8px' }}>相關記事</h3>
      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
      <div style={{ display: 'grid', gap: 8, maxWidth: 480 }}>
        {notes.map((note) => (
          <div key={note.id} className="card" style={{ padding: '6px 10px', display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={!!note.done} onChange={() => toggleDone(note)} />
            <div style={{ flex: 1, textDecoration: note.done ? 'line-through' : 'none' }}>
              {note.content} <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{note.note_date}</span>
            </div>
            <button type="button" onClick={() => remove(note)}>刪除</button>
          </div>
        ))}
        {notes.length === 0 && <p style={{ color: 'var(--text-muted)', margin: 0 }}>尚無相關記事</p>}
      </div>
      <form onSubmit={addNote} style={{ display: 'flex', gap: 8, marginTop: 8, maxWidth: 480 }}>
        <input value={content} onChange={(e) => setContent(e.target.value)} style={{ flex: 1 }} />
        <button type="submit">+ 新增記事</button>
      </form>
    </div>
  );
}
