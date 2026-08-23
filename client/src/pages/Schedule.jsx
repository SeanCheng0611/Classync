import { useEffect, useState, useCallback } from 'react';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { subscribeSchool } from '../socket';
import { WEEKDAY_LABELS, slotToTime, timeToSlot, slotRangeLabel, todayStr, hoursToDurationSlots, durationHoursBetween } from '../lib/time';
import TimeInput from '../components/TimeInput';
import SubjectSelect from '../components/SubjectSelect';
import SearchSelect from '../components/SearchSelect';
import { defaultPriceForGrade } from '../lib/pricing';

function emptyAddClassForm() {
  return { teacher_id: '', subject: '', student_id: '', date: todayStr(), start_time: '', end_time: '', unit_price: 0 };
}

function recordKey(sessionId, personId) {
  return `${sessionId}:${personId}`;
}

// 格式化為 YYYY-MM-DD，全程用本地時間欄位組字串，避免 toISOString() 轉 UTC 導致日期偏移一天
function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 回傳 dateStr 所在那週的星期一日期字串，固定週一為一週的開始
function weekStartOf(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  const weekday = d.getDay(); // 0=日 ... 6=六
  const diffToMonday = weekday === 0 ? -6 : 1 - weekday;
  d.setDate(d.getDate() + diffToMonday);
  return formatDate(d);
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  return formatDate(d);
}

export default function Schedule() {
  const { currentSchoolId, currentMembership } = useAuth();
  const isAdmin = ['admin', 'front_desk'].includes(currentMembership?.role);

  const [weekStart, setWeekStart] = useState(weekStartOf(todayStr()));
  const [sessions, setSessions] = useState([]);
  const [records, setRecords] = useState({});
  const [teachers, setTeachers] = useState([]);
  const [students, setStudents] = useState([]);
  const [school, setSchool] = useState(null);
  const [error, setError] = useState('');

  const [showAddClass, setShowAddClass] = useState(false);
  const [addClassForm, setAddClassForm] = useState(emptyAddClassForm);

  const [rescheduleKey, setRescheduleKey] = useState(null);
  const [rescheduleForm, setRescheduleForm] = useState({ new_date: todayStr(), new_start_time: '', new_end_time: '' });
  const [expandedSessions, setExpandedSessions] = useState(new Set());

  const toggleExpanded = (sessionId) => {
    setExpandedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  };

  const weekDates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  const load = useCallback(async () => {
    if (!currentSchoolId) return;
    const [te, st, sch] = await Promise.all([
      api.get(`/api/schools/${currentSchoolId}/teachers`),
      api.get(`/api/schools/${currentSchoolId}/students`),
      api.get(`/api/schools/${currentSchoolId}`),
    ]);
    setTeachers(te);
    setStudents(st);
    setSchool(sch);

    const perDay = await Promise.all(
      weekDates.map((date) =>
        Promise.all([
          api.get(`/api/schools/${currentSchoolId}/sessions?date=${date}`),
          api.get(`/api/schools/${currentSchoolId}/attendance?date=${date}`),
        ])
      )
    );
    const allSessions = perDay.flatMap(([s]) => s);
    const map = {};
    for (const [, a] of perDay) {
      for (const r of a) map[recordKey(r.session_id, r.person_id)] = r;
    }
    setSessions(allSessions);
    setRecords(map);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSchoolId, weekStart]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!currentSchoolId) return;
    return subscribeSchool(currentSchoolId, (resource) => {
      if (['schedule', 'sessions', 'attendance', 'teachers', 'students'].includes(resource)) load();
    });
  }, [currentSchoolId, load]);

  const teacherName = (id) => teachers.find((t) => t.id === id)?.name || '未知';
  const studentSummary = (sessionStudents) => sessionStudents.map((s) => s.name).join(', ');

  // 選擇學生時，依其年級帶入補習班設定的單堂預設金額（尚未手動調整過才帶入，避免覆蓋使用者已輸入的值）
  useEffect(() => {
    if (!school || !addClassForm.student_id) return;
    const student = students.find((s) => s.id === addClassForm.student_id);
    if (!student) return;
    const price = defaultPriceForGrade(school, student.grade);
    setAddClassForm((f) => (f.unit_price === 0 ? { ...f, unit_price: price } : f));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [school, addClassForm.student_id, students]);

  const submitAddClass = async (e) => {
    e.preventDefault();
    setError('');
    if (!addClassForm.subject.trim()) {
      setError('請選擇科目');
      return;
    }
    if (!addClassForm.student_id) {
      setError('請選擇學生');
      return;
    }
    if (!addClassForm.teacher_id) {
      setError('請選擇教師');
      return;
    }
    const hours = durationHoursBetween(addClassForm.start_time, addClassForm.end_time);
    if (!hours) {
      setError('結束時間需晚於開始時間');
      return;
    }
    try {
      await api.post(`/api/schools/${currentSchoolId}/sessions`, {
        type: 'extra',
        teacher_id: addClassForm.teacher_id,
        subject: addClassForm.subject.trim(),
        session_date: addClassForm.date,
        start_slot: timeToSlot(addClassForm.start_time),
        duration_slots: hoursToDurationSlots(hours),
        students: [{ student_id: addClassForm.student_id, unit_price: Number(addClassForm.unit_price) || 0 }],
      });
      setShowAddClass(false);
      setAddClassForm(emptyAddClassForm());
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const leaveStudent = async (session, personId) => {
    setError('');
    try {
      await api.post(`/api/schools/${currentSchoolId}/attendance`, {
        session_id: session.id,
        person_type: 'student',
        person_id: personId,
        status: 'leave',
        makeup_arranged: false,
      });
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const startReschedule = (session, personId) => {
    setError('');
    setRescheduleKey(recordKey(session.id, personId));
    setRescheduleForm({
      new_date: session.session_date,
      new_start_time: slotToTime(session.start_slot),
      new_end_time: slotToTime(session.start_slot + session.duration_slots),
    });
  };

  const confirmReschedule = async (session, personId) => {
    setError('');
    const hours = durationHoursBetween(rescheduleForm.new_start_time, rescheduleForm.new_end_time);
    if (!hours) {
      setError('結束時間需晚於開始時間');
      return;
    }
    try {
      const student = session.students.find((s) => s.id === personId);
      await api.post(`/api/schools/${currentSchoolId}/attendance`, {
        session_id: session.id,
        person_type: 'student',
        person_id: personId,
        status: 'leave',
        makeup_arranged: true,
      });
      await api.post(`/api/schools/${currentSchoolId}/sessions`, {
        type: 'makeup',
        origin_session_id: session.id,
        teacher_id: session.teacher_id,
        subject: session.subject,
        session_date: rescheduleForm.new_date,
        start_slot: timeToSlot(rescheduleForm.new_start_time),
        duration_slots: hoursToDurationSlots(hours),
        students: [{ student_id: personId, unit_price: student?.unit_price || 0 }],
      });
      setRescheduleKey(null);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const undoStudent = async (session, personId) => {
    setError('');
    try {
      await api.del(
        `/api/schools/${currentSchoolId}/attendance?session_id=${session.id}&person_type=student&person_id=${personId}`
      );
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const isAllOnLeave = (session) =>
    session.students.length > 0 &&
    session.students.every((s) => records[recordKey(session.id, s.id)]?.status === 'leave');

  const isMakeupArranged = (session) =>
    session.students.some((s) => records[recordKey(session.id, s.id)]?.makeup_arranged);

  const byDate = weekDates.map((date) => ({
    date,
    weekday: new Date(`${date}T00:00:00`).getDay(),
    items: sessions.filter((s) => s.session_date === date).sort((a, b) => a.start_slot - b.start_slot),
  }));

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>課表</h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button onClick={() => setWeekStart(addDays(weekStart, -7))}>← 上一週</button>
          <input type="date" value={weekStart} onChange={(e) => setWeekStart(weekStartOf(e.target.value))} />
          <button onClick={() => setWeekStart(addDays(weekStart, 7))}>下一週 →</button>
          {isAdmin && (
            <button onClick={() => setShowAddClass((v) => !v)}>
              {showAddClass ? '取消加課' : '+ 加課'}
            </button>
          )}
        </div>
      </div>

      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 8, marginTop: 12 }}>
        {byDate.map(({ date, weekday, items }) => (
          <div key={date} className="card" style={{ padding: 8 }}>
            <strong>星期{WEEKDAY_LABELS[weekday]}</strong>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{date}</div>
            {items.map((session) => {
              const grayedOut = isAllOnLeave(session);
              return (
                <div
                  key={session.id}
                  style={{
                    marginTop: 8,
                    padding: 6,
                    background: grayedOut ? 'var(--border)' : 'var(--surface-muted)',
                    color: grayedOut ? 'var(--text-muted)' : undefined,
                    borderRadius: 4,
                    fontSize: 13,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 4 }}>
                    <div>
                      <div>{slotRangeLabel(session.start_slot, session.duration_slots)}</div>
                      <div>{session.subject} - {teacherName(session.teacher_id)}</div>
                      {(session.type !== 'regular' || grayedOut) && (
                        <div
                          style={{ fontSize: 11, color: grayedOut ? 'var(--text-muted)' : '#a60' }}
                          title={
                            session.type === 'makeup' && session.origin_session_date
                              ? `調課自 ${session.origin_session_date} ${slotToTime(session.origin_start_slot)}`
                              : undefined
                          }
                        >
                          {grayedOut
                            ? `[${isMakeupArranged(session) ? '已調課' : '已請假'}]`
                            : `[${session.type === 'makeup' ? '調課' : '加課'}]`}
                        </div>
                      )}
                      <div style={{ color: 'var(--text-muted)' }}>{studentSummary(session.students)}</div>
                    </div>
                    {isAdmin && (
                      <button
                        onClick={() => toggleExpanded(session.id)}
                        style={{ padding: '2px 6px', fontSize: 11, lineHeight: 1 }}
                        title={expandedSessions.has(session.id) ? '收合' : '展開'}
                      >
                        {expandedSessions.has(session.id) ? '▲' : '▼'}
                      </button>
                    )}
                  </div>
                  {isAdmin &&
                    expandedSessions.has(session.id) &&
                    session.students.map((s) => {
                      const record = records[recordKey(session.id, s.id)];
                      const onLeave = record?.status === 'leave';
                      return (
                        <div key={s.id} style={{ marginTop: 4 }}>
                          {rescheduleKey === recordKey(session.id, s.id) ? (
                            <div style={{ display: 'grid', gap: 4 }}>
                              <input
                                type="date"
                                value={rescheduleForm.new_date}
                                onChange={(e) => setRescheduleForm({ ...rescheduleForm, new_date: e.target.value })}
                              />
                              <TimeInput
                                value={rescheduleForm.new_start_time}
                                onChange={(v) => setRescheduleForm({ ...rescheduleForm, new_start_time: v })}
                              />
                              <TimeInput
                                value={rescheduleForm.new_end_time}
                                onChange={(v) => setRescheduleForm({ ...rescheduleForm, new_end_time: v })}
                              />
                              <div>
                                <button onClick={() => confirmReschedule(session, s.id)}>確認</button>{' '}
                                <button onClick={() => setRescheduleKey(null)}>取消</button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <div style={{ fontSize: 12 }}>{s.name}</div>
                              <div style={{ display: 'flex', gap: 4, marginTop: 2, flexWrap: 'wrap' }}>
                                {onLeave ? (
                                  <button style={{ fontSize: 12 }} onClick={() => undoStudent(session, s.id)}>
                                    {record.makeup_arranged ? '取消調課' : '取消請假'}
                                  </button>
                                ) : (
                                  <>
                                    <button style={{ fontSize: 12 }} onClick={() => leaveStudent(session, s.id)}>請假</button>
                                    <button style={{ fontSize: 12 }} onClick={() => startReschedule(session, s.id)}>調課</button>
                                  </>
                                )}
                              </div>
                            </>
                          )}
                        </div>
                      );
                    })}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {showAddClass && (
        <form onSubmit={submitAddClass} style={{ marginTop: 24, maxWidth: 360, display: 'grid', gap: 8 }}>
          <h3>加課</h3>
          {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
          <label>
            學生
            <SearchSelect options={students} value={addClassForm.student_id} onChange={(v) => setAddClassForm({ ...addClassForm, student_id: v })} />
          </label>
          <label>
            科目
            <SubjectSelect value={addClassForm.subject} onChange={(v) => setAddClassForm({ ...addClassForm, subject: v })} />
          </label>
          <label>
            教師
            <SearchSelect options={teachers} value={addClassForm.teacher_id} onChange={(v) => setAddClassForm({ ...addClassForm, teacher_id: v })} />
          </label>
          <label>
            日期
            <input type="date" value={addClassForm.date} onChange={(e) => setAddClassForm({ ...addClassForm, date: e.target.value })} />
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <label>
              開始時間
              <TimeInput value={addClassForm.start_time} onChange={(v) => setAddClassForm({ ...addClassForm, start_time: v })} />
            </label>
            <label>
              結束時間
              <TimeInput value={addClassForm.end_time} onChange={(v) => setAddClassForm({ ...addClassForm, end_time: v })} />
            </label>
          </div>
          <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 13 }}>
            總時長：{durationHoursBetween(addClassForm.start_time, addClassForm.end_time) || 0} 小時
          </p>
          <label>
            單堂價錢
            <input type="number" value={addClassForm.unit_price} onChange={(e) => setAddClassForm({ ...addClassForm, unit_price: e.target.value })} />
          </label>
          <div><button type="submit">送出</button></div>
        </form>
      )}
    </div>
  );
}
