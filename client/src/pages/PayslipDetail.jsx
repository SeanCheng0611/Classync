import { Fragment, useEffect, useState, useCallback } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { subscribeSchool } from '../socket';
import { slotToTime, slotRangeLabel, todayStr } from '../lib/time';

const TYPE_LABEL = { regular: '固定', makeup: '調課', extra: '加課' };

function currentMonth() {
  return todayStr().slice(0, 7);
}

export default function PayslipDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { currentSchoolId, currentMembership } = useAuth();
  const isAdmin = currentMembership?.role === 'admin';

  const [teacher, setTeacher] = useState(null);
  const [month, setMonth] = useState(currentMonth());
  const [sessions, setSessions] = useState([]);
  const [checked, setChecked] = useState(new Set());
  const [staged, setStaged] = useState([]); // 跨月累積的待開立清單
  const [payslips, setPayslips] = useState([]);
  const [expandedPayslip, setExpandedPayslip] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 2500);
    return () => clearTimeout(timer);
  }, [notice]);

  const loadSessions = useCallback(async () => {
    if (!currentSchoolId || !id) return;
    const rows = await api.get(`/api/schools/${currentSchoolId}/payslips/sessions?teacher_id=${id}&month=${month}`);
    setSessions(rows);
    setChecked(new Set());
  }, [currentSchoolId, id, month]);

  const loadPayslips = useCallback(async () => {
    if (!currentSchoolId || !id) return;
    setPayslips(await api.get(`/api/schools/${currentSchoolId}/payslips?teacher_id=${id}`));
  }, [currentSchoolId, id]);

  const loadTeacher = useCallback(async () => {
    if (!currentSchoolId || !id) return;
    setTeacher(await api.get(`/api/schools/${currentSchoolId}/teachers/${id}`));
  }, [currentSchoolId, id]);

  useEffect(() => {
    loadTeacher();
  }, [loadTeacher]);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    loadPayslips();
  }, [loadPayslips]);

  useEffect(() => {
    if (!currentSchoolId) return;
    return subscribeSchool(currentSchoolId, (resource) => {
      if (['sessions', 'attendance', 'schedule'].includes(resource)) loadSessions();
      if (resource === 'finance') loadPayslips();
    });
  }, [currentSchoolId, loadSessions, loadPayslips]);

  if (!isAdmin) return <p>僅管理者可使用薪資系統</p>;
  if (!teacher) return <p>載入中...</p>;

  const stagedIds = new Set(staged.map((i) => i.session_id));

  const toggleChecked = (sessionId) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  };

  // 未來還沒發生的課堂、或還有學生尚未點名的課堂，都不能先開立薪資
  const isFutureSession = (s) => s.session_date > todayStr();
  const selectableSessions = sessions.filter(
    (s) => !s.issued && !stagedIds.has(s.session_id) && !s.fully_on_leave && !isFutureSession(s) && !s.not_yet_marked
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
        start_slot: s.start_slot,
        duration_slots: s.duration_slots,
        subject: s.subject,
        type: s.type,
        is_admin: s.is_admin,
        student_names: s.student_names,
        hours: s.hours,
        rate: s.rate,
        pay: s.pay,
      })),
    ]);
    setChecked(new Set());
  };

  const removeStaged = (sessionId) => {
    setStaged((prev) => prev.filter((i) => i.session_id !== sessionId));
  };

  const issuePayslip = async () => {
    if (staged.length === 0) return;
    setError('');
    try {
      await api.post(`/api/schools/${currentSchoolId}/payslips`, {
        teacher_id: id,
        session_ids: staged.map((i) => i.session_id),
      });
      setStaged([]);
      loadSessions();
      loadPayslips();
      setNotice('薪資條已開立');
    } catch (err) {
      setError(err.message);
    }
  };

  const toggleExpandPayslip = async (payslip) => {
    if (expandedPayslip?.id === payslip.id) {
      setExpandedPayslip(null);
      return;
    }
    const detail = await api.get(`/api/schools/${currentSchoolId}/payslips/${payslip.id}`);
    setExpandedPayslip(detail);
  };

  const deletePayslip = async (payslip) => {
    if (!confirm(`確定要刪除這張薪資條嗎？（${payslip.issued_date}，共 ${payslip.item_count} 堂，${payslip.total_amount} 元）刪除後其中的課堂可以重新開立。`)) return;
    setError('');
    try {
      await api.del(`/api/schools/${currentSchoolId}/payslips/${payslip.id}`);
      if (expandedPayslip?.id === payslip.id) setExpandedPayslip(null);
      loadPayslips();
      loadSessions();
    } catch (err) {
      setError(err.message);
    }
  };

  const stagedTotal = staged.reduce((sum, i) => sum + i.pay, 0);

  return (
    <div>
      <button onClick={() => navigate('/payslips')}>← 返回教師列表</button>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
        <h2 style={{ margin: 0 }}>{teacher.name} - 薪資條開立</h2>
        {isAdmin && <Link to="/payslips/trash"><button type="button">回收桶</button></Link>}
      </div>

      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
        <h3 style={{ margin: 0 }}>授課明細</h3>
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
            <th>類型</th>
            <th>備註</th>
            <th>學生</th>
            <th>狀態</th>
            <th>時數</th>
            <th>時薪</th>
            <th>金額</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => {
            const alreadyStaged = stagedIds.has(s.session_id);
            const selectable = !s.issued && !alreadyStaged && !s.fully_on_leave && !isFutureSession(s) && !s.not_yet_marked;
            return (
              <tr
                key={s.session_id}
                style={{
                  borderBottom: '1px solid var(--border)',
                  ...(s.fully_on_leave ? { color: 'var(--text-muted)', background: 'var(--surface-muted)' } : {}),
                }}
              >
                <td>
                  {s.issued ? (
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
                <td>{TYPE_LABEL[s.type]}</td>
                <td>
                  {s.type === 'makeup' && s.origin_session_date && (
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      調課自 {s.origin_session_date} {slotToTime(s.origin_start_slot)}
                    </span>
                  )}
                </td>
                <td>{s.is_admin ? '行政' : s.student_names.join('、')}</td>
                <td>
                  {s.fully_on_leave
                    ? s.leave_is_makeup ? '已調課' : '已請假'
                    : isFutureSession(s)
                    ? '尚未發生'
                    : s.not_yet_marked
                    ? '尚未點名'
                    : '-'}
                </td>
                <td>{s.hours}</td>
                <td>{s.rate}</td>
                <td>{s.pay}</td>
              </tr>
            );
          })}
          {sessions.length === 0 && (
            <tr><td colSpan={11} style={{ color: 'var(--text-muted)', padding: 12 }}>這個月無課堂紀錄</td></tr>
          )}
        </tbody>
      </table>
      <div style={{ marginTop: 8 }}>
        <button disabled={checked.size === 0} onClick={addToStaged}>加入薪資條開立清單</button>
      </div>

      <h3 style={{ marginTop: 24 }}>待開立清單</h3>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid var(--border-strong)' }}>
            <th>日期</th>
            <th>時段</th>
            <th>科目</th>
            <th>類型</th>
            <th>學生</th>
            <th>時數</th>
            <th>金額</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {staged.map((i) => (
            <tr key={i.session_id} style={{ borderBottom: '1px solid var(--border)' }}>
              <td>{i.session_date}</td>
              <td>{slotRangeLabel(i.start_slot, i.duration_slots)}</td>
              <td>{i.subject}</td>
              <td>{TYPE_LABEL[i.type]}</td>
              <td>{i.is_admin ? '行政' : i.student_names.join('、')}</td>
              <td>{i.hours}</td>
              <td>{i.pay}</td>
              <td><button onClick={() => removeStaged(i.session_id)}>刪除</button></td>
            </tr>
          ))}
          {staged.length === 0 && (
            <tr><td colSpan={8} style={{ color: 'var(--text-muted)', padding: 12 }}>尚未加入任何課堂</td></tr>
          )}
        </tbody>
      </table>
      {staged.length > 0 && (
        <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>共 {staged.length} 堂，合計 {stagedTotal} 元</p>
      )}
      <div>
        <button disabled={staged.length === 0} onClick={issuePayslip}>開立薪資條</button>
      </div>

      <h3 style={{ marginTop: 24 }}>已開立薪資條</h3>
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
          {payslips.map((p) => (
            <Fragment key={p.id}>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <td>{p.issued_date}</td>
                <td>{p.item_count}</td>
                <td>{p.total_amount}</td>
                <td>
                  <button onClick={() => toggleExpandPayslip(p)}>
                    {expandedPayslip?.id === p.id ? '收合明細' : '查看明細'}
                  </button>{' '}
                  <button onClick={() => deletePayslip(p)}>刪除</button>
                </td>
              </tr>
              {expandedPayslip?.id === p.id && (
                <tr>
                  <td colSpan={4} style={{ background: 'var(--surface-muted)', padding: 8 }}>
                    <table style={{ width: '100%', fontSize: 12 }}>
                      <thead>
                        <tr>
                          <th style={{ textAlign: 'left' }}>日期</th>
                          <th style={{ textAlign: 'left' }}>時段</th>
                          <th style={{ textAlign: 'left' }}>科目</th>
                          <th style={{ textAlign: 'left' }}>類型</th>
                          <th style={{ textAlign: 'left' }}>備註</th>
                          <th style={{ textAlign: 'left' }}>學生</th>
                          <th style={{ textAlign: 'left' }}>時數</th>
                          <th style={{ textAlign: 'left' }}>金額</th>
                        </tr>
                      </thead>
                      <tbody>
                        {expandedPayslip.items.map((it) => (
                          <tr key={it.id}>
                            <td>{it.session_date}</td>
                            <td>{slotRangeLabel(it.start_slot, it.duration_slots)}</td>
                            <td>{it.subject}</td>
                            <td>{TYPE_LABEL[it.type]}</td>
                            <td>
                              {it.type === 'makeup' && it.origin_session_date && (
                                <span style={{ color: 'var(--text-muted)' }}>
                                  調課自 {it.origin_session_date} {slotToTime(it.origin_start_slot)}
                                </span>
                              )}
                            </td>
                            <td>{it.is_admin ? '行政' : it.student_names.join('、')}</td>
                            <td>{it.hours}</td>
                            <td>{it.pay}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
          {payslips.length === 0 && (
            <tr><td colSpan={4} style={{ color: 'var(--text-muted)', padding: 12 }}>尚無已開立的薪資條</td></tr>
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
