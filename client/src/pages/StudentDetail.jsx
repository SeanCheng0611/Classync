import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { subscribeSchool } from '../socket';
import {
  WEEKDAY_LABELS,
  slotToTime,
  timeToSlot,
  slotRangeLabel,
  todayStr,
  hoursToDurationSlots,
  durationSlotsToHours,
  durationHoursBetween,
} from '../lib/time';
import TimeInput from '../components/TimeInput';
import WeekdayCheckboxes from '../components/WeekdayCheckboxes';
import SubjectSelect from '../components/SubjectSelect';
import SearchSelect from '../components/SearchSelect';
import { defaultPriceForGrade } from '../lib/pricing';

const STATUS_LABEL = { present: '出席', absent: '缺席', leave: '請假' };

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

// 該月最後一天的日期字串
function monthLastDay(month) {
  const [, nextMonthStart] = monthRangeStr(month);
  const d = new Date(`${nextMonthStart}T00:00:00`);
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

// 樣板 t 在選定月份內是否為有效區間（active_from ~ active_until 與該月有重疊）
function templateActiveInMonth(t, month) {
  const [monthStart, monthEndExclusive] = monthRangeStr(month);
  return t.active_from < monthEndExclusive && (!t.active_until || t.active_until >= monthStart);
}

function dayBefore(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

export default function StudentDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { currentSchoolId, currentMembership } = useAuth();
  const isAdmin = ['admin', 'front_desk'].includes(currentMembership?.role);

  const [student, setStudent] = useState(null);
  const [school, setSchool] = useState(null);
  const [teachers, setTeachers] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [history, setHistory] = useState([]);
  const [error, setError] = useState('');

  const [showFixedForm, setShowFixedForm] = useState(false);
  const [fixedForm, setFixedForm] = useState({
    teacher_id: '',
    subject: '',
    weekdays: [1],
    start_time: '',
    end_time: '',
    unit_price: 0,
    start_month: currentMonth(),
    end_month: '',
  });
  const [changeForm, setChangeForm] = useState({
    new_date: todayStr(),
    new_start_time: '',
    new_end_time: '',
    teacher_id: '',
    subject: '',
    unit_price: 0,
  });

  const [rescheduleRow, setRescheduleRow] = useState(null); // session_id 正在調課中
  const [rescheduleForm, setRescheduleForm] = useState({ new_date: todayStr(), new_start_time: '', new_end_time: '' });

  const [historyMonth, setHistoryMonth] = useState(currentMonth());
  const [fixedMonth, setFixedMonth] = useState(currentMonth());
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 2500);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(''), 4000);
    return () => clearTimeout(timer);
  }, [error]);

  const load = useCallback(async () => {
    if (!currentSchoolId || !id) return;
    const [start, end] = monthRangeStr(historyMonth);
    const [s, sch, te, tpl, hist] = await Promise.all([
      api.get(`/api/schools/${currentSchoolId}/students/${id}`),
      api.get(`/api/schools/${currentSchoolId}`),
      api.get(`/api/schools/${currentSchoolId}/teachers`),
      api.get(`/api/schools/${currentSchoolId}/schedule-templates`),
      api.get(`/api/schools/${currentSchoolId}/students/${id}/sessions?start=${start}&end=${end}`),
    ]);
    setStudent(s);
    setSchool(sch);
    setTeachers(te);
    setTemplates(tpl.filter((t) => t.student_ids.includes(id)));
    setHistory(hist);
  }, [currentSchoolId, id, historyMonth]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!currentSchoolId) return;
    return subscribeSchool(currentSchoolId, (resource) => {
      if (['students', 'schedule', 'sessions', 'attendance'].includes(resource)) load();
    });
  }, [currentSchoolId, load]);

  // 依學生年級帶入補習班設定的單堂預設金額，尚未手動調整過（仍是 0）時才帶入，避免覆蓋使用者已輸入的值
  useEffect(() => {
    if (!school || !student) return;
    const price = defaultPriceForGrade(school, student.grade);
    setFixedForm((f) => (f.unit_price === 0 ? { ...f, unit_price: price } : f));
    setChangeForm((f) => (f.unit_price === 0 ? { ...f, unit_price: price } : f));
  }, [school, student]);

  if (!student) return <p>載入中...</p>;

  const teacherName = (tid) => teachers.find((t) => t.id === tid)?.name || '未知';

  const addFixedClass = async (e) => {
    e.preventDefault();
    setError('');
    if (!fixedForm.teacher_id) {
      setError('請選擇教師');
      return;
    }
    if (!fixedForm.subject.trim()) {
      setError('請選擇科目');
      return;
    }
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
      // 起始月份若已經過去，實際生效日改為今天，避免補算過去未曾發生的課堂
      const activeFrom = startMonthFirstDay < todayStr() ? todayStr() : startMonthFirstDay;
      // 結束月份留空時，預設自動新增四個月（含起始月份）
      const activeUntil = monthLastDay(fixedForm.end_month || shiftMonth(fixedForm.start_month, 3));
      await Promise.all(
        fixedForm.weekdays.map((weekday) =>
          api.post(`/api/schools/${currentSchoolId}/schedule-templates`, {
            teacher_id: fixedForm.teacher_id,
            subject: fixedForm.subject.trim(),
            weekday,
            start_slot: timeToSlot(fixedForm.start_time),
            duration_slots: hoursToDurationSlots(hours),
            students: [{ student_id: id, unit_price: Number(fixedForm.unit_price) || 0 }],
            active_from: activeFrom,
            active_until: activeUntil,
          })
        )
      );
      setShowFixedForm(false);
      setFixedForm({
        teacher_id: '',
        subject: '',
        weekdays: [1],
        start_time: '',
        end_time: '',
        unit_price: defaultPriceForGrade(school, student.grade),
        start_month: currentMonth(),
        end_month: '',
      });
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const removeFixedClass = async (tpl) => {
    const [monthStart] = monthRangeStr(fixedMonth);
    const stopBefore = dayBefore(monthStart);
    if (!confirm(`確定要刪除「${tpl.subject}」這堂固定課嗎？（自 ${fixedMonth} 起將不再排課，之前已發生的課堂紀錄會保留）`)) return;
    setError('');
    try {
      const remaining = tpl.students.filter((s) => s.student_id !== id);
      if (remaining.length === 0) {
        // 用 active_until 停在選定月份之前，讓選定月份確實清空，同時保留已發生的課堂與出缺勤紀錄
        await api.put(`/api/schools/${currentSchoolId}/schedule-templates/${tpl.id}`, { active_until: stopBefore });
      } else {
        await api.put(`/api/schools/${currentSchoolId}/schedule-templates/${tpl.id}`, { students: remaining });
      }
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const submitChange = async (e) => {
    e.preventDefault();
    setError('');
    if (!changeForm.teacher_id) {
      setError('請選擇教師');
      return;
    }
    if (!changeForm.subject.trim()) {
      setError('請選擇科目');
      return;
    }
    try {
      const hours = durationHoursBetween(changeForm.new_start_time, changeForm.new_end_time);
      if (!hours) {
        setError('結束時間需晚於開始時間');
        return;
      }
      await api.post(`/api/schools/${currentSchoolId}/sessions`, {
        type: 'extra',
        teacher_id: changeForm.teacher_id,
        subject: changeForm.subject.trim(),
        session_date: changeForm.new_date,
        start_slot: timeToSlot(changeForm.new_start_time),
        duration_slots: hoursToDurationSlots(hours),
        students: [{ student_id: id, unit_price: Number(changeForm.unit_price) || 0 }],
      });
      setNotice('加課成功');
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const leaveRow = async (h) => {
    setError('');
    try {
      await api.post(`/api/schools/${currentSchoolId}/attendance`, {
        session_id: h.session_id,
        person_type: 'student',
        person_id: id,
        status: 'leave',
        makeup_arranged: false,
      });
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const undoRow = async (h) => {
    setError('');
    try {
      await api.del(
        `/api/schools/${currentSchoolId}/attendance?session_id=${h.session_id}&person_type=student&person_id=${id}`
      );
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const deleteExtraSession = async (h) => {
    if (!confirm('確定要刪除這堂加課嗎？')) return;
    setError('');
    try {
      await api.del(`/api/schools/${currentSchoolId}/sessions/${h.session_id}`);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const startReschedule = (h) => {
    setError('');
    setRescheduleRow(h.session_id);
    setRescheduleForm({
      new_date: h.session_date,
      new_start_time: slotToTime(h.start_slot),
      new_end_time: slotToTime(h.start_slot + h.duration_slots),
    });
  };

  const confirmReschedule = async (h) => {
    setError('');
    const hours = durationHoursBetween(rescheduleForm.new_start_time, rescheduleForm.new_end_time);
    if (!hours) {
      setError('結束時間需晚於開始時間');
      return;
    }
    try {
      await api.post(`/api/schools/${currentSchoolId}/attendance`, {
        session_id: h.session_id,
        person_type: 'student',
        person_id: id,
        status: 'leave',
        makeup_arranged: true,
      });
      await api.post(`/api/schools/${currentSchoolId}/sessions`, {
        type: 'makeup',
        origin_session_id: h.session_id,
        teacher_id: h.teacher_id,
        subject: h.subject,
        session_date: rescheduleForm.new_date,
        start_slot: timeToSlot(rescheduleForm.new_start_time),
        duration_slots: hoursToDurationSlots(hours),
        students: [{ student_id: id, unit_price: h.unit_price || 0 }],
      });
      setRescheduleRow(null);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div>
      <button onClick={() => navigate('/students')}>← 返回學生列表</button>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
        <h2>{student.name}</h2>
      </div>

      <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>基本資料請至「學生檔案」列表頁編輯。</p>
      <table style={{ borderCollapse: 'collapse' }}>
          <tbody>
            <tr><td style={{ color: 'var(--text-muted)', paddingRight: 16 }}>編號</td><td>{student.student_no}</td></tr>
            <tr><td style={{ color: 'var(--text-muted)', paddingRight: 16 }}>年級</td><td>{student.grade}</td></tr>
            <tr><td style={{ color: 'var(--text-muted)', paddingRight: 16 }}>就讀學校</td><td>{student.school_name}</td></tr>
            <tr><td style={{ color: 'var(--text-muted)', paddingRight: 16 }}>狀態</td><td>{student.status === 'active' ? '在學' : '停用'}</td></tr>
            <tr><td style={{ color: 'var(--text-muted)', paddingRight: 16 }}>備註</td><td>{student.note}</td></tr>
          </tbody>
        </table>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 24 }}>
        <h3 style={{ margin: 0 }}>固定課堂</h3>
        <input type="month" value={fixedMonth} onChange={(e) => setFixedMonth(e.target.value)} />
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid var(--border-strong)' }}>
            <th>科目</th><th>教師</th><th>星期</th><th>時段</th><th>總時長</th><th>單堂價錢</th>{isAdmin && <th></th>}
          </tr>
        </thead>
        <tbody>
          {templates.filter((t) => templateActiveInMonth(t, fixedMonth)).map((t) => (
            <tr key={t.id} style={{ borderBottom: '1px solid var(--border)' }}>
              <td>{t.subject}</td>
              <td>{teacherName(t.teacher_id)}</td>
              <td>星期{WEEKDAY_LABELS[t.weekday]}</td>
              <td>{slotRangeLabel(t.start_slot, t.duration_slots)}</td>
              <td>{durationSlotsToHours(t.duration_slots)} 小時</td>
              <td>{t.students.find((s) => s.student_id === id)?.unit_price || 0}</td>
              {isAdmin && <td><button onClick={() => removeFixedClass(t)}>刪除</button></td>}
            </tr>
          ))}
          {templates.filter((t) => templateActiveInMonth(t, fixedMonth)).length === 0 && (
            <tr><td colSpan={7} style={{ color: 'var(--text-muted)', padding: 12 }}>這個月無固定課堂</td></tr>
          )}
        </tbody>
      </table>
      {isAdmin && (
        <>
          <button
            style={{ marginTop: 8 }}
            onClick={() => {
              if (!showFixedForm) setFixedForm((f) => ({ ...f, start_month: fixedMonth }));
              setShowFixedForm((v) => !v);
            }}
          >
            {showFixedForm ? '取消' : '+ 新增固定課堂'}
          </button>
          {showFixedForm && (
            <form onSubmit={addFixedClass} style={{ marginTop: 8, display: 'grid', gap: 8, maxWidth: 360 }}>
              <label>
                科目
                <SubjectSelect value={fixedForm.subject} onChange={(v) => setFixedForm({ ...fixedForm, subject: v })} />
              </label>
              <label>
                教師
                <SearchSelect options={teachers} value={fixedForm.teacher_id} onChange={(v) => setFixedForm({ ...fixedForm, teacher_id: v })} />
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
              <label>
                單堂價錢
                <input type="number" value={fixedForm.unit_price} onChange={(e) => setFixedForm({ ...fixedForm, unit_price: e.target.value })} />
              </label>
              <div><button type="submit">新增</button></div>
            </form>
          )}
        </>
      )}

      {isAdmin && (
        <>
          <h3 style={{ marginTop: 24 }}>加課</h3>
          <form onSubmit={submitChange} style={{ display: 'grid', gap: 8, maxWidth: 360 }}>
            <label>
              科目
              <SubjectSelect value={changeForm.subject} onChange={(v) => setChangeForm({ ...changeForm, subject: v })} />
            </label>
            <label>
              教師
              <SearchSelect options={teachers} value={changeForm.teacher_id} onChange={(v) => setChangeForm({ ...changeForm, teacher_id: v })} />
            </label>
            <label>
              日期
              <input type="date" value={changeForm.new_date} onChange={(e) => setChangeForm({ ...changeForm, new_date: e.target.value })} />
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <label>
                開始時間
                <TimeInput value={changeForm.new_start_time} onChange={(v) => setChangeForm({ ...changeForm, new_start_time: v })} />
              </label>
              <label>
                結束時間
                <TimeInput value={changeForm.new_end_time} onChange={(v) => setChangeForm({ ...changeForm, new_end_time: v })} />
              </label>
            </div>
            <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 13 }}>
              總時長：{durationHoursBetween(changeForm.new_start_time, changeForm.new_end_time) || 0} 小時
            </p>
            <label>
              單堂價錢
              <input type="number" value={changeForm.unit_price} onChange={(e) => setChangeForm({ ...changeForm, unit_price: e.target.value })} />
            </label>
            <div><button type="submit">送出</button></div>
          </form>
        </>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 24 }}>
        <h3 style={{ margin: 0 }}>課堂與出缺勤紀錄</h3>
        <input type="month" value={historyMonth} onChange={(e) => setHistoryMonth(e.target.value)} />
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid var(--border-strong)' }}>
            <th>日期</th><th>時段</th><th>科目</th><th>教師</th><th>類型</th><th>備註</th><th>出缺勤</th>{isAdmin && <th>調整</th>}
          </tr>
        </thead>
        <tbody>
          {history.map((h) => (
            <tr
              key={h.session_id}
              style={{
                borderBottom: '1px solid var(--border)',
                ...(h.attendance_status === 'leave' ? { color: 'var(--text-muted)', background: 'var(--surface-muted)' } : {}),
              }}
            >
              <td>{h.session_date}</td>
              <td>{slotRangeLabel(h.start_slot, h.duration_slots)}</td>
              <td>{h.subject}</td>
              <td>{teacherName(h.teacher_id)}</td>
              <td>{h.type === 'regular' ? '固定' : h.type === 'makeup' ? '調課' : '加課'}</td>
              <td>
                {h.type === 'makeup' && h.origin_session_date && (
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    調課自 {h.origin_session_date} {slotToTime(h.origin_start_slot)}
                  </span>
                )}
              </td>
              <td>
                {h.attendance_status === 'leave'
                  ? (h.makeup_arranged ? '已調課' : '已請假')
                  : h.attendance_status
                    ? STATUS_LABEL[h.attendance_status]
                    : '尚未點名'}
              </td>
              {isAdmin && (
                <td>
                  {rescheduleRow === h.session_id ? (
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      <input
                        type="date"
                        style={{ width: 130 }}
                        value={rescheduleForm.new_date}
                        onChange={(e) => setRescheduleForm({ ...rescheduleForm, new_date: e.target.value })}
                      />
                      <TimeInput value={rescheduleForm.new_start_time} onChange={(v) => setRescheduleForm({ ...rescheduleForm, new_start_time: v })} />
                      <span>-</span>
                      <TimeInput value={rescheduleForm.new_end_time} onChange={(v) => setRescheduleForm({ ...rescheduleForm, new_end_time: v })} />
                      <button onClick={() => confirmReschedule(h)}>確認</button>
                      <button onClick={() => setRescheduleRow(null)}>取消</button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                      {h.attendance_status === 'leave' && h.makeup_arranged ? (
                        <button onClick={() => undoRow(h)}>取消調課</button>
                      ) : h.attendance_status === 'leave' ? (
                        <button onClick={() => undoRow(h)}>取消請假</button>
                      ) : (
                        <>
                          <button onClick={() => leaveRow(h)}>請假</button>
                          <button onClick={() => startReschedule(h)}>調課</button>
                        </>
                      )}
                      {h.type === 'extra' && h.attendance_status !== 'leave' && (
                        <button onClick={() => deleteExtraSession(h)}>刪除</button>
                      )}
                    </div>
                  )}
                </td>
              )}
            </tr>
          ))}
          {history.length === 0 && (
            <tr><td colSpan={isAdmin ? 8 : 7} style={{ color: 'var(--text-muted)', padding: 12 }}>這個月無課堂紀錄</td></tr>
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

      {error && (
        <div
          style={{
            position: 'fixed',
            bottom: 24,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'var(--danger)',
            color: '#fff',
            padding: '10px 20px',
            borderRadius: 6,
            boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
            fontSize: 14,
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
