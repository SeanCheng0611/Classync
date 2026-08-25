import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import ExcelJS from 'exceljs';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { subscribeSchool } from '../socket';
import SearchSelect from '../components/SearchSelect';
import { todayStr } from '../lib/time';
import { saveWorkbookAs, applyExportStyle } from '../lib/excelExport';

const DEFAULT_CATEGORIES = ['待辦', '學生', '教師', '生活', '雜項'];

// 分類新增／刪除按鈕：跟旁邊的分類 pill 按鈕共用同一份預設 button 樣式（高度自然對齊），
// 平時白底、開啟該模式時才變成實心強調色
function categorySymbolBtnStyle(active) {
  return active ? { background: 'var(--accent)', borderColor: 'var(--accent)', color: '#fff' } : undefined;
}
const emptyForm = {
  content: '',
  note_date: todayStr(),
  categories: ['待辦'],
  related_student_id: '',
  related_teacher_id: '',
};

export default function Notes() {
  const { currentSchoolId, currentMembership } = useAuth();
  const isAdmin = currentMembership?.role === 'admin';

  const [notes, setNotes] = useState([]);
  const [categories, setCategories] = useState(DEFAULT_CATEGORIES);
  const [students, setStudents] = useState([]);
  const [teachers, setTeachers] = useState([]);
  const [search, setSearch] = useState('');
  const [filterCategories, setFilterCategories] = useState(new Set()); // 空集合 = 全部
  const [newCategoryInput, setNewCategoryInput] = useState('');
  const [showAddCategory, setShowAddCategory] = useState(false);
  const [showDeleteCategory, setShowDeleteCategory] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [deleteMode, setDeleteMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [rangeStart, setRangeStart] = useState('');
  const [rangeEnd, setRangeEnd] = useState('');
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);

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
      setCategories(cats);
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

  const visibleNotes =
    filterCategories.size === 0 ? notes : notes.filter((n) => n.categories.some((c) => filterCategories.has(c)));

  // 匯出目前列表（有分類篩選/搜尋就只匯出篩選後的結果）
  const exportExcel = async () => {
    setError('');
    setExporting(true);
    try {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('記事本');
      sheet.columns = [
        { header: '分類', key: 'categories', width: 16 },
        { header: '日期', key: 'date', width: 12 },
        { header: '加入日期', key: 'createdDate', width: 12 },
        { header: '內容', key: 'content', width: 40 },
        { header: '關聯', key: 'related', width: 16 },
        { header: '記錄者', key: 'author', width: 12 },
      ];
      for (const n of visibleNotes) {
        sheet.addRow({
          categories: n.categories.join('、'),
          date: n.note_date,
          createdDate: n.created_at?.slice(0, 10),
          content: n.content,
          related: [n.related_student_name, n.related_teacher_name].filter(Boolean).join('、'),
          author: n.author_name,
        });
      }
      applyExportStyle(sheet);
      await saveWorkbookAs(workbook, `記事本 ${todayStr()}.xlsx`);
    } catch (err) {
      setError('匯出失敗：' + err.message);
    } finally {
      setExporting(false);
    }
  };

  const toggleFilterCategory = (cat) => {
    setFilterCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const startEdit = (note) => {
    setEditingId(note.id);
    setForm({
      content: note.content,
      note_date: note.note_date,
      categories: note.categories.length > 0 ? note.categories : ['待辦'],
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

  const toggleFormCategory = (cat) => {
    setForm((f) => ({
      ...f,
      categories: f.categories.includes(cat) ? f.categories.filter((c) => c !== cat) : [...f.categories, cat],
    }));
  };

  const addNewCategory = () => {
    const name = newCategoryInput.trim();
    if (!name) return;
    setCategories((prev) => (prev.includes(name) ? prev : [...prev, name]));
    setForm((f) => (f.categories.includes(name) ? f : { ...f, categories: [...f.categories, name] }));
    setNewCategoryInput('');
  };

  // 刪除分類：連同所有已存在記事中的該分類文字一併移除（後端持久化），不會刪除記事本身
  const removeCategory = async (cat) => {
    if (!confirm(`確定要刪除分類「${cat}」嗎？所有記事上的此分類標籤都會一併移除。`)) return;
    setError('');
    try {
      await api.del(`/api/schools/${currentSchoolId}/notes/categories/${encodeURIComponent(cat)}`);
    } catch (err) {
      setError(err.message);
      return;
    }
    setCategories((prev) => prev.filter((c) => c !== cat));
    setForm((f) => ({ ...f, categories: f.categories.filter((c) => c !== cat) }));
    setFilterCategories((prev) => {
      if (!prev.has(cat)) return prev;
      const next = new Set(prev);
      next.delete(cat);
      return next;
    });
    load();
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!form.content.trim()) return;
    if (form.categories.length === 0) {
      setError('請至少選擇一個分類');
      return;
    }
    setError('');
    const payload = {
      content: form.content.trim(),
      note_date: form.note_date,
      categories: form.categories,
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
    const idsInRange = visibleNotes.filter((n) => n.note_date >= from && n.note_date <= to).map((n) => n.id);
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
    const doneIds = visibleNotes.filter((n) => n.done).map((n) => n.id);
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
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>記事本</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button disabled={exporting} onClick={exportExcel}>
            {exporting ? '匯出中...' : '匯出 Excel'}
          </button>
          <Link to="/notes/trash"><button type="button">回收桶</button></Link>
        </div>
      </div>
      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}

      {!showForm && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
          <button type="button" onClick={() => setShowForm(true)}>
            + 新增記事
          </button>
          <button type="button" onClick={toggleDeleteMode}>
            {deleteMode ? '結束刪除模式' : '刪除模式'}
          </button>
          <input
            type="text"
            placeholder="搜尋記事內容..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: '100%', maxWidth: 320 }}
          />
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
        <div>
          <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>分類（可複選）</span>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 4 }}>
            {categories.map((cat) => (
              <span key={cat} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexDirection: 'row' }}>
                  <input
                    type="checkbox"
                    checked={form.categories.includes(cat)}
                    onChange={() => toggleFormCategory(cat)}
                  />
                  {cat}
                </label>
                {showDeleteCategory && (
                  <button
                    type="button"
                    title="刪除分類"
                    onClick={() => removeCategory(cat)}
                    style={{ fontSize: 10, lineHeight: 1, padding: '2px 5px', color: 'var(--text-muted)' }}
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
          </div>
        </div>
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

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <button
          type="button"
          onClick={() => setFilterCategories(new Set())}
          style={
            filterCategories.size === 0
              ? { background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' }
              : undefined
          }
        >
          全部
        </button>
        {categories.map((cat) => {
          const deletable = showDeleteCategory;
          return (
            <button
              key={cat}
              type="button"
              title={deletable ? `刪除分類「${cat}」` : undefined}
              onClick={() => (deletable ? removeCategory(cat) : toggleFilterCategory(cat))}
              style={
                deletable
                  ? { background: 'var(--danger-soft)', color: 'var(--danger)', borderColor: 'var(--danger)' }
                  : filterCategories.has(cat)
                    ? { background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' }
                    : undefined
              }
            >
              {deletable ? `${cat} ×` : cat}
            </button>
          );
        })}
        <button
          type="button"
          title="新增分類"
          onClick={() => setShowAddCategory((v) => !v)}
          style={categorySymbolBtnStyle(showAddCategory)}
        >
          +
        </button>
        <button
          type="button"
          title="刪除分類"
          onClick={() => setShowDeleteCategory((v) => !v)}
          style={categorySymbolBtnStyle(showDeleteCategory)}
        >
          -
        </button>
      </div>

      {showAddCategory && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <input
            type="text"
            placeholder="新增自訂分類..."
            value={newCategoryInput}
            onChange={(e) => setNewCategoryInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addNewCategory();
              }
            }}
            style={{ maxWidth: 200 }}
          />
          <button type="button" onClick={addNewCategory}>新增分類</button>
        </div>
      )}

      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid var(--border-strong)' }}>
            <th>
              {deleteMode ? (
                '選取'
              ) : (
                <button
                  type="button"
                  onClick={deleteDoneNotes}
                  style={{
                    font: 'inherit',
                    textTransform: 'inherit',
                    letterSpacing: 'inherit',
                    color: 'inherit',
                    fontWeight: 'inherit',
                    border: '1px solid var(--border-strong)',
                    borderRadius: 'var(--radius)',
                    background: 'var(--surface)',
                    padding: '3px 8px',
                    cursor: 'pointer',
                  }}
                >
                  清除
                </button>
              )}
            </th>
            <th>分類</th>
            <th>日期</th>
            <th>加入日期</th>
            <th>內容</th>
            <th>關聯</th>
            <th>記錄者</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {visibleNotes.map((n) => (
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
              <td>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {n.categories.map((cat) => (
                    <span key={cat} className="pill">{cat}</span>
                  ))}
                </div>
              </td>
              <td style={{ whiteSpace: 'nowrap' }}>{n.note_date}</td>
              <td style={{ whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>{n.created_at?.slice(0, 10)}</td>
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
          {visibleNotes.length === 0 && (
            <tr>
              <td colSpan={7} style={{ color: 'var(--text-muted)', padding: 12 }}>尚無記事</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
