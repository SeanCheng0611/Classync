import { useEffect, useState, useCallback } from 'react';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { subscribeSchool } from '../socket';
import SearchSelect from '../components/SearchSelect';
import TextAutocomplete from '../components/TextAutocomplete';

const DEFAULT_CATEGORIES = ['待辦', '備註'];
const emptyForm = {
  content: '',
  note_date: new Date().toISOString().slice(0, 10),
  category: '待辦',
  related_student_id: '',
  related_teacher_id: '',
};

export default function Notes() {
  const { currentSchoolId, currentMembership } = useAuth();
  const isAdmin = currentMembership?.role === 'admin';

  const [notes, setNotes] = useState([]);
  const [categories, setCategories] = useState([]);
  const [students, setStudents] = useState([]);
  const [teachers, setTeachers] = useState([]);
  const [search, setSearch] = useState('');
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [deleteMode, setDeleteMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [rangeStart, setRangeStart] = useState('');
  const [rangeEnd, setRangeEnd] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!currentSchoolId) return;
    try {
      const [n, cats, s, t] = await Promise.all([
        api.get(`/api/schools/${currentSchoolId}/notes${search.trim() ? `?q=${encodeURIComponent(search.trim())}` : ''}`),
        api.get(`/api/schools/${currentSchoolId}/notes/categories`),
        api.get(`/api/schools/${currentSchoolId}/students`),
        api.get(`/api/schools/${currentSchoolId}/teachers`),
      ]);
      setNotes(n);
      setCategories(Array.from(new Set([...DEFAULT_CATEGORIES, ...cats])));
      setStudents(s);
      setTeachers(t);
    } catch (err) {
      setError(err.message);
    }
  }, [currentSchoolId, search]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!currentSchoolId) return;
    return subscribeSchool(currentSchoolId, (resource) => {
      if (resource === 'notes') load();
    });
  }, [currentSchoolId, load]);

  if (!isAdmin) return <p>僅管理者可使用記事功能</p>;

  const startEdit = (note) => {
    setEditingId(note.id);
    setForm({
      content: note.content,
      note_date: note.note_date,
      category: note.category,
      related_student_id: note.related_student_id || '',
      related_teacher_id: note.related_teacher_id || '',
    });
    setShowForm(true);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setForm(emptyForm);
    setShowForm(false);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!form.content.trim()) return;
    setError('');
    const payload = {
      content: form.content.trim(),
      note_date: form.note_date,
      category: form.category,
      related_student_id: form.related_student_id || null,
      related_teacher_id: form.related_teacher_id || null,
    };
    try {
      if (editingId) {
        await api.put(`/api/schools/${currentSchoolId}/notes/${editingId}`, payload);
      } else {
        await api.post(`/api/schools/${currentSchoolId}/notes`, payload);
      }
      cancelEdit();
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
      if (editingId === note.id) cancelEdit();
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const toggleDeleteMode = () => {
    setDeleteMode((v) => !v);
    setSelectedIds(new Set());
    setRangeStart('');
    setRangeEnd('');
  };

  const toggleSelect = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectRange = () => {
    if (!rangeStart || !rangeEnd) return;
    const [from, to] = rangeStart <= rangeEnd ? [rangeStart, rangeEnd] : [rangeEnd, rangeStart];
    const idsInRange = notes.filter((n) => n.note_date >= from && n.note_date <= to).map((n) => n.id);
    setSelectedIds((prev) => new Set([...prev, ...idsInRange]));
  };

  const bulkDelete = async () => {
    if (selectedIds.size === 0) return;
    if (!confirm(`確定要刪除選取的 ${selectedIds.size} 則記事嗎？此動作無法復原。`)) return;
    setError('');
    try {
      await Promise.all([...selectedIds].map((id) => api.del(`/api/schools/${currentSchoolId}/notes/${id}`)));
      setSelectedIds(new Set());
      setDeleteMode(false);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const deleteDoneNotes = async () => {
    const doneIds = notes.filter((n) => n.done).map((n) => n.id);
    if (doneIds.length === 0) return;
    if (!confirm(`確定要刪除已打勾完成的 ${doneIds.length} 則記事嗎？此動作無法復原。`)) return;
    setError('');
    try {
      await Promise.all(doneIds.map((id) => api.del(`/api/schools/${currentSchoolId}/notes/${id}`)));
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div>
      <h2>記事本</h2>
      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}

      {!showForm && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <button type="button" onClick={() => setShowForm(true)}>
            + 新增記事
          </button>
          <button type="button" onClick={toggleDeleteMode}>
            {deleteMode ? '結束刪除模式' : '刪除模式'}
          </button>
          {!deleteMode && (
            <button type="button" onClick={deleteDoneNotes}>
              清除已完成
            </button>
          )}
        </div>
      )}

      {deleteMode && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
          <span>選取範圍：</span>
          <input type="date" value={rangeStart} onChange={(e) => setRangeStart(e.target.value)} />
          <span>～</span>
          <input type="date" value={rangeEnd} onChange={(e) => setRangeEnd(e.target.value)} />
          <button type="button" onClick={selectRange}>勾選此範圍</button>
          <button
            type="button"
            onClick={bulkDelete}
            disabled={selectedIds.size === 0}
            style={{ color: 'var(--danger)' }}
          >
            刪除選取項目（{selectedIds.size}）
          </button>
        </div>
      )}

      {showForm && (
      <form onSubmit={submit} style={{ display: 'grid', gap: 8, maxWidth: 480, marginBottom: 16 }}>
        <label>
          日期
          <input
            type="date"
            value={form.note_date}
            onChange={(e) => setForm({ ...form, note_date: e.target.value })}
            required
          />
        </label>
        <label>
          分類
          <TextAutocomplete
            options={categories}
            value={form.category}
            onChange={(v) => setForm({ ...form, category: v })}
            placeholder="例如：待辦、備註..."
          />
        </label>
        <label>
          內容
          <textarea
            rows={3}
            value={form.content}
            onChange={(e) => setForm({ ...form, content: e.target.value })}
            required
          />
        </label>
        <label>
          關聯學生（選填）
          <SearchSelect
            options={students}
            value={form.related_student_id}
            onChange={(id) => setForm({ ...form, related_student_id: id })}
            placeholder="輸入學生姓名搜尋..."
          />
        </label>
        <label>
          關聯教師（選填）
          <SearchSelect
            options={teachers}
            value={form.related_teacher_id}
            onChange={(id) => setForm({ ...form, related_teacher_id: id })}
            placeholder="輸入教師姓名搜尋..."
          />
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="submit">{editingId ? '儲存修改' : '新增記事'}</button>
          <button type="button" onClick={cancelEdit}>取消</button>
        </div>
      </form>
      )}

      <input
        type="text"
        placeholder="搜尋記事內容..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ marginBottom: 12, width: '100%', maxWidth: 320 }}
      />

      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid var(--border-strong)' }}>
            <th>{deleteMode ? '選取' : ''}</th>
            <th>分類</th>
            <th>日期</th>
            <th>內容</th>
            <th>關聯</th>
            <th>記錄者</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {notes.map((n) => (
            <tr
              key={n.id}
              style={{
                borderBottom: '1px solid var(--border)',
                background: deleteMode && selectedIds.has(n.id) ? 'var(--danger-soft, #fdecea)' : 'transparent',
              }}
            >
              <td>
                {deleteMode ? (
                  <input type="checkbox" checked={selectedIds.has(n.id)} onChange={() => toggleSelect(n.id)} />
                ) : (
                  <input type="checkbox" checked={!!n.done} onChange={() => toggleDone(n)} />
                )}
              </td>
              <td>{n.category}</td>
              <td style={{ whiteSpace: 'nowrap' }}>{n.note_date}</td>
              <td style={{ whiteSpace: 'pre-wrap', textDecoration: n.done ? 'line-through' : 'none' }}>
                {n.content}
              </td>
              <td>{[n.related_student_name, n.related_teacher_name].filter(Boolean).join('、')}</td>
              <td>{n.author_name}</td>
              <td style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => startEdit(n)}>編輯</button>
                <button onClick={() => remove(n)}>刪除</button>
              </td>
            </tr>
          ))}
          {notes.length === 0 && (
            <tr>
              <td colSpan={7} style={{ color: 'var(--text-muted)', padding: 12 }}>尚無記事</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
