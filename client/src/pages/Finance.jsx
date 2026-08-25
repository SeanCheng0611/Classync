import { Fragment, useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import ExcelJS from 'exceljs';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { subscribeSchool } from '../socket';
import { slotToTime, slotRangeLabel, todayStr } from '../lib/time';
import { saveWorkbookAs, applyExportStyle } from '../lib/excelExport';

const CATEGORY_LABEL = { tuition: '學費', salary: '薪資', manual: '其他' };
const TYPE_LABEL = { regular: '固定', makeup: '調課', extra: '加課' };

function currentMonth() {
  return todayStr().slice(0, 7);
}

function monthRangeStr(month) {
  const [y, m] = month.split('-').map(Number);
  const start = `${month}-01`;
  const end = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return [start, end];
}

const emptyForm = { entry_type: 'expense', amount: '', entry_date: '', note: '' };

export default function Finance() {
  const { currentSchoolId, currentMembership } = useAuth();
  const isAdmin = currentMembership?.role === 'admin';

  const [month, setMonth] = useState(currentMonth());
  const [entries, setEntries] = useState([]);
  const [summary, setSummary] = useState(null);
  const [teachers, setTeachers] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [showForm, setShowForm] = useState(false);
  const [detailFor, setDetailFor] = useState(null); // teacher_id currently expanded
  const [detailItems, setDetailItems] = useState([]);
  const [editingEntry, setEditingEntry] = useState(null);
  const [editAmount, setEditAmount] = useState('');
  const [editDate, setEditDate] = useState('');
  const [editNote, setEditNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');

  const [start, end] = monthRangeStr(month);

  const load = useCallback(async () => {
    if (!currentSchoolId) return;
    const [e, s, t] = await Promise.all([
      api.get(`/api/schools/${currentSchoolId}/finance/ledger?start=${start}&end=${end}`),
      api.get(`/api/schools/${currentSchoolId}/finance/summary?start=${start}&end=${end}`),
      api.get(`/api/schools/${currentSchoolId}/teachers`),
    ]);
    setEntries(e);
    setSummary(s);
    setTeachers(t);
  }, [currentSchoolId, start, end]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!currentSchoolId) return;
    return subscribeSchool(currentSchoolId, (resource) => {
      if (resource === 'finance') load();
    });
  }, [currentSchoolId, load]);

  if (!isAdmin) return <p>僅管理者可查看收支統計</p>;

  const teacherName = (id) => teachers.find((t) => t.id === id)?.name || '未知';

  const generateTuition = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api.post(`/api/schools/${currentSchoolId}/finance/generate-tuition`, { month });
      alert(`新增 ${r.created} 筆，更新 ${r.updated} 筆學費收入（已存在的會同步為最新的實收金額）`);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const generateSalary = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api.post(`/api/schools/${currentSchoolId}/finance/generate-salary`, { month });
      alert(`新增 ${r.created} 筆，更新 ${r.updated} 筆教師薪資支出（已存在的會同步為最新的排課時數）`);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const submitManual = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api.post(`/api/schools/${currentSchoolId}/finance/ledger`, {
        entry_type: form.entry_type,
        amount: Number(form.amount),
        entry_date: form.entry_date || `${month}-01`,
        note: form.note.trim() || null,
      });
      setForm(emptyForm);
      setShowForm(false);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const startEditEntry = (entry) => {
    setEditingEntry(entry.id);
    setEditAmount(entry.amount);
    setEditDate(entry.entry_date);
    setEditNote(entry.note || '');
  };

  const saveEditEntry = async (entry) => {
    setError('');
    try {
      await api.put(`/api/schools/${currentSchoolId}/finance/ledger/${entry.id}`, {
        amount: Number(editAmount),
        entry_date: editDate,
        note: editNote.trim() || null,
      });
      setEditingEntry(null);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const removeEntry = async (entry) => {
    if (!confirm('確定要刪除這筆明細嗎？')) return;
    await api.del(`/api/schools/${currentSchoolId}/finance/ledger/${entry.id}`);
    load();
  };

  const toggleDetail = async (entry) => {
    if (entry.category === 'manual') return;
    if (detailFor === entry.id) {
      setDetailFor(null);
      return;
    }
    const items = await api.get(`/api/schools/${currentSchoolId}/finance/ledger/${entry.id}/detail`);
    setDetailItems(items);
    setDetailFor(entry.id);
  };

  // 匯出當月收支明細
  const exportExcel = async () => {
    setError('');
    setExporting(true);
    try {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('收支明細');
      sheet.columns = [
        { header: '日期', key: 'date', width: 12 },
        { header: '類型', key: 'type', width: 8 },
        { header: '分類', key: 'category', width: 10 },
        { header: '金額', key: 'amount', width: 12 },
        { header: '備註', key: 'note', width: 30 },
      ];
      for (const e of entries) {
        sheet.addRow({
          date: e.entry_date,
          type: e.entry_type === 'income' ? '收入' : '支出',
          category: CATEGORY_LABEL[e.category],
          amount: e.amount,
          note: e.note,
        });
      }
      applyExportStyle(sheet);
      await saveWorkbookAs(workbook, `收支明細 ${month}.xlsx`);
    } catch (err) {
      setError('匯出失敗：' + err.message);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>收支統計</h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
          {isAdmin && (
            <button disabled={exporting} onClick={exportExcel}>
              {exporting ? '匯出中...' : '匯出 Excel'}
            </button>
          )}
          {isAdmin && <Link to="/finance/trash"><button type="button">回收桶</button></Link>}
        </div>
      </div>

      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}

      {summary && (
        <div style={{ display: 'flex', gap: 16, marginTop: 12 }}>
          <div className="stat-tile">
            <div className="label">收入</div>
            <div className="value">{summary.income.toLocaleString()}</div>
          </div>
          <div className="stat-tile">
            <div className="label">支出</div>
            <div className="value">{summary.expense.toLocaleString()}</div>
          </div>
          <div className="stat-tile">
            <div className="label">淨額</div>
            <div className="value" style={{ color: summary.net >= 0 ? 'var(--success)' : 'var(--danger)' }}>
              {summary.net.toLocaleString()}
            </div>
          </div>
        </div>
      )}

      <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
        <button disabled={busy} onClick={generateTuition}>產生本月學費</button>
        <button disabled={busy} onClick={generateSalary}>產生本月教師薪資</button>
        <button onClick={() => setShowForm((v) => !v)}>{showForm ? '取消新增' : '+ 手動新增收支'}</button>
      </div>

      {showForm && (
        <form onSubmit={submitManual} style={{ marginTop: 12, display: 'grid', gap: 8, maxWidth: 360 }}>
          <label>
            類型
            <select value={form.entry_type} onChange={(e) => setForm({ ...form, entry_type: e.target.value })}>
              <option value="income">收入</option>
              <option value="expense">支出</option>
            </select>
          </label>
          <label>
            金額
            <input type="number" required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          </label>
          <label>
            日期
            <input type="date" value={form.entry_date} onChange={(e) => setForm({ ...form, entry_date: e.target.value })} />
          </label>
          <label>
            備註
            <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </label>
          <div><button type="submit">儲存</button></div>
        </form>
      )}

      <h3 style={{ marginTop: 24 }}>明細</h3>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid var(--border-strong)' }}>
            <th>日期</th>
            <th>類型</th>
            <th>分類</th>
            <th>實收/實付金額</th>
            <th>備註</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <Fragment key={e.id}>
              {editingEntry === e.id ? (
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <td><input type="date" value={editDate} onChange={(ev) => setEditDate(ev.target.value)} /></td>
                  <td style={{ color: e.entry_type === 'income' ? 'var(--success)' : 'var(--danger)' }}>
                    {e.entry_type === 'income' ? '收入' : '支出'}
                  </td>
                  <td>{CATEGORY_LABEL[e.category]}</td>
                  <td><input type="number" style={{ width: 100 }} value={editAmount} onChange={(ev) => setEditAmount(ev.target.value)} /></td>
                  <td><input value={editNote} onChange={(ev) => setEditNote(ev.target.value)} /></td>
                  <td>
                    <button onClick={() => saveEditEntry(e)}>儲存</button>{' '}
                    <button onClick={() => setEditingEntry(null)}>取消</button>
                  </td>
                </tr>
              ) : (
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <td>{e.entry_date}</td>
                  <td style={{ color: e.entry_type === 'income' ? 'var(--success)' : 'var(--danger)' }}>
                    {e.entry_type === 'income' ? '收入' : '支出'}
                  </td>
                  <td>{CATEGORY_LABEL[e.category]}</td>
                  <td>{e.amount.toLocaleString()}</td>
                  <td>
                    {e.note}
                    {e.category !== 'manual' && (
                      <button style={{ marginLeft: 8, fontSize: 11 }} onClick={() => toggleDetail(e)}>
                        {detailFor === e.id ? '收合明細' : '查看明細'}
                      </button>
                    )}
                  </td>
                  <td>
                    <button onClick={() => startEditEntry(e)}>編輯</button>{' '}
                    <button onClick={() => removeEntry(e)}>刪除</button>
                  </td>
                </tr>
              )}
              {detailFor === e.id && (
                <tr>
                  <td colSpan={6} style={{ background: 'var(--surface-muted)', padding: 8 }}>
                    <table style={{ width: '100%', fontSize: 12 }}>
                      <thead>
                        {e.category === 'salary' ? (
                          <tr>
                            <th style={{ textAlign: 'left' }}>日期</th>
                            <th style={{ textAlign: 'left' }}>時段</th>
                            <th style={{ textAlign: 'left' }}>科目</th>
                            <th style={{ textAlign: 'left' }}>類型</th>
                            <th style={{ textAlign: 'left' }}>備註</th>
                            <th style={{ textAlign: 'left' }}>學生</th>
                            <th style={{ textAlign: 'left' }}>時數</th>
                            <th style={{ textAlign: 'left' }}>適用時薪</th>
                            <th style={{ textAlign: 'left' }}>金額</th>
                          </tr>
                        ) : (
                          <tr>
                            <th style={{ textAlign: 'left' }}>日期</th>
                            <th style={{ textAlign: 'left' }}>時段</th>
                            <th style={{ textAlign: 'left' }}>科目</th>
                            <th style={{ textAlign: 'left' }}>類型</th>
                            <th style={{ textAlign: 'left' }}>備註</th>
                            <th style={{ textAlign: 'left' }}>單堂價錢</th>
                          </tr>
                        )}
                      </thead>
                      <tbody>
                        {detailItems.map((i) =>
                          e.category === 'salary' ? (
                            <tr key={i.session_id}>
                              <td>{i.session_date}</td>
                              <td>{i.start_slot != null ? slotRangeLabel(i.start_slot, i.duration_slots) : '-'}</td>
                              <td>{i.subject}</td>
                              <td>{TYPE_LABEL[i.type] || '-'}</td>
                              <td>
                                {i.type === 'makeup' && i.origin_session_date && (
                                  <span style={{ color: 'var(--text-muted)' }}>
                                    調課自 {i.origin_session_date} {slotToTime(i.origin_start_slot)}
                                  </span>
                                )}
                              </td>
                              <td>{i.student_names.join(', ')}</td>
                              <td>{i.hours}</td>
                              <td>{i.rate}</td>
                              <td>{i.pay}</td>
                            </tr>
                          ) : (
                            <tr key={i.session_id}>
                              <td>{i.session_date || '-'}</td>
                              <td>{i.start_slot != null ? slotRangeLabel(i.start_slot, i.duration_slots) : '-'}</td>
                              <td>{i.subject}</td>
                              <td>{i.type ? TYPE_LABEL[i.type] : '-'}</td>
                              <td>
                                {i.type === 'makeup' && i.origin_session_date && (
                                  <span style={{ color: 'var(--text-muted)' }}>
                                    調課自 {i.origin_session_date} {slotToTime(i.origin_start_slot)}
                                  </span>
                                )}
                              </td>
                              <td>{i.unit_price}</td>
                            </tr>
                          )
                        )}
                        {detailItems.length === 0 && (
                          <tr><td colSpan={e.category === 'salary' ? 9 : 6} style={{ color: 'var(--text-muted)', padding: 8 }}>無逐堂明細（可能依估算金額產生）</td></tr>
                        )}
                      </tbody>
                    </table>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
          {entries.length === 0 && (
            <tr><td colSpan={6} style={{ color: 'var(--text-muted)', padding: 12 }}>這個月尚無收支紀錄</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
