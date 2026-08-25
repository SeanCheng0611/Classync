import { useEffect, useState, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { subscribeSchool } from '../socket';
import { WEEKDAY_LABELS, slotToTime, timeToSlot, slotRangeLabel, todayStr, hoursToDurationSlots, durationHoursBetween, addHoursToTime } from '../lib/time';
import TimeInput from '../components/TimeInput';
import SubjectSelect from '../components/SubjectSelect';
import SearchSelect from '../components/SearchSelect';
import GroupStudentSelect from '../components/GroupStudentSelect';
import { sessionTypeLabel, sessionTypeColor, leaveColor, parseTypeOrder, sessionTypeOrderRank } from '../lib/sessionType';

function emptyAddClassForm() {
  return { teacher_id: '', subject: '', entries: [{ student_id: '', unit_price: 0 }], date: todayStr(), start_time: '', end_time: '' };
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
  const { currentSchoolId, currentMembership, schoolSettings } = useAuth();
  const isAdmin = ['admin', 'front_desk'].includes(currentMembership?.role);

  const [weekStart, setWeekStart] = useState(weekStartOf(todayStr()));
  const [sessions, setSessions] = useState([]);
  const [records, setRecords] = useState({});
  const [teachers, setTeachers] = useState([]);
  const [students, setStudents] = useState([]);
  const [school, setSchool] = useState(null);
  const [deleteMode, setDeleteMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [error, setError] = useState('');
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

  const [showAddClass, setShowAddClass] = useState(false);
  const [addClassForm, setAddClassForm] = useState(emptyAddClassForm);
  const addClassFormRef = useRef(null);

  const cancelAddClass = () => {
    setShowAddClass(false);
    setAddClassForm(emptyAddClassForm());
    setError('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const [rescheduleKey, setRescheduleKey] = useState(null);
  const [rescheduleForm, setRescheduleForm] = useState({ new_date: todayStr(), new_start_time: '', new_end_time: '', teacher_id: '' });
  const [expandedSessions, setExpandedSessions] = useState(new Set());
  const [expandedNames, setExpandedNames] = useState(new Set());

  const toggleExpanded = (sessionId) => {
    setExpandedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  };

  const toggleNamesExpanded = (sessionId) => {
    setExpandedNames((prev) => {
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

  const toggleDeleteMode = () => {
    setDeleteMode((v) => !v);
    setSelectedIds(new Set());
  };

  const toggleSelect = (sessionId) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  };

  const selectAllVisible = () => setSelectedIds(new Set(sessions.map((s) => s.id)));
  const clearSelection = () => setSelectedIds(new Set());

  const deleteSessionsByIds = async (ids) => {
    setError('');
    try {
      await Promise.all(ids.map((sessionId) => api.del(`/api/schools/${currentSchoolId}/sessions/${sessionId}`)));
      setSelectedIds(new Set());
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const bulkDelete = async () => {
    if (selectedIds.size === 0) return;
    if (!confirm(`確定要刪除選取的 ${selectedIds.size} 堂課嗎？可從回收桶復原。`)) return;
    await deleteSessionsByIds([...selectedIds]);
  };

  const deleteAllVisible = async () => {
    if (sessions.length === 0) return;
    if (!confirm(`確定要刪除目前顯示的全部 ${sessions.length} 堂課嗎？可從回收桶復原。`)) return;
    await deleteSessionsByIds(sessions.map((s) => s.id));
  };

  const submitAddClass = async (e) => {
    e.preventDefault();
    setError('');
    if (!addClassForm.subject.trim()) {
      setError('請選擇科目');
      return;
    }
    const chosenEntries = addClassForm.entries.filter((entry) => entry.student_id);
    if (chosenEntries.length === 0) {
      setError('請至少選擇一位學生');
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
        students: chosenEntries.map((entry) => ({ student_id: entry.student_id, unit_price: Number(entry.unit_price) || 0 })),
      });
      setShowAddClass(false);
      setAddClassForm(emptyAddClassForm());
      setNotice('加課成功');
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
      teacher_id: session.teacher_id,
    });
  };

  const confirmReschedule = async (session, personId) => {
    setError('');
    const hours = durationHoursBetween(rescheduleForm.new_start_time, rescheduleForm.new_end_time);
    if (!hours) {
      setError('結束時間需晚於開始時間');
      return;
    }
    if (!rescheduleForm.teacher_id) {
      setError('請選擇教師');
      return;
    }
    const student = session.students.find((s) => s.id === personId);
    let markedLeave = false;
    try {
      await api.post(`/api/schools/${currentSchoolId}/attendance`, {
        session_id: session.id,
        person_type: 'student',
        person_id: personId,
        status: 'leave',
        makeup_arranged: true,
      });
      markedLeave = true;
      await api.post(`/api/schools/${currentSchoolId}/sessions`, {
        type: 'makeup',
        origin_session_id: session.id,
        teacher_id: rescheduleForm.teacher_id,
        subject: session.subject,
        session_date: rescheduleForm.new_date,
        start_slot: timeToSlot(rescheduleForm.new_start_time),
        duration_slots: hoursToDurationSlots(hours),
        students: [{ student_id: personId, unit_price: student?.unit_price || 0 }],
      });
      setRescheduleKey(null);
      load();
    } catch (err) {
      // 新課堂建立失敗（例如時段重疊）時，把剛剛標記的請假/調課復原，避免卡在錯誤的「已調課」狀態
      if (markedLeave) {
        await api.del(
          `/api/schools/${currentSchoolId}/attendance?session_id=${session.id}&person_type=student&person_id=${personId}`
        );
      }
      setError(err.message);
      load();
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

  // 同一時段內的排序：1. 開始時間 2. 結束時間（越早結束排越前面）3. 固定課/加課/調課 的順序（見「設定」子系統，預設 加課-調課-固定課；已請假的課堂仍照原本類型排序，不會被排到最後）4. 年級-學校名-學生名
  const typeOrder = parseTypeOrder(schoolSettings);
  const sessionSortRank = (session) => sessionTypeOrderRank(session, typeOrder);
  // students 已由後端依 年級-學校名-學生名 排序回傳，用該順序的索引作為同類型課堂的第三排序依據
  const studentOrderIndex = (studentId) => students.findIndex((st) => st.id === studentId);
  const sessionNameOrderKey = (session) => {
    const idxs = session.students.map((s) => studentOrderIndex(s.id)).filter((i) => i >= 0);
    return idxs.length ? Math.min(...idxs) : Infinity;
  };

  const byDate = weekDates.map((date) => ({
    date,
    weekday: new Date(`${date}T00:00:00`).getDay(),
    items: sessions
      .filter((s) => s.session_date === date)
      .sort(
        (a, b) =>
          a.start_slot - b.start_slot ||
          (a.start_slot + a.duration_slots) - (b.start_slot + b.duration_slots) ||
          sessionSortRank(a) - sessionSortRank(b) ||
          sessionNameOrderKey(a) - sessionNameOrderKey(b)
      ),
  }));

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>課表</h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button onClick={() => setWeekStart(addDays(weekStart, -7))}>← 上一週</button>
          <input type="date" value={weekStart} onChange={(e) => setWeekStart(weekStartOf(e.target.value))} />
          <button onClick={() => setWeekStart(addDays(weekStart, 7))}>下一週 →</button>
          {isAdmin && (
            <button
              onClick={() => {
                if (showAddClass) {
                  cancelAddClass();
                  return;
                }
                setAddClassForm((f) => ({
                  ...f,
                  start_time: f.start_time || schoolSettings?.time_picker_range_start || '',
                  end_time: f.end_time || schoolSettings?.time_picker_range_end || '',
                }));
                setShowAddClass(true);
                requestAnimationFrame(() => addClassFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
              }}
            >
              {showAddClass ? '取消加課' : '+ 加課'}
            </button>
          )}
          {isAdmin && (
            <button type="button" onClick={toggleDeleteMode}>
              {deleteMode ? '結束刪除模式' : '刪除'}
            </button>
          )}
          {currentMembership?.role === 'admin' && (
            <Link to="/schedule/trash"><button type="button">回收桶</button></Link>
          )}
        </div>
      </div>

      {deleteMode && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
          <button type="button" onClick={selectAllVisible}>全選</button>
          <button type="button" onClick={clearSelection}>取消全選</button>
          <button type="button" onClick={bulkDelete} disabled={selectedIds.size === 0} style={{ color: 'var(--danger)' }}>
            刪除選取項目（{selectedIds.size}）
          </button>
          <button type="button" onClick={deleteAllVisible} style={{ color: 'var(--danger)' }}>
            全部刪除（{sessions.length}）
          </button>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 8, marginTop: 12 }}>
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
                    position: 'relative',
                    marginTop: 8,
                    padding: 6,
                    paddingRight: isAdmin ? 26 : 6,
                    paddingLeft: deleteMode ? 22 : 6,
                    background:
                      deleteMode && selectedIds.has(session.id)
                        ? 'var(--danger-soft, #fdecea)'
                        : grayedOut
                          ? 'var(--border)'
                          : 'var(--surface-muted)',
                    color: grayedOut ? 'var(--text-muted)' : undefined,
                    borderRadius: 4,
                    fontSize: 13,
                    textAlign: 'left',
                  }}
                >
                  {deleteMode && (
                    <input
                      type="checkbox"
                      checked={selectedIds.has(session.id)}
                      onChange={() => toggleSelect(session.id)}
                      style={{ position: 'absolute', top: 6, left: 4 }}
                    />
                  )}
                  {isAdmin && !deleteMode && (
                    <button
                      onClick={() => toggleExpanded(session.id)}
                      style={{ position: 'absolute', top: 4, right: 4, padding: '2px 6px', fontSize: 11, lineHeight: 1 }}
                      title={expandedSessions.has(session.id) ? '收合' : '展開'}
                    >
                      {expandedSessions.has(session.id) ? '▲' : '▼'}
                    </button>
                  )}
                  <div>{slotRangeLabel(session.start_slot, session.duration_slots)}</div>
                  <div style={{ marginTop: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {session.subject} - <Link to={`/teachers/${session.teacher_id}`}>{teacherName(session.teacher_id)}</Link>
                  </div>
                  {!(isAdmin && expandedSessions.has(session.id)) && (
                    <>
                      <div style={{ marginTop: 4, display: 'flex', flexWrap: 'nowrap', overflow: 'hidden', alignItems: 'center', gap: 4, textAlign: 'left' }}>
                        {session.students[0] && (
                          <span
                            style={{
                              display: 'inline-block',
                              flexShrink: 0,
                              padding: '0 6px',
                              fontSize: 11,
                              borderRadius: 999,
                              background: 'var(--surface)',
                              border: '1px solid var(--border-strong)',
                              color: 'var(--text)',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            <Link to={`/students/${session.students[0].id}`}>{session.students[0].name}</Link>
                          </span>
                        )}
                        {session.students.length > 1 && (
                          <span
                            onClick={() => toggleNamesExpanded(session.id)}
                            title={expandedNames.has(session.id) ? '收合' : `還有 ${session.students.length - 1} 位學生`}
                            style={{ flexShrink: 0, fontSize: 9, color: 'var(--text-muted)', cursor: 'pointer', lineHeight: 1 }}
                          >
                            {expandedNames.has(session.id) ? '▲' : '▼'}
                          </span>
                        )}
                        <span
                          style={{
                            fontSize: 11,
                            flexShrink: 0,
                            color: grayedOut
                              ? isMakeupArranged(session)
                                ? sessionTypeColor({ type: 'makeup' }, schoolSettings)
                                : leaveColor(schoolSettings)
                              : sessionTypeColor(session, schoolSettings),
                          }}
                          title={
                            session.type === 'makeup' && session.origin_session_date
                              ? `調課自 ${session.origin_session_date} ${slotToTime(session.origin_start_slot)}`
                              : undefined
                          }
                        >
                          {grayedOut
                            ? `[${isMakeupArranged(session) ? '已調課' : '已請假'}]`
                            : `[${sessionTypeLabel(session)}]`}
                        </span>
                      </div>
                      {expandedNames.has(session.id) && session.students.length > 1 && (
                        <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, textAlign: 'left' }}>
                          {session.students.slice(1).map((s) => (
                            <span
                              key={s.id}
                              style={{
                                display: 'inline-block',
                                flexShrink: 0,
                                padding: '0 6px',
                                fontSize: 11,
                                borderRadius: 999,
                                background: 'var(--surface)',
                                border: '1px solid var(--border-strong)',
                                color: 'var(--text)',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              <Link to={`/students/${s.id}`}>{s.name}</Link>
                            </span>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                  {isAdmin &&
                    expandedSessions.has(session.id) &&
                    session.students.map((s) => {
                      const record = records[recordKey(session.id, s.id)];
                      const onLeave = record?.status === 'leave';
                      return (
                        <div key={s.id} style={{ marginTop: 4, position: 'relative' }}>
                          {rescheduleKey === recordKey(session.id, s.id) ? (
                            <div
                              style={{
                                position: 'absolute',
                                top: 0,
                                left: 0,
                                right: 0,
                                zIndex: 30,
                                background: 'var(--surface)',
                                border: '1px solid var(--border-strong)',
                                borderRadius: 6,
                                boxShadow: 'var(--shadow)',
                                padding: 8,
                                boxSizing: 'border-box',
                                display: 'grid',
                                gap: 8,
                              }}
                            >
                              <SearchSelect
                                options={teachers}
                                value={rescheduleForm.teacher_id}
                                onChange={(v) => setRescheduleForm({ ...rescheduleForm, teacher_id: v })}
                              />
                              <input
                                type="date"
                                style={{ width: '100%' }}
                                value={rescheduleForm.new_date}
                                onChange={(e) => setRescheduleForm({ ...rescheduleForm, new_date: e.target.value })}
                              />
                              <TimeInput
                                style={{ width: '100%' }}
                                value={rescheduleForm.new_start_time}
                                onChange={(v) =>
                                  setRescheduleForm({
                                    ...rescheduleForm,
                                    new_start_time: v,
                                    new_end_time: addHoursToTime(v, schoolSettings?.default_class_duration_hours || 1.5),
                                  })
                                }
                              />
                              <TimeInput
                                style={{ width: '100%' }}
                                value={rescheduleForm.new_end_time}
                                onChange={(v) => setRescheduleForm({ ...rescheduleForm, new_end_time: v })}
                              />
                              <div>
                                <button onClick={() => confirmReschedule(session, s.id)}>確認</button>{' '}
                                <button
                                  onClick={async () => {
                                    setRescheduleKey(null);
                                    // 保險：若因故卡在「已標記請假/調課但尚未成功建立新課堂」的狀態，取消時一併復原
                                    if (record?.status === 'leave' && !record.makeup_session_id) {
                                      await undoStudent(session, s.id);
                                    }
                                  }}
                                >
                                  取消
                                </button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <div style={{ fontSize: 12 }}>
                                <Link to={`/students/${s.id}`}>{s.name}</Link>
                              </div>
                              <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'nowrap' }}>
                                {onLeave ? (
                                  <button style={{ fontSize: 13, padding: '5px 8px', flex: 1, whiteSpace: 'nowrap' }} onClick={() => undoStudent(session, s.id)}>
                                    {record.makeup_arranged ? '取消調課' : '取消請假'}
                                  </button>
                                ) : (
                                  <>
                                    <button style={{ fontSize: 13, padding: '5px 8px', flex: 1, whiteSpace: 'nowrap' }} onClick={() => leaveStudent(session, s.id)}>請假</button>
                                    <button style={{ fontSize: 13, padding: '5px 8px', flex: 1, whiteSpace: 'nowrap' }} onClick={() => startReschedule(session, s.id)}>調課</button>
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
        <form ref={addClassFormRef} onSubmit={submitAddClass} style={{ marginTop: 24, maxWidth: 360, display: 'grid', gap: 8 }}>
          <h3>加課</h3>
          {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
          <GroupStudentSelect
            students={students}
            school={school}
            maxGroupSize={school?.group_class_max_students || 2}
            entries={addClassForm.entries}
            onChange={(entries) => setAddClassForm({ ...addClassForm, entries })}
          />
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
              <TimeInput
                value={addClassForm.start_time}
                onChange={(v) =>
                  setAddClassForm({
                    ...addClassForm,
                    start_time: v,
                    end_time: addHoursToTime(v, schoolSettings?.default_class_duration_hours || 1.5),
                  })
                }
              />
            </label>
            <label>
              結束時間
              <TimeInput value={addClassForm.end_time} onChange={(v) => setAddClassForm({ ...addClassForm, end_time: v })} />
            </label>
          </div>
          <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 13 }}>
            總時長：{durationHoursBetween(addClassForm.start_time, addClassForm.end_time) || 0} 小時
          </p>
          <div>
            <button type="submit">送出</button>{' '}
            <button type="button" onClick={cancelAddClass}>取消</button>
          </div>
        </form>
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
