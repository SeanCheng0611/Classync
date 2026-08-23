import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { subscribeSchool } from '../socket';
import { WEEKDAY_LABELS, timeToSlot, slotToTime, slotRangeLabel, todayStr, hoursToDurationSlots, durationSlotsToHours, durationHoursBetween } from '../lib/time';
import TimeInput from '../components/TimeInput';
import WeekdayCheckboxes from '../components/WeekdayCheckboxes';

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function monthRangeStr(month) {
  const [y, m] = month.split('-').map(Number);
  const start = `${month}-01`;
  const end = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return [start, end];
}

function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const total = y * 12 + (m - 1) + delta;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

// 樣板 t 在選定月份內是否為有效區間（active_from ~ active_until 與該月有重疊）
function templateActiveInMonth(t, month) {
  const [monthStart, monthEndExclusive] = monthRangeStr(month);
  return t.active_from < monthEndExclusive && (!t.active_until || t.active_until >= monthStart);
}

// 該月最後一天的日期字串
function monthLastDay(month) {
  const [, nextMonthStart] = monthRangeStr(month);
  const d = new Date(`${nextMonthStart}T00:00:00`);
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

const RATE_LABEL = { rate_grade_1_6: '1-6年級', rate_grade_7_9: '7-9年級', rate_grade_10_12: '10-12年級', rate_admin: '行政' };

export default function TeacherDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { currentSchoolId, currentMembership } = useAuth();
  // isAdmin：對教師檔案/課表子系統有完整操作權限（含 admin 與 front_desk 櫃台）
  // isFinanceAdmin：薪資明細屬財務資料，僅管理者本人可查看/操作
  const isAdmin = ['admin', 'front_desk'].includes(currentMembership?.role);
  const isFinanceAdmin = currentMembership?.role === 'admin';

  const [teacher, setTeacher] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [history, setHistory] = useState([]);
  const [error, setError] = useState('');

  const [showFixedForm, setShowFixedForm] = useState(false);
  const [fixedForm, setFixedForm] = useState({
    subject: '行政',
    weekdays: [1],
    start_time: '',
    end_time: '',
    start_month: currentMonth(),
    end_month: '',
  });
  const [showAdhocForm, setShowAdhocForm] = useState(false);
  const [adhocForm, setAdhocForm] = useState({ subject: '行政', date: todayStr(), start_time: '', end_time: '' });
  const [editingSession, setEditingSession] = useState(null);
  const [editSessionForm, setEditSessionForm] = useState({ date: '', start_time: '', end_time: '' });

  const [templateMonth, setTemplateMonth] = useState(currentMonth());
  const [historyMonth, setHistoryMonth] = useState(currentMonth());

  const load = useCallback(async () => {
    if (!currentSchoolId || !id) return;
    const [start, end] = monthRangeStr(historyMonth);
    const canSeeFinance = currentMembership?.role === 'admin' || currentMembership?.teacher_id === id;
    const [t, tpl, hist] = await Promise.all([
      api.get(`/api/schools/${currentSchoolId}/teachers/${id}`),
      api.get(`/api/schools/${currentSchoolId}/schedule-templates`),
      canSeeFinance
        ? api.get(`/api/schools/${currentSchoolId}/teachers/${id}/sessions?start=${start}&end=${end}`)
        : Promise.resolve([]),
    ]);
    setTeacher(t);
    setTemplates(tpl.filter((tp) => tp.teacher_id === id));
    setHistory(hist);
  }, [currentSchoolId, id, historyMonth, currentMembership]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!currentSchoolId) return;
    return subscribeSchool(currentSchoolId, (resource) => {
      if (['teachers', 'schedule', 'sessions', 'finance'].includes(resource)) load();
    });
  }, [currentSchoolId, load]);

  if (!teacher) return <p>載入中...</p>;

  const canSeeFinance = isFinanceAdmin || currentMembership?.teacher_id === id;

  // 學生端刪除固定課堂是用 active_until 停止未來排課（保留歷史），教師這邊也依選定月份顯示「該月仍生效」的
  const fixedAdminTemplates = templates.filter((t) => t.students.length === 0 && templateActiveInMonth(t, templateMonth));
  const teachingTemplates = templates.filter((t) => t.students.length > 0 && templateActiveInMonth(t, templateMonth));

  const addFixedAdmin = async (e) => {
    e.preventDefault();
    setError('');
    const hours = durationHoursBetween(fixedForm.start_time, fixedForm.end_time);
    if (!hours) {
      setError('結束時間需晚於開始時間');
      return;
    }
    if (fixedForm.weekdays.length === 0) {
      setError('請至少選擇一個星期');
      return;
    }
    if (!fixedForm.start_month) {
      setError('請選擇起始月份');
      return;
    }
    if (fixedForm.end_month && fixedForm.end_month < fixedForm.start_month) {
      setError('結束月份不能早於起始月份');
      return;
    }
    try {
      const [startMonthFirstDay] = monthRangeStr(fixedForm.start_month);
      // 起始月份若已經過去，實際生效日改為今天，避免補算過去未曾發生的行政時段
      const activeFrom = startMonthFirstDay < todayStr() ? todayStr() : startMonthFirstDay;
      // 結束月份留空時，預設自動新增四個月（含起始月份）
      const activeUntil = monthLastDay(fixedForm.end_month || shiftMonth(fixedForm.start_month, 3));
      await Promise.all(
        fixedForm.weekdays.map((weekday) =>
          api.post(`/api/schools/${currentSchoolId}/schedule-templates`, {
            teacher_id: id,
            subject: fixedForm.subject.trim() || '行政',
            weekday,
            start_slot: timeToSlot(fixedForm.start_time),
            duration_slots: hoursToDurationSlots(hours),
            students: [],
            active_from: activeFrom,
            active_until: activeUntil,
          })
        )
      );
      setShowFixedForm(false);
      setFixedForm({ subject: '行政', weekdays: [1], start_time: '', end_time: '', start_month: currentMonth(), end_month: '' });
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const removeTemplate = async (tpl) => {
    if (!confirm(`確定要刪除「${tpl.subject}」這項固定行政時段嗎？（今天之後將不再排課，已發生的紀錄會保留）`)) return;
    setError('');
    try {
      // 用 active_until 停止未來排課，保留已發生的課堂與薪資紀錄（與學生端固定課堂刪除邏輯一致）
      await api.put(`/api/schools/${currentSchoolId}/schedule-templates/${tpl.id}`, { active_until: addDays(todayStr(), -1) });
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const addAdhocAdmin = async (e) => {
    e.preventDefault();
    setError('');
    const hours = durationHoursBetween(adhocForm.start_time, adhocForm.end_time);
    if (!hours) {
      setError('結束時間需晚於開始時間');
      return;
    }
    try {
      await api.post(`/api/schools/${currentSchoolId}/sessions`, {
        type: 'extra',
        teacher_id: id,
        subject: adhocForm.subject.trim() || '行政',
        session_date: adhocForm.date,
        start_slot: timeToSlot(adhocForm.start_time),
        duration_slots: hoursToDurationSlots(hours),
        students: [],
      });
      setShowAdhocForm(false);
      setAdhocForm({ subject: '行政', date: todayStr(), start_time: '', end_time: '' });
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const startEditSession = (h) => {
    setEditingSession(h.session_id);
    setEditSessionForm({
      date: h.session_date,
      start_time: slotToTime(h.start_slot ?? 0),
      end_time: slotToTime((h.start_slot ?? 0) + h.hours * 2),
    });
  };

  const saveEditSession = async (h) => {
    setError('');
    const hours = durationHoursBetween(editSessionForm.start_time, editSessionForm.end_time);
    if (!hours) {
      setError('結束時間需晚於開始時間');
      return;
    }
    try {
      await api.put(`/api/schools/${currentSchoolId}/sessions/${h.session_id}`, {
        session_date: editSessionForm.date,
        start_slot: timeToSlot(editSessionForm.start_time),
        duration_slots: hoursToDurationSlots(hours),
      });
      setEditingSession(null);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const removeSession = async (h) => {
    const msg = h.type === 'regular' ? `確定要刪除 ${h.session_date} 這天的固定行政時段嗎？（僅刪除當天，不影響其他星期）` : '確定要刪除這筆行政時數紀錄嗎？';
    if (!confirm(msg)) return;
    await api.del(`/api/schools/${currentSchoolId}/sessions/${h.session_id}`);
    load();
  };

  return (
    <div>
      <button onClick={() => navigate('/teachers')}>← 返回教師列表</button>

      <h2 style={{ marginTop: 12 }}>{teacher.name}</h2>
      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}

      <table style={{ borderCollapse: 'collapse' }}>
        <tbody>
          <tr><td style={{ color: 'var(--text-muted)', paddingRight: 16 }}>編號</td><td>{teacher.teacher_no}</td></tr>
          <tr><td style={{ color: 'var(--text-muted)', paddingRight: 16 }}>科目</td><td>{teacher.subjects.join(', ')}</td></tr>
          {Object.entries(RATE_LABEL).map(([key, label]) => (
            <tr key={key}>
              <td style={{ color: 'var(--text-muted)', paddingRight: 16 }}>時薪 - {label}</td>
              <td>{teacher[key]}</td>
            </tr>
          ))}
          <tr><td style={{ color: 'var(--text-muted)', paddingRight: 16 }}>狀態</td><td>{teacher.status === 'active' ? '在職' : '停用'}</td></tr>
          <tr><td style={{ color: 'var(--text-muted)', paddingRight: 16 }}>備註</td><td>{teacher.note}</td></tr>
        </tbody>
      </table>
      <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>基本資料與時薪請至「教師檔案」列表頁編輯。</p>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 24 }}>
        <h3 style={{ margin: 0 }}>任教固定課堂 / 固定行政時段</h3>
        <input type="month" value={templateMonth} onChange={(e) => setTemplateMonth(e.target.value)} />
      </div>
      <h4 style={{ marginTop: 16, marginBottom: 4 }}>任教固定課堂</h4>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid var(--border-strong)' }}>
            <th>科目</th><th>星期</th><th>時段</th><th>總時長</th>
          </tr>
        </thead>
        <tbody>
          {teachingTemplates.map((t) => (
            <tr key={t.id} style={{ borderBottom: '1px solid var(--border)' }}>
              <td>{t.subject}</td>
              <td>星期{WEEKDAY_LABELS[t.weekday]}</td>
              <td>{slotRangeLabel(t.start_slot, t.duration_slots)}</td>
              <td>{durationSlotsToHours(t.duration_slots)} 小時</td>
            </tr>
          ))}
          {teachingTemplates.length === 0 && (
            <tr><td colSpan={4} style={{ color: 'var(--text-muted)', padding: 12 }}>這個月無任教固定課堂</td></tr>
          )}
        </tbody>
      </table>

      {isAdmin && (
        <>
          <h4 style={{ marginTop: 16, marginBottom: 4 }}>固定行政時段</h4>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '2px solid var(--border-strong)' }}>
                <th>科目</th><th>星期</th><th>時段</th><th>總時長</th><th></th>
              </tr>
            </thead>
            <tbody>
              {fixedAdminTemplates.map((t) => (
                <tr key={t.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td>{t.subject}</td>
                  <td>星期{WEEKDAY_LABELS[t.weekday]}</td>
                  <td>{slotRangeLabel(t.start_slot, t.duration_slots)}</td>
                  <td>{durationSlotsToHours(t.duration_slots)} 小時</td>
                  <td><button onClick={() => removeTemplate(t)}>刪除</button></td>
                </tr>
              ))}
              {fixedAdminTemplates.length === 0 && (
                <tr><td colSpan={5} style={{ color: 'var(--text-muted)', padding: 12 }}>這個月無固定行政時段</td></tr>
              )}
            </tbody>
          </table>
          <button
            style={{ marginTop: 8 }}
            onClick={() => {
              if (!showFixedForm) setFixedForm((f) => ({ ...f, start_month: templateMonth }));
              setShowFixedForm((v) => !v);
            }}
          >
            {showFixedForm ? '取消' : '+ 新增固定行政時段'}
          </button>
          {showFixedForm && (
            <form onSubmit={addFixedAdmin} style={{ marginTop: 8, display: 'grid', gap: 8, maxWidth: 360 }}>
              <label>
                類型
                <input value={fixedForm.subject} onChange={(e) => setFixedForm({ ...fixedForm, subject: e.target.value })} />
              </label>
              <label>
                星期（可複選）
                <WeekdayCheckboxes value={fixedForm.weekdays} onChange={(v) => setFixedForm({ ...fixedForm, weekdays: v })} />
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                <label>
                  開始時間
                  <TimeInput value={fixedForm.start_time} onChange={(v) => setFixedForm({ ...fixedForm, start_time: v })} />
                </label>
                <label>
                  結束時間
                  <TimeInput value={fixedForm.end_time} onChange={(v) => setFixedForm({ ...fixedForm, end_time: v })} />
                </label>
              </div>
              <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 13 }}>
                總時長：{durationHoursBetween(fixedForm.start_time, fixedForm.end_time) || 0} 小時
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <label>
                  起始月份
                  <input
                    type="month"
                    required
                    value={fixedForm.start_month}
                    onChange={(e) => setFixedForm({ ...fixedForm, start_month: e.target.value })}
                  />
                </label>
                <label>
                  結束月份（留空預設新增四個月）
                  <input
                    type="month"
                    value={fixedForm.end_month}
                    onChange={(e) => setFixedForm({ ...fixedForm, end_month: e.target.value })}
                  />
                </label>
              </div>
              <div><button type="submit">新增</button></div>
            </form>
          )}

          <h3 style={{ marginTop: 24 }}>手動新增行政時數</h3>
          <button onClick={() => setShowAdhocForm((v) => !v)}>{showAdhocForm ? '取消' : '+ 新增單次行政時數'}</button>
          {showAdhocForm && (
            <form onSubmit={addAdhocAdmin} style={{ marginTop: 8, display: 'grid', gap: 8, maxWidth: 360 }}>
              <label>
                類型
                <input value={adhocForm.subject} onChange={(e) => setAdhocForm({ ...adhocForm, subject: e.target.value })} />
              </label>
              <label>
                日期
                <input type="date" value={adhocForm.date} onChange={(e) => setAdhocForm({ ...adhocForm, date: e.target.value })} />
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                <label>
                  開始時間
                  <TimeInput value={adhocForm.start_time} onChange={(v) => setAdhocForm({ ...adhocForm, start_time: v })} />
                </label>
                <label>
                  結束時間
                  <TimeInput value={adhocForm.end_time} onChange={(v) => setAdhocForm({ ...adhocForm, end_time: v })} />
                </label>
              </div>
              <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 13 }}>
                總時長：{durationHoursBetween(adhocForm.start_time, adhocForm.end_time) || 0} 小時
              </p>
              <div><button type="submit">新增</button></div>
            </form>
          )}
        </>
      )}

      {canSeeFinance && (
      <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 24 }}>
        <h3 style={{ margin: 0 }}>薪資明細</h3>
        <input type="month" value={historyMonth} onChange={(e) => setHistoryMonth(e.target.value)} />
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid var(--border-strong)' }}>
            <th>日期</th><th>類型</th><th>備註</th><th>學生</th><th>狀態</th><th>時數</th><th>適用時薪</th><th>金額</th>{isAdmin && <th></th>}
          </tr>
        </thead>
        <tbody>
          {history.map((h) =>
            editingSession === h.session_id ? (
              <tr key={h.session_id} style={{ borderBottom: '1px solid var(--border)' }}>
                <td><input type="date" value={editSessionForm.date} onChange={(e) => setEditSessionForm({ ...editSessionForm, date: e.target.value })} /></td>
                <td colSpan={2} style={{ display: 'flex', gap: 8 }}>
                  <TimeInput value={editSessionForm.start_time} onChange={(v) => setEditSessionForm({ ...editSessionForm, start_time: v })} />
                  <TimeInput value={editSessionForm.end_time} onChange={(v) => setEditSessionForm({ ...editSessionForm, end_time: v })} />
                </td>
                <td></td>
                <td></td>
                <td>{durationHoursBetween(editSessionForm.start_time, editSessionForm.end_time) || 0}</td>
                <td>{h.rate}</td>
                <td></td>
                <td>
                  <button onClick={() => saveEditSession(h)}>儲存</button>{' '}
                  <button onClick={() => setEditingSession(null)}>取消</button>
                </td>
              </tr>
            ) : (
              <tr
                key={h.session_id}
                style={{
                  borderBottom: '1px solid var(--border)',
                  ...(h.fully_on_leave ? { color: 'var(--text-muted)', background: 'var(--surface-muted)' } : {}),
                }}
              >
                <td>{h.session_date}</td>
                <td>{h.is_admin ? '行政' : h.type === 'regular' ? '固定' : h.type === 'makeup' ? '調課' : '加課'}</td>
                <td>
                  {h.type === 'makeup' && h.origin_session_date && (
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      調課自 {h.origin_session_date} {slotToTime(h.origin_start_slot)}
                    </span>
                  )}
                </td>
                <td>{h.student_names.join(', ')}</td>
                <td>{h.fully_on_leave ? (h.leave_is_makeup ? '已調課' : '已請假') : '-'}</td>
                <td>{h.hours}</td>
                <td>{h.rate}</td>
                <td>{h.pay}</td>
                {isAdmin && (
                  <td>
                    {h.is_admin && h.type === 'extra' && (
                      <>
                        <button onClick={() => startEditSession(h)}>編輯</button>{' '}
                        <button onClick={() => removeSession(h)}>刪除</button>
                      </>
                    )}
                    {h.is_admin && h.type === 'regular' && (
                      <button onClick={() => removeSession(h)}>刪除當天</button>
                    )}
                  </td>
                )}
              </tr>
            )
          )}
          {history.length === 0 && (
            <tr><td colSpan={isAdmin ? 9 : 8} style={{ color: 'var(--text-muted)', padding: 12 }}>這個月無課堂紀錄</td></tr>
          )}
        </tbody>
      </table>
      </>
      )}
    </div>
  );
}
