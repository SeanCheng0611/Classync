import { useEffect, useState, useCallback } from 'react';
import ExcelJS from 'exceljs';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { subscribeSchool } from '../socket';
import { slotRangeLabel, todayStr, timeToSlot, slotToTime, durationHoursBetween, hoursToDurationSlots } from '../lib/time';
import TimeInput from '../components/TimeInput';

const EXPORT_FONT = { name: '辰宇落雁體 2.0 Thin', size: 16 };
const EXPORT_BORDER = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };

const STATUS_LABEL = { present: '出席', absent: '缺席', leave: '請假' };

function recordKey(sessionId, personId) {
  return `${sessionId}:${personId}`;
}

function StatusButtons({
  session,
  personId,
  records,
  isAdmin,
  rescheduleKey,
  rescheduleForm,
  setRescheduleForm,
  setRescheduleKey,
  mark,
  undoRecord,
  startReschedule,
  confirmReschedule,
}) {
  const record = records[recordKey(session.id, personId)];

  if (!isAdmin) {
    if (!record) return <span style={{ color: 'var(--text-muted)' }}>尚未點名</span>;
    if (record.status === 'leave') {
      return <span>{record.makeup_arranged ? (record.makeup_session_id ? '已調課' : '已排調課') : '已請假'}</span>;
    }
    return <span>{STATUS_LABEL[record.status]}</span>;
  }

  if (rescheduleKey === recordKey(session.id, personId)) {
    return (
      <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type="date"
          style={{ width: 130 }}
          value={rescheduleForm.new_date}
          onChange={(e) => setRescheduleForm({ ...rescheduleForm, new_date: e.target.value })}
        />
        <TimeInput value={rescheduleForm.new_start_time} onChange={(v) => setRescheduleForm({ ...rescheduleForm, new_start_time: v })} />
        <span>-</span>
        <TimeInput value={rescheduleForm.new_end_time} onChange={(v) => setRescheduleForm({ ...rescheduleForm, new_end_time: v })} />
        <button onClick={() => confirmReschedule(session, personId)}>確認</button>
        <button onClick={() => setRescheduleKey(null)}>取消</button>
      </div>
    );
  }

  if (record?.status === 'leave') {
    const label = record.makeup_arranged ? '取消調課' : '取消請假';
    return <button onClick={() => undoRecord(session, personId)}>{label}</button>;
  }

  if (record?.status === 'present') {
    return (
      <button style={{ fontWeight: 'bold', background: 'var(--accent-soft)' }} onClick={() => undoRecord(session, personId)}>
        出席
      </button>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      <button onClick={() => mark(session, personId, 'present')}>出席</button>
      <button onClick={() => startReschedule(session, personId)}>調課</button>
      <button onClick={() => mark(session, personId, 'leave', false)}>請假</button>
    </div>
  );
}

export default function Attendance() {
  const { currentSchoolId, currentMembership } = useAuth();
  const isAdmin = ['admin', 'front_desk'].includes(currentMembership?.role);

  const [date, setDate] = useState(todayStr());
  const [sessions, setSessions] = useState([]);
  const [records, setRecords] = useState({});
  const [teachers, setTeachers] = useState([]);
  const [students, setStudents] = useState([]);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [rescheduleKey, setRescheduleKey] = useState(null); // `${sessionId}:${personId}` 正在調課中
  const [rescheduleForm, setRescheduleForm] = useState({ new_date: todayStr(), new_start_time: '', new_end_time: '' });

  const load = useCallback(async () => {
    if (!currentSchoolId || !date) return;
    const [s, a, te, st] = await Promise.all([
      api.get(`/api/schools/${currentSchoolId}/sessions?date=${date}`),
      api.get(`/api/schools/${currentSchoolId}/attendance?date=${date}`),
      api.get(`/api/schools/${currentSchoolId}/teachers`),
      api.get(`/api/schools/${currentSchoolId}/students`),
    ]);
    setSessions(s);
    setTeachers(te);
    setStudents(st);
    const map = {};
    for (const r of a) map[recordKey(r.session_id, r.person_id)] = r;
    setRecords(map);
  }, [currentSchoolId, date]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!currentSchoolId) return;
    return subscribeSchool(currentSchoolId, (resource) => {
      if (['sessions', 'attendance', 'schedule'].includes(resource)) load();
    });
  }, [currentSchoolId, load]);

  const mark = async (session, personId, status, makeupArranged) => {
    setError('');
    const record = records[recordKey(session.id, personId)];
    try {
      await api.post(`/api/schools/${currentSchoolId}/attendance`, {
        session_id: session.id,
        person_type: 'student',
        person_id: personId,
        status,
        makeup_arranged: makeupArranged !== undefined ? makeupArranged : !!record?.makeup_arranged,
      });
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const teacherName = (id) => teachers.find((t) => t.id === id)?.name || '未知';
  const studentGrade = (id) => students.find((s) => s.id === id)?.grade ?? '';

  // 匯出點名資訊：老師、年級、科目、姓名、時間；已調課/已請假的課堂不匯出（該堂實際上沒有上課）
  const exportAttendance = async () => {
    setError('');
    setExporting(true);
    try {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('點名');
      sheet.columns = [
        { header: '老師', key: 'teacher', width: 12 },
        { header: '年級', key: 'grade', width: 8 },
        { header: '科目', key: 'subject', width: 14 },
        { header: '姓名', key: 'name', width: 12 },
        { header: '時間', key: 'time', width: 16 },
      ];
      sheet.getRow(1).eachCell((cell) => {
        cell.font = EXPORT_FONT;
        cell.border = EXPORT_BORDER;
      });

      for (const session of sessions) {
        for (const student of session.students) {
          const record = records[recordKey(session.id, student.id)];
          if (record?.status === 'leave') continue;
          const row = sheet.addRow({
            teacher: teacherName(session.teacher_id),
            grade: studentGrade(student.id),
            subject: session.subject,
            name: student.name,
            time: slotRangeLabel(session.start_slot, session.duration_slots),
          });
          row.eachCell((cell) => {
            cell.font = EXPORT_FONT;
            cell.border = EXPORT_BORDER;
          });
        }
      }

      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const mmdd = date.replace(/-/g, '').slice(4);
      const filename = `點名清單 ${mmdd}.xlsx`;

      if (window.showSaveFilePicker) {
        try {
          const handle = await window.showSaveFilePicker({
            suggestedName: filename,
            types: [{ description: 'Excel 檔案', accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] } }],
          });
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
        } catch (pickerErr) {
          if (pickerErr.name !== 'AbortError') throw pickerErr;
        }
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      setError('匯出失敗：' + err.message);
    } finally {
      setExporting(false);
    }
  };

  // 取消請假/調課：撤銷這筆點名紀錄，若已排定調課課堂會一併刪除，恢復成「尚未點名」
  const undoRecord = async (session, personId) => {
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

  const startReschedule = (session, personId) => {
    setError('');
    setRescheduleKey(recordKey(session.id, personId));
    setRescheduleForm({
      new_date: session.session_date || date,
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

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>點名系統</h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          {isAdmin && (
            <button disabled={exporting} onClick={exportAttendance}>
              {exporting ? '匯出中...' : '匯出 Excel'}
            </button>
          )}
        </div>
      </div>

      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}

      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12 }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid var(--border-strong)' }}>
            <th>時間</th>
            <th>科目</th>
            <th>教師</th>
            <th>學生</th>
            <th>出缺勤</th>
          </tr>
        </thead>
        <tbody>
          {sessions.flatMap((session) =>
            session.students.length === 0 ? (
              []
            ) : (
              session.students.map((student) => {
                const record = records[recordKey(session.id, student.id)];
                const resolved = record?.status === 'leave';
                return (
                <tr key={session.id + student.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td>{slotRangeLabel(session.start_slot, session.duration_slots)}</td>
                  <td>
                    {session.subject}
                    {resolved ? (
                      <span style={{ marginLeft: 4, fontSize: 11, color: 'var(--text-muted)' }}>
                        [{record.makeup_arranged ? '已調課' : '已請假'}]
                      </span>
                    ) : (
                      session.type !== 'regular' && (
                        <span
                          style={{ marginLeft: 4, fontSize: 11, color: '#a60' }}
                          title={
                            session.type === 'makeup' && session.origin_session_date
                              ? `調課自 ${session.origin_session_date} ${slotToTime(session.origin_start_slot)}`
                              : undefined
                          }
                        >
                          [{session.type === 'makeup' ? '調課' : '加課'}]
                        </span>
                      )
                    )}
                  </td>
                  <td>{teacherName(session.teacher_id)}</td>
                  <td>{student.name}</td>
                  <td>
                    <StatusButtons
                      session={session}
                      personId={student.id}
                      records={records}
                      isAdmin={isAdmin}
                      rescheduleKey={rescheduleKey}
                      rescheduleForm={rescheduleForm}
                      setRescheduleForm={setRescheduleForm}
                      setRescheduleKey={setRescheduleKey}
                      mark={mark}
                      undoRecord={undoRecord}
                      startReschedule={startReschedule}
                      confirmReschedule={confirmReschedule}
                    />
                  </td>
                </tr>
                );
              })
            )
          )}
          {sessions.every((s) => s.students.length === 0) && (
            <tr>
              <td colSpan={5} style={{ color: 'var(--text-muted)', padding: 12 }}>
                這天沒有課程
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
