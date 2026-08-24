import { useEffect, useState, useCallback } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { subscribeSchool } from '../socket';
import { WEEKDAY_LABELS, timeToSlot, slotToTime, slotRangeLabel, todayStr, hoursToDurationSlots, durationSlotsToHours, durationHoursBetween, addHoursToTime } from '../lib/time';
import TimeInput from '../components/TimeInput';
import RelatedNotes from '../components/RelatedNotes';
import { setLastVisitedId } from '../lib/scrollAnchor';
import WeekdayCheckboxes from '../components/WeekdayCheckboxes';
import FlexibleScheduleEditor from '../components/FlexibleScheduleEditor';
import FlexibleScheduleSummary from '../components/FlexibleScheduleSummary';
import SubjectSelect from '../components/SubjectSelect';
import SubjectMultiSelect from '../components/SubjectMultiSelect';
import PillListSummary from '../components/PillListSummary';
import GroupStudentSelect from '../components/GroupStudentSelect';
import { emptyFlexibleScheduleForm, flexibleScheduleToForm, flexibleScheduleFormToPayload } from '../lib/flexibleSchedule';

// 純本地日期運算組字串，避免 toISOString() 轉 UTC 導致日期偏移一天
function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

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

// 樣板 t 在選定月份內是否為有效區間（active_from ~ active_until 與該月有重疊）
function templateActiveInMonth(t, month) {
  const [monthStart, monthEndExclusive] = monthRangeStr(month);
  return t.active_from < monthEndExclusive && (!t.active_until || t.active_until >= monthStart);
}

// 該月最後一天的日期字串；用 Date(year, month, 0) 純本地日期運算取得天數，避免 toISOString() 轉 UTC 導致日期偏移一天
function monthLastDay(month) {
  const [y, m] = month.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  return `${month}-${String(lastDay).padStart(2, '0')}`;
}

const RATE_LABEL = { rate_grade_1_6: '1-6年級', rate_grade_7_9: '7-9年級', rate_grade_10_12: '10-12年級', rate_admin: '行政' };

function gradeRateColumn(grade) {
  if (grade <= 6) return 'rate_grade_1_6';
  if (grade <= 9) return 'rate_grade_7_9';
  return 'rate_grade_10_12';
}

// 依目前已選學生的年級分佈，算出建議時薪（跟後端 calcSessionPay 的多數決邏輯一致）；沒有學生選好時用行政時薪
function suggestedRate(teacher, allStudents, entries) {
  const chosen = entries.map((e) => allStudents.find((s) => s.id === e.student_id)).filter(Boolean);
  if (chosen.length === 0) return teacher.rate_admin;
  const counts = {};
  for (const s of chosen) {
    const col = gradeRateColumn(s.grade);
    counts[col] = (counts[col] || 0) + 1;
  }
  const topColumn = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  return teacher[topColumn];
}

export default function TeacherDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { currentSchoolId, currentMembership, schoolSettings } = useAuth();

  useEffect(() => {
    setLastVisitedId('/teachers', id);
  }, [id]);
  // isAdmin：對教師檔案/課表子系統有完整操作權限（含 admin 與 front_desk 櫃台）
  // isFinanceAdmin：薪資明細屬財務資料，僅管理者本人可查看/操作
  const isAdmin = ['admin', 'front_desk'].includes(currentMembership?.role);
  const isFinanceAdmin = currentMembership?.role === 'admin';
  // 彈性上課時段是教師唯一可以自己編輯的欄位：管理者/櫃台可編輯任何教師，教師本人只能編輯自己的
  const canEditFlexibleSchedule = isAdmin || currentMembership?.teacher_id === id;

  const [teacher, setTeacher] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [history, setHistory] = useState([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 2500);
    return () => clearTimeout(timer);
  }, [notice]);

  const [editingBasic, setEditingBasic] = useState(false);
  const [basicForm, setBasicForm] = useState({
    name: '',
    subjects: [],
    rate_grade_1_6: 0,
    rate_grade_7_9: 0,
    rate_grade_10_12: 0,
    rate_admin: 0,
    status: 'active',
    note: '',
  });

  const [flexibleScheduleForm, setFlexibleScheduleForm] = useState(emptyFlexibleScheduleForm());

  const [editingSession, setEditingSession] = useState(null);
  const [editSessionForm, setEditSessionForm] = useState({ date: '', start_time: '', end_time: '' });

  const [templateMonth, setTemplateMonth] = useState(currentMonth());
  const [historyMonth, setHistoryMonth] = useState(currentMonth());

  // 新增排課／固定行政時段／單次行政時數，三個功能合併成一個表單：
  // formKind 決定是「教學」（要選學生）還是「行政」（無學生，科目預設「行政」），scheduleMode 決定「單堂」或「固定」
  const [students, setStudents] = useState([]);
  const [showScheduleForm, setShowScheduleForm] = useState(false);
  const [formKind, setFormKind] = useState('teaching'); // 'teaching' | 'admin'
  const [scheduleMode, setScheduleMode] = useState('single'); // 'single' | 'multiple'
  const [groupChangeForm, setGroupChangeForm] = useState({
    subject: '',
    entries: [{ student_id: '', unit_price: 0 }],
    new_date: todayStr(),
    new_start_time: '',
    new_end_time: '',
    rate_override: '',
  });
  const [groupFixedForm, setGroupFixedForm] = useState({
    subject: '',
    entries: [{ student_id: '', unit_price: 0 }],
    weekdays: [1],
    start_time: '',
    end_time: '',
    start_month: currentMonth(),
    end_month: '',
    rate_override: '',
  });

  const load = useCallback(async () => {
    if (!currentSchoolId || !id) return;
    const [start, end] = monthRangeStr(historyMonth);
    const canSeeFinance = currentMembership?.role === 'admin' || currentMembership?.teacher_id === id;
    const isAdminNow = ['admin', 'front_desk'].includes(currentMembership?.role);
    const [t, tpl, hist, st] = await Promise.all([
      api.get(`/api/schools/${currentSchoolId}/teachers/${id}`),
      api.get(`/api/schools/${currentSchoolId}/schedule-templates`),
      canSeeFinance
        ? api.get(`/api/schools/${currentSchoolId}/teachers/${id}/sessions?start=${start}&end=${end}`)
        : Promise.resolve([]),
      isAdminNow ? api.get(`/api/schools/${currentSchoolId}/students`) : Promise.resolve([]),
    ]);
    setTeacher(t);
    setTemplates(tpl.filter((tp) => tp.teacher_id === id));
    setHistory(hist);
    setStudents(st);
  }, [currentSchoolId, id, historyMonth, currentMembership]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!currentSchoolId) return;
    return subscribeSchool(currentSchoolId, (resource) => {
      if (['teachers', 'schedule', 'sessions', 'finance', 'students'].includes(resource)) load();
    });
  }, [currentSchoolId, load]);

  // 教學排課依所選學生年級分佈帶入建議時薪，行政時段直接用教師的行政時薪；尚未手動調整過、欄位仍是空的才帶入
  useEffect(() => {
    if (!teacher) return;
    const rate = formKind === 'admin' ? teacher.rate_admin : suggestedRate(teacher, students, groupChangeForm.entries);
    setGroupChangeForm((f) => (f.rate_override === '' ? { ...f, rate_override: rate } : f));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teacher, students, formKind, groupChangeForm.entries]);

  useEffect(() => {
    if (!teacher) return;
    const rate = formKind === 'admin' ? teacher.rate_admin : suggestedRate(teacher, students, groupFixedForm.entries);
    setGroupFixedForm((f) => (f.rate_override === '' ? { ...f, rate_override: rate } : f));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teacher, students, formKind, groupFixedForm.entries]);

  if (!teacher) return <p>載入中...</p>;

  const canSeeFinance = isFinanceAdmin || currentMembership?.teacher_id === id;

  const startEditBasic = () => {
    setError('');
    setBasicForm({
      name: teacher.name,
      subjects: teacher.subjects || [],
      rate_grade_1_6: teacher.rate_grade_1_6,
      rate_grade_7_9: teacher.rate_grade_7_9,
      rate_grade_10_12: teacher.rate_grade_10_12,
      rate_admin: teacher.rate_admin,
      status: teacher.status,
      note: teacher.note || '',
    });
    setFlexibleScheduleForm(flexibleScheduleToForm(teacher.flexible_schedule));
    setEditingBasic(true);
  };

  // 管理者/櫃台可以一次改完所有欄位（含彈性時段）；教師本人只能改自己的彈性時段，走專屬端點
  const saveBasic = async (e) => {
    e.preventDefault();
    setError('');
    try {
      if (isAdmin) {
        const payload = {
          name: basicForm.name.trim(),
          subjects: basicForm.subjects,
          rate_grade_1_6: Number(basicForm.rate_grade_1_6) || 0,
          rate_grade_7_9: Number(basicForm.rate_grade_7_9) || 0,
          rate_grade_10_12: Number(basicForm.rate_grade_10_12) || 0,
          rate_admin: Number(basicForm.rate_admin) || 0,
          status: basicForm.status,
          note: basicForm.note.trim() || null,
          flexible_schedule: flexibleScheduleFormToPayload(flexibleScheduleForm),
        };
        const result = await api.put(`/api/schools/${currentSchoolId}/teachers/${id}`, payload);
        if (result.duplicate_name) {
          alert(`已有同名教師「${result.name}」，請確認是否為重複。`);
        }
      } else {
        await api.put(`/api/schools/${currentSchoolId}/teachers/${id}/flexible-schedule`, {
          flexible_schedule: flexibleScheduleFormToPayload(flexibleScheduleForm),
        });
      }
      setEditingBasic(false);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  // 學生端刪除固定課堂是用 active_until 停止未來排課（保留歷史），教師這邊也依選定月份顯示「該月仍生效」的
  const fixedAdminTemplates = templates.filter((t) => t.students.length === 0 && templateActiveInMonth(t, templateMonth));
  const teachingTemplates = templates.filter((t) => t.students.length > 0 && templateActiveInMonth(t, templateMonth));

  const removeTemplate = async (tpl) => {
    const kind = tpl.students.length > 0 ? '固定課堂' : '固定行政時段';
    if (!confirm(`確定要刪除「${tpl.subject}」這項${kind}嗎？（自 ${templateMonth} 起將不再排課，之前已發生的課堂紀錄會保留）`)) return;
    setError('');
    try {
      // 用 active_until 停在選定月份之前，讓選定月份確實清空，同時保留已發生的課堂與薪資紀錄（與學生端固定課堂刪除邏輯一致）
      const [monthStart] = monthRangeStr(templateMonth);
      await api.put(`/api/schools/${currentSchoolId}/schedule-templates/${tpl.id}`, { active_until: addDays(monthStart, -1) });
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  // 切換「教學／行政」時把兩個表單的時薪欄位清空，讓建議值重新依新類型帶入
  const switchFormKind = (kind) => {
    setFormKind(kind);
    setGroupChangeForm((f) => ({ ...f, rate_override: '' }));
    setGroupFixedForm((f) => ({ ...f, rate_override: '' }));
  };

  const submitGroupChange = async (e) => {
    e.preventDefault();
    setError('');
    const isAdminKind = formKind === 'admin';
    const subject = groupChangeForm.subject.trim() || (isAdminKind ? '行政' : '');
    if (!subject) {
      setError('請選擇科目');
      return;
    }
    const chosenEntries = isAdminKind ? [] : groupChangeForm.entries.filter((entry) => entry.student_id);
    if (!isAdminKind && chosenEntries.length === 0) {
      setError('請至少選擇一位學生');
      return;
    }
    const hours = durationHoursBetween(groupChangeForm.new_start_time, groupChangeForm.new_end_time);
    if (!hours) {
      setError('結束時間需晚於開始時間');
      return;
    }
    try {
      const res = await api.post(`/api/schools/${currentSchoolId}/sessions`, {
        type: 'extra',
        teacher_id: id,
        subject,
        session_date: groupChangeForm.new_date,
        start_slot: timeToSlot(groupChangeForm.new_start_time),
        duration_slots: hoursToDurationSlots(hours),
        students: chosenEntries.map((entry) => ({ student_id: entry.student_id, unit_price: Number(entry.unit_price) || 0 })),
        rate_override: groupChangeForm.rate_override !== '' ? Number(groupChangeForm.rate_override) : null,
      });
      setShowScheduleForm(false);
      setNotice(
        res.auto_adjusted
          ? '行政時段新增成功（已自動避開既有課堂時段）'
          : isAdminKind
          ? '行政時段新增成功'
          : '加課成功'
      );
      setGroupChangeForm({
        subject: '',
        entries: [{ student_id: '', unit_price: 0 }],
        new_date: todayStr(),
        new_start_time: '',
        new_end_time: '',
        rate_override: '',
      });
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const submitGroupFixed = async (e) => {
    e.preventDefault();
    setError('');
    const isAdminKind = formKind === 'admin';
    const subject = groupFixedForm.subject.trim() || (isAdminKind ? '行政' : '');
    if (!subject) {
      setError('請選擇科目');
      return;
    }
    const chosenEntries = isAdminKind ? [] : groupFixedForm.entries.filter((entry) => entry.student_id);
    if (!isAdminKind && chosenEntries.length === 0) {
      setError('請至少選擇一位學生');
      return;
    }
    const hours = durationHoursBetween(groupFixedForm.start_time, groupFixedForm.end_time);
    if (!hours) {
      setError('結束時間需晚於開始時間');
      return;
    }
    if (groupFixedForm.weekdays.length === 0) {
      setError('請至少選擇一個星期');
      return;
    }
    if (!groupFixedForm.start_month) {
      setError('請選擇起始月份');
      return;
    }
    if (groupFixedForm.end_month && groupFixedForm.end_month < groupFixedForm.start_month) {
      setError('結束月份不能早於起始月份');
      return;
    }
    const [startMonthFirstDay] = monthRangeStr(groupFixedForm.start_month);
    const activeFrom = startMonthFirstDay < todayStr() ? todayStr() : startMonthFirstDay;
    const spanMonths = schoolSettings?.default_schedule_span_months || 4;
    const activeUntil = monthLastDay(groupFixedForm.end_month || shiftMonth(groupFixedForm.start_month, spanMonths - 1));
    const rateOverride = groupFixedForm.rate_override !== '' ? Number(groupFixedForm.rate_override) : null;
    const studentsPayload = chosenEntries.map((entry) => ({ student_id: entry.student_id, unit_price: Number(entry.unit_price) || 0 }));

    // 每個星期各自送出、各自成功失敗，避免其中一天完全衝突時，連帶讓其他天也一起失敗
    const results = await Promise.allSettled(
      groupFixedForm.weekdays.map((weekday) =>
        api
          .post(`/api/schools/${currentSchoolId}/schedule-templates`, {
            teacher_id: id,
            subject,
            weekday,
            start_slot: timeToSlot(groupFixedForm.start_time),
            duration_slots: hoursToDurationSlots(hours),
            students: studentsPayload,
            active_from: activeFrom,
            active_until: activeUntil,
            rate_override: rateOverride,
          })
          .then((res) => ({ weekday, res }))
      )
    );
    const succeeded = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    const failed = results.filter((r) => r.status === 'rejected');
    const anyAdjusted = succeeded.some(({ res }) => res.auto_adjusted);

    if (succeeded.length > 0) {
      setShowScheduleForm(false);
      setGroupFixedForm({
        subject: '',
        entries: [{ student_id: '', unit_price: 0 }],
        weekdays: [1],
        start_time: '',
        end_time: '',
        start_month: currentMonth(),
        end_month: '',
        rate_override: '',
      });
    }
    if (failed.length > 0) {
      setError(`部分星期新增失敗：${failed.map((r) => r.reason.message).join('；')}`);
    } else if (succeeded.length > 0) {
      setNotice(
        anyAdjusted
          ? '固定行政時段新增成功（已自動避開既有課堂時段）'
          : isAdminKind
          ? '固定行政時段新增成功'
          : '固定排課新增成功'
      );
    }
    load();
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

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
        <h2 style={{ margin: 0 }}>{teacher.name}</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          {canEditFlexibleSchedule && !editingBasic && <button type="button" onClick={startEditBasic}>編輯</button>}
          {currentMembership?.role === 'admin' && (
            <Link to={`/teachers/${id}/trash`}><button type="button">回收桶</button></Link>
          )}
        </div>
      </div>
      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}

      {editingBasic ? (
        <form onSubmit={saveBasic} style={{ marginTop: 8, maxWidth: 360, display: 'grid', gap: 8 }}>
          {isAdmin && (
            <>
              <label>
                姓名
                <input required value={basicForm.name} onChange={(e) => setBasicForm({ ...basicForm, name: e.target.value })} />
              </label>
              <label>
                科目
                <SubjectMultiSelect value={basicForm.subjects} onChange={(next) => setBasicForm({ ...basicForm, subjects: next })} />
              </label>
              <label>
                時薪 - 1~6年級
                <input type="number" value={basicForm.rate_grade_1_6} onChange={(e) => setBasicForm({ ...basicForm, rate_grade_1_6: e.target.value })} />
              </label>
              <label>
                時薪 - 7~9年級
                <input type="number" value={basicForm.rate_grade_7_9} onChange={(e) => setBasicForm({ ...basicForm, rate_grade_7_9: e.target.value })} />
              </label>
              <label>
                時薪 - 10~12年級
                <input type="number" value={basicForm.rate_grade_10_12} onChange={(e) => setBasicForm({ ...basicForm, rate_grade_10_12: e.target.value })} />
              </label>
              <label>
                時薪 - 行政
                <input type="number" value={basicForm.rate_admin} onChange={(e) => setBasicForm({ ...basicForm, rate_admin: e.target.value })} />
              </label>
              <label>
                狀態
                <select value={basicForm.status} onChange={(e) => setBasicForm({ ...basicForm, status: e.target.value })}>
                  <option value="active">在職</option>
                  <option value="inactive">停用</option>
                </select>
              </label>
            </>
          )}
          <div>
            <FlexibleScheduleEditor value={flexibleScheduleForm} onChange={setFlexibleScheduleForm} />
          </div>
          {isAdmin && (
            <label>
              備註
              <textarea value={basicForm.note} onChange={(e) => setBasicForm({ ...basicForm, note: e.target.value })} />
            </label>
          )}
          <div>
            <button type="submit">儲存</button>{' '}
            <button type="button" onClick={() => setEditingBasic(false)}>取消</button>
          </div>
        </form>
      ) : (
      <table style={{ borderCollapse: 'collapse' }}>
        <tbody>
          <tr>
            <td style={{ color: 'var(--text-muted)', paddingRight: 16 }}>科目</td>
            <td>
              <PillListSummary
                entries={(teacher.subjects || []).map((subj) => ({ key: subj, label: subj }))}
                emptyText="無科目"
              />
            </td>
          </tr>
          {Object.entries(RATE_LABEL).map(([key, label]) => (
            <tr key={key}>
              <td style={{ color: 'var(--text-muted)', paddingRight: 16 }}>時薪 - {label}</td>
              <td>{teacher[key]}</td>
            </tr>
          ))}
          <tr><td style={{ color: 'var(--text-muted)', paddingRight: 16 }}>狀態</td><td>{teacher.status === 'active' ? '在職' : '停用'}</td></tr>
          <tr><td style={{ color: 'var(--text-muted)', paddingRight: 16 }}>備註</td><td>{teacher.note}</td></tr>
          <tr>
            <td style={{ color: 'var(--text-muted)', paddingRight: 16, verticalAlign: 'top' }}>彈性上課時段</td>
            <td>
              <FlexibleScheduleSummary schedule={teacher.flexible_schedule} maxWidth={360} />
            </td>
          </tr>
          <tr><td style={{ color: 'var(--text-muted)', paddingRight: 16 }}>建檔日期</td><td>{teacher.created_at?.slice(0, 10)}</td></tr>
        </tbody>
      </table>
      )}

      <RelatedNotes teacherId={id} />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 24 }}>
        <h3 style={{ margin: 0 }}>排班</h3>
        <input type="month" value={templateMonth} onChange={(e) => setTemplateMonth(e.target.value)} />
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
                setGroupFixedForm((f) => ({
                  ...f,
                  start_month: templateMonth,
                  end_month: f.end_month || shiftMonth(templateMonth, spanMonths - 1),
                  start_time: f.start_time || defaultStart,
                  end_time: f.end_time || defaultEnd,
                }));
                setGroupChangeForm((f) => ({
                  ...f,
                  new_start_time: f.new_start_time || defaultStart,
                  new_end_time: f.new_end_time || defaultEnd,
                }));
                switchFormKind('teaching');
              }
              setShowScheduleForm((v) => !v);
            }}
          >
            {showScheduleForm ? '取消' : '+ 新增排課'}
          </button>
          {showScheduleForm && (
            <div style={{ marginTop: 8, display: 'grid', gap: 8, maxWidth: 360 }}>
              <div style={{ display: 'flex', gap: 16 }}>
                <label style={{ display: 'inline-flex', flexDirection: 'row', alignItems: 'center', gap: 4, width: 100 }}>
                  <input type="radio" name="teacherFormKind" checked={formKind === 'teaching'} onChange={() => switchFormKind('teaching')} />
                  教學排課
                </label>
                <label style={{ display: 'inline-flex', flexDirection: 'row', alignItems: 'center', gap: 4, width: 100 }}>
                  <input type="radio" name="teacherFormKind" checked={formKind === 'admin'} onChange={() => switchFormKind('admin')} />
                  行政時段
                </label>
              </div>
              <div style={{ display: 'flex', gap: 16 }}>
                <label style={{ display: 'inline-flex', flexDirection: 'row', alignItems: 'center', gap: 4, width: 100 }}>
                  <input type="radio" name="teacherScheduleMode" checked={scheduleMode === 'single'} onChange={() => setScheduleMode('single')} />
                  單堂
                </label>
                <label style={{ display: 'inline-flex', flexDirection: 'row', alignItems: 'center', gap: 4, width: 100 }}>
                  <input type="radio" name="teacherScheduleMode" checked={scheduleMode === 'multiple'} onChange={() => setScheduleMode('multiple')} />
                  多堂
                </label>
              </div>

              {scheduleMode === 'single' ? (
                <form onSubmit={submitGroupChange} style={{ marginTop: 8, display: 'grid', gap: 8, maxWidth: 360 }}>
                  {formKind === 'teaching' ? (
                    <>
                      <label>
                        科目
                        <SubjectSelect value={groupChangeForm.subject} onChange={(v) => setGroupChangeForm({ ...groupChangeForm, subject: v })} />
                      </label>
                      <GroupStudentSelect
                        students={students}
                        school={schoolSettings}
                        maxGroupSize={schoolSettings?.group_class_max_students || 2}
                        entries={groupChangeForm.entries}
                        onChange={(entries) => setGroupChangeForm({ ...groupChangeForm, entries })}
                      />
                    </>
                  ) : (
                    <label>
                      類型
                      <input
                        value={groupChangeForm.subject}
                        placeholder="行政"
                        onChange={(e) => setGroupChangeForm({ ...groupChangeForm, subject: e.target.value })}
                      />
                    </label>
                  )}
                  <label>
                    日期
                    <input type="date" value={groupChangeForm.new_date} onChange={(e) => setGroupChangeForm({ ...groupChangeForm, new_date: e.target.value })} />
                  </label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <label>
                      開始時間
                      <TimeInput
                        value={groupChangeForm.new_start_time}
                        onChange={(v) =>
                          setGroupChangeForm({
                            ...groupChangeForm,
                            new_start_time: v,
                            new_end_time: addHoursToTime(v, schoolSettings?.default_class_duration_hours || 1.5),
                          })
                        }
                      />
                    </label>
                    <label>
                      結束時間
                      <TimeInput value={groupChangeForm.new_end_time} onChange={(v) => setGroupChangeForm({ ...groupChangeForm, new_end_time: v })} />
                    </label>
                  </div>
                  <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 13 }}>
                    總時長：{durationHoursBetween(groupChangeForm.new_start_time, groupChangeForm.new_end_time) || 0} 小時
                  </p>
                  <label>
                    時薪
                    <input
                      type="number"
                      value={groupChangeForm.rate_override}
                      onChange={(e) => setGroupChangeForm({ ...groupChangeForm, rate_override: e.target.value })}
                    />
                  </label>
                  <div><button type="submit">送出</button></div>
                </form>
              ) : (
                <form onSubmit={submitGroupFixed} style={{ marginTop: 8, display: 'grid', gap: 8, maxWidth: 360 }}>
                  {formKind === 'teaching' ? (
                    <>
                      <label>
                        科目
                        <SubjectSelect value={groupFixedForm.subject} onChange={(v) => setGroupFixedForm({ ...groupFixedForm, subject: v })} />
                      </label>
                      <GroupStudentSelect
                        students={students}
                        school={schoolSettings}
                        maxGroupSize={schoolSettings?.group_class_max_students || 2}
                        entries={groupFixedForm.entries}
                        onChange={(entries) => setGroupFixedForm({ ...groupFixedForm, entries })}
                      />
                    </>
                  ) : (
                    <label>
                      類型
                      <input
                        value={groupFixedForm.subject}
                        placeholder="行政"
                        onChange={(e) => setGroupFixedForm({ ...groupFixedForm, subject: e.target.value })}
                      />
                    </label>
                  )}
                  <label>
                    星期（可複選）
                    <WeekdayCheckboxes value={groupFixedForm.weekdays} onChange={(v) => setGroupFixedForm({ ...groupFixedForm, weekdays: v })} />
                  </label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <label>
                      開始時間
                      <TimeInput
                        value={groupFixedForm.start_time}
                        onChange={(v) =>
                          setGroupFixedForm({
                            ...groupFixedForm,
                            start_time: v,
                            end_time: addHoursToTime(v, schoolSettings?.default_class_duration_hours || 1.5),
                          })
                        }
                      />
                    </label>
                    <label>
                      結束時間
                      <TimeInput value={groupFixedForm.end_time} onChange={(v) => setGroupFixedForm({ ...groupFixedForm, end_time: v })} />
                    </label>
                  </div>
                  <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 13 }}>
                    總時長：{durationHoursBetween(groupFixedForm.start_time, groupFixedForm.end_time) || 0} 小時
                  </p>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <label>
                      起始月份
                      <input
                        type="month"
                        required
                        value={groupFixedForm.start_month}
                        onChange={(e) =>
                          setGroupFixedForm({
                            ...groupFixedForm,
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
                        value={groupFixedForm.end_month}
                        onChange={(e) => setGroupFixedForm({ ...groupFixedForm, end_month: e.target.value })}
                      />
                    </label>
                  </div>
                  <label>
                    時薪
                    <input
                      type="number"
                      value={groupFixedForm.rate_override}
                      onChange={(e) => setGroupFixedForm({ ...groupFixedForm, rate_override: e.target.value })}
                    />
                  </label>
                  <div><button type="submit">送出</button></div>
                </form>
              )}
            </div>
          )}
        </>
      )}

      <h4 style={{ marginTop: 16, marginBottom: 4 }}>固定課堂</h4>
      <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
        <colgroup>
          <col style={{ width: 100 }} /><col style={{ width: 80 }} /><col style={{ width: 140 }} /><col style={{ width: 100 }} /><col />
          {isAdmin && <col style={{ width: 80 }} />}
        </colgroup>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid var(--border-strong)' }}>
            <th>科目</th><th>星期</th><th>時段</th><th>總時長</th><th>學生</th>{isAdmin && <th></th>}
          </tr>
        </thead>
        <tbody>
          {teachingTemplates.map((t) => (
            <tr key={t.id} style={{ borderBottom: '1px solid var(--border)' }}>
              <td>{t.subject}</td>
              <td>星期{WEEKDAY_LABELS[t.weekday]}</td>
              <td>{slotRangeLabel(t.start_slot, t.duration_slots)}</td>
              <td>{durationSlotsToHours(t.duration_slots)} 小時</td>
              <td>{t.student_ids.map((sid) => students.find((s) => s.id === sid)?.name || '未知').join(', ')}</td>
              {isAdmin && <td><button onClick={() => removeTemplate(t)}>刪除</button></td>}
            </tr>
          ))}
          {teachingTemplates.length === 0 && (
            <tr><td colSpan={isAdmin ? 6 : 5} style={{ color: 'var(--text-muted)', padding: 12 }}>這個月無任教固定課堂</td></tr>
          )}
        </tbody>
      </table>

      {isAdmin && (
        <>
          <h4 style={{ marginTop: 16, marginBottom: 4 }}>固定行政</h4>
          <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: 100 }} /><col style={{ width: 80 }} /><col style={{ width: 140 }} /><col style={{ width: 100 }} /><col /><col style={{ width: 80 }} />
            </colgroup>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '2px solid var(--border-strong)' }}>
                <th>科目</th><th>星期</th><th>時段</th><th>總時長</th><th></th><th></th>
              </tr>
            </thead>
            <tbody>
              {fixedAdminTemplates.map((t) => (
                <tr key={t.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td>{t.subject}</td>
                  <td>星期{WEEKDAY_LABELS[t.weekday]}</td>
                  <td>{slotRangeLabel(t.start_slot, t.duration_slots)}</td>
                  <td>{durationSlotsToHours(t.duration_slots)} 小時</td>
                  <td></td>
                  <td><button onClick={() => removeTemplate(t)}>刪除</button></td>
                </tr>
              ))}
              {fixedAdminTemplates.length === 0 && (
                <tr><td colSpan={6} style={{ color: 'var(--text-muted)', padding: 12 }}>這個月無固定行政時段</td></tr>
              )}
            </tbody>
          </table>
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
            <th>日期</th><th>時段</th><th>類型</th><th>備註</th><th>學生</th><th>狀態</th><th>時數</th><th>適用時薪</th><th>金額</th>{isAdmin && <th></th>}
          </tr>
        </thead>
        <tbody>
          {history.map((h) =>
            editingSession === h.session_id ? (
              <tr key={h.session_id} style={{ borderBottom: '1px solid var(--border)' }}>
                <td><input type="date" value={editSessionForm.date} onChange={(e) => setEditSessionForm({ ...editSessionForm, date: e.target.value })} /></td>
                <td colSpan={2} style={{ display: 'flex', gap: 8 }}>
                  <TimeInput
                    value={editSessionForm.start_time}
                    onChange={(v) =>
                      setEditSessionForm({
                        ...editSessionForm,
                        start_time: v,
                        end_time: addHoursToTime(v, schoolSettings?.default_class_duration_hours || 1.5),
                      })
                    }
                  />
                  <TimeInput value={editSessionForm.end_time} onChange={(v) => setEditSessionForm({ ...editSessionForm, end_time: v })} />
                </td>
                <td></td>
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
                <td>{slotRangeLabel(h.start_slot, h.duration_slots)}</td>
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
            <tr><td colSpan={isAdmin ? 10 : 9} style={{ color: 'var(--text-muted)', padding: 12 }}>這個月無課堂紀錄</td></tr>
          )}
        </tbody>
      </table>
      </>
      )}

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
