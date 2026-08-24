import { useEffect, useState, useCallback } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
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
  durationHoursBetween,
  addHoursToTime,
} from '../lib/time';
import TimeInput from '../components/TimeInput';
import RelatedNotes from '../components/RelatedNotes';
import { setLastVisitedId } from '../lib/scrollAnchor';
import WeekdayCheckboxes from '../components/WeekdayCheckboxes';
import SubjectSelect from '../components/SubjectSelect';
import SubjectMultiSelect from '../components/SubjectMultiSelect';
import PillListSummary from '../components/PillListSummary';
import SearchSelect from '../components/SearchSelect';
import { defaultPriceForGrade } from '../lib/pricing';

const STATUS_LABEL = { present: '出席', absent: '缺席', leave: '請假' };
const GRADES = Array.from({ length: 12 }, (_, i) => i + 1);

// 「排課」與「課堂與出缺勤紀錄」兩張表共用同一組欄寬，讓兩張表的欄位對得齊
const COL = { first: 90, slot: 130, subject: 80, teacher: 90, type: 60, note: 140, status: 90, adjust: 260 };

function currentMonth() {
  return todayStr().slice(0, 7);
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

// 該月最後一天的日期字串；用 Date(year, month, 0) 純本地日期運算取得天數，避免 toISOString() 轉 UTC 導致日期偏移一天
function monthLastDay(month) {
  const [y, m] = month.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  return `${month}-${String(lastDay).padStart(2, '0')}`;
}

// 樣板 t 在選定月份內是否為有效區間（active_from ~ active_until 與該月有重疊）
function templateActiveInMonth(t, month) {
  const [monthStart, monthEndExclusive] = monthRangeStr(month);
  return t.active_from < monthEndExclusive && (!t.active_until || t.active_until >= monthStart);
}

// 純本地日期運算組字串，避免 toISOString() 轉 UTC 導致日期偏移一天
function dayBefore(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d - 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

export default function StudentDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { currentSchoolId, currentMembership, schoolSettings } = useAuth();
  const isAdmin = ['admin', 'front_desk'].includes(currentMembership?.role);

  useEffect(() => {
    setLastVisitedId('/students', id);
  }, [id]);

  const [student, setStudent] = useState(null);
  const [school, setSchool] = useState(null);
  const [teachers, setTeachers] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [history, setHistory] = useState([]);
  const [error, setError] = useState('');

  const [editingBasic, setEditingBasic] = useState(false);
  const [basicForm, setBasicForm] = useState({ name: '', grade: 1, school_name: '', subjects: [], status: 'active', note: '' });

  const [showScheduleForm, setShowScheduleForm] = useState(false);
  const [scheduleMode, setScheduleMode] = useState('single'); // 'single' | 'multiple'
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

  const startEditBasic = () => {
    setError('');
    setBasicForm({
      name: student.name,
      grade: student.grade,
      school_name: student.school_name || '',
      subjects: student.subjects || [],
      status: student.status,
      note: student.note || '',
    });
    setEditingBasic(true);
  };

  const saveBasic = async (e) => {
    e.preventDefault();
    setError('');
    const payload = {
      name: basicForm.name.trim(),
      grade: Number(basicForm.grade),
      school_name: basicForm.school_name.trim() || null,
      subjects: basicForm.subjects,
      status: basicForm.status,
      note: basicForm.note.trim() || null,
    };
    try {
      const result = await api.put(`/api/schools/${currentSchoolId}/students/${id}`, payload);
      setEditingBasic(false);
      load();
      if (result.duplicate_name) {
        alert(`已有同名學生「${result.name}」，請確認是否為重複。`);
      }
    } catch (err) {
      setError(err.message);
    }
  };

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
      // 結束月份留空時，預設展開「設定」子系統設定的月數（含起始月份）
      const spanMonths = schoolSettings?.default_schedule_span_months || 4;
      const activeUntil = monthLastDay(fixedForm.end_month || shiftMonth(fixedForm.start_month, spanMonths - 1));
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
      setShowScheduleForm(false);
      setNotice('固定排課新增成功');
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
      setShowScheduleForm(false);
      setChangeForm({
        new_date: todayStr(),
        new_start_time: '',
        new_end_time: '',
        teacher_id: '',
        subject: '',
        unit_price: defaultPriceForGrade(school, student.grade),
      });
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const presentRow = async (h) => {
    setError('');
    try {
      await api.post(`/api/schools/${currentSchoolId}/attendance`, {
        session_id: h.session_id,
        person_type: 'student',
        person_id: id,
        status: 'present',
        makeup_arranged: false,
      });
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

  // regular（固定課展開的單日）由後端軟刪除（cancelled=1），只影響當天、不影響樣板其他日期；extra（加課）則直接刪除
  const deleteSession = async (h) => {
    const msg =
      h.type === 'regular'
        ? `確定要刪除 ${h.session_date} 這天的固定課堂嗎？（僅刪除當天，不影響其他日期）`
        : '確定要刪除這堂加課嗎？';
    if (!confirm(msg)) return;
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
        <div style={{ display: 'flex', gap: 8 }}>
          {isAdmin && !editingBasic && <button type="button" onClick={startEditBasic}>編輯</button>}
          {currentMembership?.role === 'admin' && (
            <Link to={`/students/${id}/trash`}><button type="button">回收桶</button></Link>
          )}
        </div>
      </div>

      {editingBasic ? (
        <form onSubmit={saveBasic} style={{ marginTop: 8, maxWidth: 360, display: 'grid', gap: 8 }}>
          <label>
            姓名
            <input required value={basicForm.name} onChange={(e) => setBasicForm({ ...basicForm, name: e.target.value })} />
          </label>
          <label>
            年級
            <select value={basicForm.grade} onChange={(e) => setBasicForm({ ...basicForm, grade: e.target.value })}>
              {GRADES.map((g) => (
                <option key={g} value={g}>{g}</option>
              ))}
            </select>
          </label>
          <label>
            就讀學校
            <input value={basicForm.school_name} onChange={(e) => setBasicForm({ ...basicForm, school_name: e.target.value })} />
          </label>
          <label>
            科目
            <SubjectMultiSelect value={basicForm.subjects} onChange={(next) => setBasicForm({ ...basicForm, subjects: next })} />
          </label>
          <label>
            狀態
            <select value={basicForm.status} onChange={(e) => setBasicForm({ ...basicForm, status: e.target.value })}>
              <option value="active">在學</option>
              <option value="inactive">停用</option>
            </select>
          </label>
          <label>
            備註
            <textarea value={basicForm.note} onChange={(e) => setBasicForm({ ...basicForm, note: e.target.value })} />
          </label>
          <div>
            <button type="submit">儲存</button>{' '}
            <button type="button" onClick={() => setEditingBasic(false)}>取消</button>
          </div>
        </form>
      ) : (
        <table style={{ borderCollapse: 'collapse' }}>
          <tbody>
            <tr><td style={{ color: 'var(--text-muted)', paddingRight: 16 }}>年級</td><td>{student.grade}</td></tr>
            <tr><td style={{ color: 'var(--text-muted)', paddingRight: 16 }}>就讀學校</td><td>{student.school_name}</td></tr>
            <tr>
              <td style={{ color: 'var(--text-muted)', paddingRight: 16 }}>科目</td>
              <td>
                <PillListSummary
                  entries={(student.subjects || []).map((subj) => ({ key: subj, label: subj }))}
                  emptyText="無科目"
                />
              </td>
            </tr>
            <tr><td style={{ color: 'var(--text-muted)', paddingRight: 16 }}>狀態</td><td>{student.status === 'active' ? '在學' : '停用'}</td></tr>
            <tr><td style={{ color: 'var(--text-muted)', paddingRight: 16 }}>備註</td><td>{student.note}</td></tr>
            <tr><td style={{ color: 'var(--text-muted)', paddingRight: 16 }}>建檔日期</td><td>{student.created_at?.slice(0, 10)}</td></tr>
          </tbody>
        </table>
      )}

      <RelatedNotes studentId={id} />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 24 }}>
        <h3 style={{ margin: 0 }}>排課</h3>
        <input type="month" value={fixedMonth} onChange={(e) => setFixedMonth(e.target.value)} />
      </div>
      {isAdmin && (
        <>
          <button
            style={{ marginTop: 8 }}
            onClick={() => {
              if (!showScheduleForm) {
                const defaultStart = schoolSettings?.time_picker_range_start || '';
                const defaultEnd = schoolSettings?.time_picker_range_end || '';
                const spanMonths = schoolSettings?.default_schedule_span_months || 4;
                setFixedForm((f) => ({
                  ...f,
                  start_month: fixedMonth,
                  end_month: f.end_month || shiftMonth(fixedMonth, spanMonths - 1),
                  start_time: f.start_time || defaultStart,
                  end_time: f.end_time || defaultEnd,
                }));
                setChangeForm((f) => ({
                  ...f,
                  new_start_time: f.new_start_time || defaultStart,
                  new_end_time: f.new_end_time || defaultEnd,
                }));
              }
              setShowScheduleForm((v) => !v);
            }}
          >
            {showScheduleForm ? '取消' : '+ 新增排課'}
          </button>
          {showScheduleForm && (
            <div style={{ marginTop: 8, display: 'grid', gap: 8, maxWidth: 360 }}>
              <div style={{ display: 'flex', gap: 16 }}>
              <label style={{ display: 'inline-flex', flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <input
                  type="radio"
                  name="scheduleMode"
                  checked={scheduleMode === 'single'}
                  onChange={() => setScheduleMode('single')}
                />
                單堂
              </label>
              <label style={{ display: 'inline-flex', flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <input
                  type="radio"
                  name="scheduleMode"
                  checked={scheduleMode === 'multiple'}
                  onChange={() => setScheduleMode('multiple')}
                />
                多堂
              </label>
              </div>

              {scheduleMode === 'single' ? (
                <form onSubmit={submitChange} style={{ marginTop: 8, display: 'grid', gap: 8, maxWidth: 360 }}>
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
                      <TimeInput
                        value={changeForm.new_start_time}
                        onChange={(v) =>
                          setChangeForm({
                            ...changeForm,
                            new_start_time: v,
                            new_end_time: addHoursToTime(v, schoolSettings?.default_class_duration_hours || 1.5),
                          })
                        }
                      />
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
              ) : (
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
                      <TimeInput
                        value={fixedForm.start_time}
                        onChange={(v) =>
                          setFixedForm({
                            ...fixedForm,
                            start_time: v,
                            end_time: addHoursToTime(v, schoolSettings?.default_class_duration_hours || 1.5),
                          })
                        }
                      />
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
                        onChange={(e) =>
                          setFixedForm({
                            ...fixedForm,
                            start_month: e.target.value,
                            end_month: shiftMonth(e.target.value, (schoolSettings?.default_schedule_span_months || 4) - 1),
                          })
                        }
                      />
                    </label>
                    <label>
                      結束月份
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
            </div>
          )}
        </>
      )}

      <h4 style={{ marginTop: 16, marginBottom: 4 }}>固定課堂</h4>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12, tableLayout: 'fixed' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid var(--border-strong)' }}>
            <th style={{ width: COL.first }}>星期</th>
            <th style={{ width: COL.slot }}>時段</th>
            <th style={{ width: COL.subject }}>科目</th>
            <th style={{ width: COL.teacher }}>教師</th>
            <th style={{ width: COL.type }}>類型</th>
            <th style={{ width: COL.note }}>備註</th>
            <th style={{ width: COL.status }}></th>
            {isAdmin && <th style={{ width: COL.adjust }}>調整</th>}
          </tr>
        </thead>
        <tbody>
          {templates.filter((t) => templateActiveInMonth(t, fixedMonth)).map((t) => (
            <tr key={t.id} style={{ borderBottom: '1px solid var(--border)' }}>
              <td style={{ whiteSpace: 'nowrap' }}>星期{WEEKDAY_LABELS[t.weekday]}</td>
              <td style={{ whiteSpace: 'nowrap' }}>{slotRangeLabel(t.start_slot, t.duration_slots)}</td>
              <td>{t.subject}</td>
              <td>{teacherName(t.teacher_id)}</td>
              <td>固定</td>
              <td>{t.note}</td>
              <td></td>
              {isAdmin && <td><button onClick={() => removeFixedClass(t)}>刪除</button></td>}
            </tr>
          ))}
          {templates.filter((t) => templateActiveInMonth(t, fixedMonth)).length === 0 && (
            <tr><td colSpan={isAdmin ? 8 : 7} style={{ color: 'var(--text-muted)', padding: 12 }}>本月無固定課堂</td></tr>
          )}
        </tbody>
      </table>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 24 }}>
        <h3 style={{ margin: 0 }}>課堂與出缺勤紀錄</h3>
        <input type="month" value={historyMonth} onChange={(e) => setHistoryMonth(e.target.value)} />
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid var(--border-strong)' }}>
            <th style={{ width: COL.first }}>日期</th>
            <th style={{ width: COL.slot }}>時段</th>
            <th style={{ width: COL.subject }}>科目</th>
            <th style={{ width: COL.teacher }}>教師</th>
            <th style={{ width: COL.type }}>類型</th>
            <th style={{ width: COL.note }}>備註</th>
            <th style={{ width: COL.status }}>出缺勤</th>
            {isAdmin && <th style={{ width: COL.adjust }}>調整</th>}
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
                      <TimeInput
                        value={rescheduleForm.new_start_time}
                        onChange={(v) =>
                          setRescheduleForm({
                            ...rescheduleForm,
                            new_start_time: v,
                            new_end_time: addHoursToTime(v, schoolSettings?.default_class_duration_hours || 1.5),
                          })
                        }
                      />
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
                      ) : h.attendance_status === 'present' ? (
                        <button style={{ fontWeight: 'bold', background: 'var(--accent-soft)' }} onClick={() => undoRow(h)}>
                          出席
                        </button>
                      ) : (
                        <>
                          <button onClick={() => presentRow(h)}>出席</button>
                          <button onClick={() => startReschedule(h)}>調課</button>
                          <button onClick={() => leaveRow(h)}>請假</button>
                        </>
                      )}
                      {(h.type === 'extra' || h.type === 'regular') && h.attendance_status !== 'leave' && (
                        <button onClick={() => deleteSession(h)}>刪除</button>
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
