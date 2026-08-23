import { Fragment, useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { subscribeSchool } from '../socket';
import { slotRangeLabel, slotToTime } from '../lib/time';

const STATUS_LABEL = { present: '出席', absent: '缺席', leave: '請假' };
const TYPE_LABEL = { regular: '固定', makeup: '調課', extra: '加課' };

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

export default function InvoiceDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { currentSchoolId, currentMembership } = useAuth();
  const isAdmin = currentMembership?.role === 'admin';

  const [student, setStudent] = useState(null);
  const [teachers, setTeachers] = useState([]);
  const [month, setMonth] = useState(currentMonth());
  const [sessions, setSessions] = useState([]);
  const [checked, setChecked] = useState(new Set());
  const [staged, setStaged] = useState([]); // 跨月累積的待開立清單
  const [invoices, setInvoices] = useState([]);
  const [expandedInvoice, setExpandedInvoice] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 2500);
    return () => clearTimeout(timer);
  }, [notice]);

  const loadSessions = useCallback(async () => {
    if (!currentSchoolId || !id) return;
    const rows = await api.get(`/api/schools/${currentSchoolId}/invoices/sessions?student_id=${id}&month=${month}`);
    setSessions(rows);
    setChecked(new Set());
  }, [currentSchoolId, id, month]);

  const loadInvoices = useCallback(async () => {
    if (!currentSchoolId || !id) return;
    setInvoices(await api.get(`/api/schools/${currentSchoolId}/invoices?student_id=${id}`));
  }, [currentSchoolId, id]);

  const loadStudent = useCallback(async () => {
    if (!currentSchoolId || !id) return;
    setStudent(await api.get(`/api/schools/${currentSchoolId}/students/${id}`));
    setTeachers(await api.get(`/api/schools/${currentSchoolId}/teachers`));
  }, [currentSchoolId, id]);

  useEffect(() => {
    loadStudent();
  }, [loadStudent]);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    loadInvoices();
  }, [loadInvoices]);

  useEffect(() => {
    if (!currentSchoolId) return;
    return subscribeSchool(currentSchoolId, (resource) => {
      if (['sessions', 'attendance', 'schedule'].includes(resource)) loadSessions();
      if (resource === 'finance') loadInvoices();
    });
  }, [currentSchoolId, loadSessions, loadInvoices]);

  if (!isAdmin) return <p>僅管理者可使用繳費單系統</p>;
  if (!student) return <p>載入中...</p>;

  const teacherName = (tid) => teachers.find((t) => t.id === tid)?.name || '未知';
  const stagedIds = new Set(staged.map((i) => i.session_id));

  const toggleChecked = (sessionId) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  };

  const selectableSessions = sessions.filter(
    (s) => s.attendance_status === 'present' && !s.invoiced && !stagedIds.has(s.session_id)
  );
  const allSelected = selectableSessions.length > 0 && selectableSessions.every((s) => checked.has(s.session_id));
  const toggleSelectAll = () => {
    setChecked(allSelected ? new Set() : new Set(selectableSessions.map((s) => s.session_id)));
  };

  const addToStaged = () => {
    setError('');
    const toAdd = sessions.filter((s) => checked.has(s.session_id) && !stagedIds.has(s.session_id));
    if (toAdd.length === 0) return;
    setStaged((prev) => [
      ...prev,
      ...toAdd.map((s) => ({
        session_id: s.session_id,
        session_date: s.session_date,
        subject: s.subject,
        teacher_id: s.teacher_id,
        unit_price: s.unit_price,
      })),
    ]);
    setChecked(new Set());
  };

  const removeStaged = (sessionId) => {
    setStaged((prev) => prev.filter((i) => i.session_id !== sessionId));
  };

  const issueInvoice = async () => {
    if (staged.length === 0) return;
    setError('');
    try {
      await api.post(`/api/schools/${currentSchoolId}/invoices`, {
        student_id: id,
        session_ids: staged.map((i) => i.session_id),
      });
      setStaged([]);
      loadSessions();
      loadInvoices();
      setNotice('繳費單已開立');
    } catch (err) {
      setError(err.message);
    }
  };

  const toggleExpandInvoice = async (invoice) => {
    if (expandedInvoice?.id === invoice.id) {
      setExpandedInvoice(null);
      return;
    }
    const detail = await api.get(`/api/schools/${currentSchoolId}/invoices/${invoice.id}`);
    setExpandedInvoice(detail);
  };

  const deleteInvoice = async (invoice) => {
    if (!confirm(`確定要刪除這張繳費單嗎？（${invoice.issued_date}，共 ${invoice.item_count} 堂，${invoice.total_amount} 元）刪除後其中的課堂可以重新開立。`)) return;
    setError('');
    try {
      await api.del(`/api/schools/${currentSchoolId}/invoices/${invoice.id}`);
      if (expandedInvoice?.id === invoice.id) setExpandedInvoice(null);
      loadInvoices();
      loadSessions();
    } catch (err) {
      setError(err.message);
    }
  };

  const stagedTotal = staged.reduce((sum, i) => sum + i.unit_price, 0);

  return (
    <div>
      <button onClick={() => navigate('/invoices')}>← 返回學生列表</button>
      <h2 style={{ marginTop: 12 }}>{student.name} - 繳費單開立</h2>

      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
        <h3 style={{ margin: 0 }}>上課明細</h3>
        <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid var(--border-strong)' }}>
            <th>
              <input
                type="checkbox"
                disabled={selectableSessions.length === 0}
                checked={allSelected}
                onChange={toggleSelectAll}
              />
            </th>
            <th>日期</th>
            <th>時段</th>
            <th>科目</th>
            <th>教師</th>
            <th>類型</th>
            <th>備註</th>
            <th>出缺勤</th>
            <th>單堂價錢</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => {
            const alreadyStaged = stagedIds.has(s.session_id);
            const selectable = s.attendance_status === 'present' && !s.invoiced && !alreadyStaged;
            return (
              <tr key={s.session_id} style={{ borderBottom: '1px solid var(--border)' }}>
                <td>
                  {s.invoiced ? (
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>已開立</span>
                  ) : alreadyStaged ? (
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>已加入</span>
                  ) : (
                    <input
                      type="checkbox"
                      disabled={!selectable}
                      checked={checked.has(s.session_id)}
                      onChange={() => toggleChecked(s.session_id)}
                    />
                  )}
                </td>
                <td>{s.session_date}</td>
                <td>{slotRangeLabel(s.start_slot, s.duration_slots)}</td>
                <td>{s.subject}</td>
                <td>{teacherName(s.teacher_id)}</td>
                <td>{TYPE_LABEL[s.type]}</td>
                <td>
                  {s.type === 'makeup' && s.origin_session_date && (
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      調課自 {s.origin_session_date} {slotToTime(s.origin_start_slot)}
                    </span>
                  )}
                </td>
                <td>{s.attendance_status ? STATUS_LABEL[s.attendance_status] : '尚未點名'}</td>
                <td>{s.unit_price}</td>
              </tr>
            );
          })}
          {sessions.length === 0 && (
            <tr><td colSpan={9} style={{ color: 'var(--text-muted)', padding: 12 }}>這個月無課堂紀錄</td></tr>
          )}
        </tbody>
      </table>
      <div style={{ marginTop: 8 }}>
        <button disabled={checked.size === 0} onClick={addToStaged}>加入繳費單開立清單</button>
      </div>

      <h3 style={{ marginTop: 24 }}>待開立清單</h3>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid var(--border-strong)' }}>
            <th>日期</th>
            <th>科目</th>
            <th>教師</th>
            <th>單堂價錢</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {staged.map((i) => (
            <tr key={i.session_id} style={{ borderBottom: '1px solid var(--border)' }}>
              <td>{i.session_date}</td>
              <td>{i.subject}</td>
              <td>{teacherName(i.teacher_id)}</td>
              <td>{i.unit_price}</td>
              <td><button onClick={() => removeStaged(i.session_id)}>刪除</button></td>
            </tr>
          ))}
          {staged.length === 0 && (
            <tr><td colSpan={5} style={{ color: 'var(--text-muted)', padding: 12 }}>尚未加入任何課堂</td></tr>
          )}
        </tbody>
      </table>
      {staged.length > 0 && (
        <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>共 {staged.length} 堂，合計 {stagedTotal} 元</p>
      )}
      <div>
        <button disabled={staged.length === 0} onClick={issueInvoice}>開立繳費單</button>
      </div>

      <h3 style={{ marginTop: 24 }}>已開立繳費單</h3>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid var(--border-strong)' }}>
            <th>開立日期</th>
            <th>堂數</th>
            <th>金額</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((inv) => (
            <Fragment key={inv.id}>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <td>{inv.issued_date}</td>
                <td>{inv.item_count}</td>
                <td>{inv.total_amount}</td>
                <td>
                  <button onClick={() => toggleExpandInvoice(inv)}>
                    {expandedInvoice?.id === inv.id ? '收合明細' : '查看明細'}
                  </button>{' '}
                  <button onClick={() => deleteInvoice(inv)}>刪除</button>
                </td>
              </tr>
              {expandedInvoice?.id === inv.id && (
                <tr>
                  <td colSpan={4} style={{ background: 'var(--surface-muted)', padding: 8 }}>
                    <table style={{ width: '100%', fontSize: 12 }}>
                      <thead>
                        <tr>
                          <th style={{ textAlign: 'left' }}>日期</th>
                          <th style={{ textAlign: 'left' }}>科目</th>
                          <th style={{ textAlign: 'left' }}>類型</th>
                          <th style={{ textAlign: 'left' }}>備註</th>
                          <th style={{ textAlign: 'left' }}>單堂價錢</th>
                        </tr>
                      </thead>
                      <tbody>
                        {expandedInvoice.items.map((it) => (
                          <tr key={it.id}>
                            <td>{it.session_date}</td>
                            <td>{it.subject}</td>
                            <td>{TYPE_LABEL[it.type]}</td>
                            <td>
                              {it.type === 'makeup' && it.origin_session_date && (
                                <span style={{ color: 'var(--text-muted)' }}>
                                  調課自 {it.origin_session_date} {slotToTime(it.origin_start_slot)}
                                </span>
                              )}
                            </td>
                            <td>{it.unit_price}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
          {invoices.length === 0 && (
            <tr><td colSpan={4} style={{ color: 'var(--text-muted)', padding: 12 }}>尚無已開立的繳費單</td></tr>
          )}
        </tbody>
      </table>

      {notice && (
        <div
          style={{
            position: 'fixed',
            bottom: 24,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'var(--accent)',
            color: '#fff',
            padding: '10px 20px',
            borderRadius: 6,
            boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
            fontSize: 14,
          }}
        >
          {notice}
        </div>
      )}
    </div>
  );
}
