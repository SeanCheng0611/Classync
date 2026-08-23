import { useEffect, useState, useCallback } from 'react';
import ExcelJS from 'exceljs';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { subscribeSchool } from '../socket';
import { todayStr, timeToSlot, slotRangeLabel } from '../lib/time';
import TimeInput from '../components/TimeInput';

const SEAT_NUMBERS = Array.from({ length: 13 }, (_, i) => i + 1);
// 依實際教室座位排列分排顯示：第一排1-4、第二排5-8、第三排9-11、第四排12-13
const SEAT_ROWS = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11], [12, 13]];

const DOUBLE_BLOCKS = [
  { key: 'b1', label: '時段1', start: '18:00', end: '19:30' },
  { key: 'b2', label: '時段2', start: '19:30', end: '21:00' },
];

const EXPORT_FONT = { name: '辰宇落雁體 2.0 Thin', size: 16 };
const EXPORT_BORDER = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };

// 找出 session 的開始時間落在哪個時段區間內；若都不在，退回第一個時段
function blockForSession(session, blocks) {
  for (const b of blocks) {
    const bStart = timeToSlot(b.start);
    const bEnd = timeToSlot(b.end);
    if (session.start_slot >= bStart && session.start_slot < bEnd) return b;
  }
  return blocks[0];
}

function sameStudents(seat, session) {
  const studentIds = session.students.map((s) => s.id);
  return (
    studentIds.length > 0 &&
    studentIds.length === seat.students.length &&
    studentIds.every((id) => seat.students.some((x) => x.id === id))
  );
}

export default function Seats() {
  const { currentSchoolId, currentMembership } = useAuth();
  const isAdmin = ['admin', 'front_desk'].includes(currentMembership?.role);

  const [date, setDate] = useState(todayStr());
  const [mode, setMode] = useState('double'); // single | double
  const [singleTime, setSingleTime] = useState({ start: '18:00', end: '19:30' });
  const [sessions, setSessions] = useState([]);
  const [teachers, setTeachers] = useState([]);
  const [seatsByBlock, setSeatsByBlock] = useState({});
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [blockOverrides, setBlockOverrides] = useState({}); // { [sessionId]: blockKey }，手動覆蓋「上課資訊」判斷的時段

  const blocks =
    mode === 'single'
      ? [{ key: 'single', label: '', start: singleTime.start, end: singleTime.end }]
      : DOUBLE_BLOCKS;

  const load = useCallback(async () => {
    if (!currentSchoolId) return;
    const [s, te] = await Promise.all([
      api.get(`/api/schools/${currentSchoolId}/sessions?date=${date}`),
      api.get(`/api/schools/${currentSchoolId}/teachers`),
    ]);
    setSessions(s);
    setTeachers(te);
  }, [currentSchoolId, date]);

  const loadSeats = useCallback(async () => {
    if (!currentSchoolId) return;
    const entries = await Promise.all(
      blocks.map(async (b) => [
        b.key,
        await api.get(`/api/schools/${currentSchoolId}/seats?date=${date}&time_slot=${timeToSlot(b.start)}`),
      ])
    );
    setSeatsByBlock(Object.fromEntries(entries));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSchoolId, date, mode, singleTime.start]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    loadSeats();
  }, [loadSeats]);

  useEffect(() => {
    if (!currentSchoolId) return;
    return subscribeSchool(currentSchoolId, (resource) => {
      if (['sessions', 'schedule', 'teachers', 'students'].includes(resource)) load();
      if (resource === 'seats') loadSeats();
    });
  }, [currentSchoolId, load, loadSeats]);

  const teacherName = (id) => teachers.find((t) => t.id === id)?.name || '';

  // 該課堂目前對應的時段：若管理者手動選過就用手動選的，否則依開始時間自動判斷（19:30 前=時段1，19:30 後=時段2）
  const resolvedBlock = (session) => {
    if (mode !== 'double') return blocks[0];
    const overrideKey = blockOverrides[session.id];
    if (overrideKey) return blocks.find((b) => b.key === overrideKey) || blockForSession(session, blocks);
    return blockForSession(session, blocks);
  };

  const assignSeat = async (session, newSeatNumber) => {
    setError('');
    const block = resolvedBlock(session);
    const slot = timeToSlot(block.start);
    const blockSeats = seatsByBlock[block.key] || [];
    const existing = blockSeats.find((s) => s.teacher_id === session.teacher_id && sameStudents(s, session));
    try {
      if (existing && existing.seat_number !== newSeatNumber) {
        await api.del(`/api/schools/${currentSchoolId}/seats/${existing.seat_number}?date=${date}&time_slot=${slot}`);
      }
      if (newSeatNumber) {
        await api.put(`/api/schools/${currentSchoolId}/seats/${newSeatNumber}`, {
          date,
          time_slot: slot,
          teacher_id: session.teacher_id,
          student_ids: session.students.slice(0, 2).map((s) => s.id),
        });
      }
      loadSeats();
    } catch (err) {
      setError(err.message);
    }
  };

  const clearBlockSeat = async (seatNumber, block) => {
    setError('');
    try {
      await api.del(`/api/schools/${currentSchoolId}/seats/${seatNumber}?date=${date}&time_slot=${timeToSlot(block.start)}`);
      loadSeats();
    } catch (err) {
      setError(err.message);
    }
  };

  // 匯出座位表：不論目前是單/雙時段模式，一律同時抓時段1(18:00)、時段2(19:30)的座位資料，
  // 匯出座位表：簡單列表，欄位為桌號、教師、學生、時段
  const exportSeatChart = async () => {
    setError('');
    setExporting(true);
    try {
      const [seatsB1, seatsB2] = await Promise.all([
        api.get(`/api/schools/${currentSchoolId}/seats?date=${date}&time_slot=${timeToSlot('18:00')}`),
        api.get(`/api/schools/${currentSchoolId}/seats?date=${date}&time_slot=${timeToSlot('19:30')}`),
      ]);
      const seatsByKey = { b1: seatsB1, b2: seatsB2 };

      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('座位表');
      sheet.columns = [
        { header: '桌號', key: 'seat', width: 8 },
        { header: '教師', key: 'teacher', width: 14 },
        { header: '學生', key: 'students', width: 20 },
        { header: '時段', key: 'block', width: 10 },
      ];
      sheet.getRow(1).eachCell((cell) => {
        cell.font = EXPORT_FONT;
        cell.border = EXPORT_BORDER;
      });

      for (const n of SEAT_NUMBERS) {
        for (const { key, label } of DOUBLE_BLOCKS) {
          const seat = seatsByKey[key].find((s) => s.seat_number === n);
          if (!seat || (!seat.teacher_id && seat.students.length === 0)) continue;
          const row = sheet.addRow({
            seat: n,
            teacher: teacherName(seat.teacher_id),
            students: seat.students.map((s) => s.name).join('、'),
            block: label,
          });
          row.eachCell((cell) => {
            cell.font = EXPORT_FONT;
            cell.border = EXPORT_BORDER;
          });
        }
      }

      const [, m, d] = date.split('-').map(Number);
      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const mmdd = `${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`;
      const filename = `座位清單 ${mmdd}.xlsx`;

      // 瀏覽器基於安全限制無法直接指定存到桌面；有支援「另存新檔」對話框的瀏覽器（如 Chrome/Edge）
      // 會跳出視窗讓你自己選位置（選過一次桌面後通常會記住），不支援的瀏覽器則退回存到預設下載資料夾
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

  // 上課資訊：列出當日全部有學生的課堂，依教師姓名、時間排序
  const daySessions = sessions
    .filter((s) => s.students.length > 0)
    .slice()
    .sort((a, b) => teacherName(a.teacher_id).localeCompare(teacherName(b.teacher_id)) || a.start_slot - b.start_slot);

  // 已排座位清單：把目前每個時段桌號上已確定的學生攤平列出，方便一眼確認誰已經排好座位
  const seatedList = blocks
    .flatMap((b) =>
      (seatsByBlock[b.key] || [])
        .filter((s) => s.students.length > 0)
        .flatMap((s) =>
          s.students.map((stu) => ({
            key: `${b.key}-${s.seat_number}-${stu.id}`,
            blockLabel: b.label,
            seatNumber: s.seat_number,
            studentName: stu.name,
            teacherName: teacherName(s.teacher_id),
          }))
        )
    )
    .sort((a, b) => a.seatNumber - b.seatNumber);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>座位系統</h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="single">單時段</option>
            <option value="double">雙時段</option>
          </select>
          {isAdmin && (
            <button disabled={exporting} onClick={exportSeatChart}>
              {exporting ? '匯出中...' : '匯出座位表'}
            </button>
          )}
        </div>
      </div>

      {mode === 'single' && (
        <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
          <TimeInput value={singleTime.start} onChange={(v) => setSingleTime({ ...singleTime, start: v })} />
          <span>-</span>
          <TimeInput value={singleTime.end} onChange={(v) => setSingleTime({ ...singleTime, end: v })} />
        </div>
      )}

      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}

      <div style={{ display: 'flex', gap: 16, marginTop: 16, alignItems: 'flex-start' }}>
        <div style={{ flex: '0 0 380px' }}>
          <h3 style={{ margin: '0 0 6px' }}>上課資訊</h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '2px solid var(--border-strong)' }}>
                <th>時間</th>
                <th>教師</th>
                <th>科目</th>
                <th>學生</th>
                {mode === 'double' && <th>時段</th>}
                <th>桌號</th>
              </tr>
            </thead>
            <tbody>
              {daySessions.map((session) => {
                const block = resolvedBlock(session);
                const blockSeats = seatsByBlock[block.key] || [];
                const assigned = blockSeats.find((s) => s.teacher_id === session.teacher_id && sameStudents(s, session));
                const tooManyStudents = session.students.length > 2;
                const occupiedByOtherTeacher = new Set(
                  blockSeats.filter((s) => s.teacher_id && s.teacher_id !== session.teacher_id).map((s) => s.seat_number)
                );
                return (
                  <tr key={session.id} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td>{slotRangeLabel(session.start_slot, session.duration_slots)}</td>
                    <td>{teacherName(session.teacher_id)}</td>
                    <td>{session.subject}</td>
                    <td>{session.students.map((s) => s.name).join(', ')}</td>
                    {mode === 'double' && (
                      <td>
                        {isAdmin ? (
                          <select
                            value={block.key}
                            onChange={(e) => setBlockOverrides({ ...blockOverrides, [session.id]: e.target.value })}
                          >
                            {DOUBLE_BLOCKS.map((b) => (
                              <option key={b.key} value={b.key}>{b.label}</option>
                            ))}
                          </select>
                        ) : (
                          block.label
                        )}
                      </td>
                    )}
                    <td>
                      {tooManyStudents ? (
                        <span style={{ color: 'var(--text-muted)' }}>超過2人請手動安排</span>
                      ) : isAdmin ? (
                        <select
                          value={assigned?.seat_number || ''}
                          onChange={(e) => assignSeat(session, e.target.value ? Number(e.target.value) : null)}
                        >
                          <option value="">未安排</option>
                          {SEAT_NUMBERS.filter((n) => n === assigned?.seat_number || !occupiedByOtherTeacher.has(n)).map((n) => (
                            <option key={n} value={n}>{n}</option>
                          ))}
                        </select>
                      ) : (
                        assigned?.seat_number || '未安排'
                      )}
                    </td>
                  </tr>
                );
              })}
              {daySessions.length === 0 && (
                <tr><td colSpan={mode === 'double' ? 6 : 5} style={{ color: 'var(--text-muted)', padding: 12 }}>這天沒有課</td></tr>
              )}
            </tbody>
          </table>

          <h3 style={{ margin: '16px 0 6px' }}>已排座位清單</h3>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: 13 }}>
            {seatedList.map((item) => (
              <li key={item.key} style={{ padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
                {item.seatNumber} 號桌{mode === 'double' && item.blockLabel ? `（${item.blockLabel}）` : ''} - {item.studentName}
                <span style={{ color: 'var(--text-muted)' }}>（{item.teacherName || '未安排教師'}）</span>
              </li>
            ))}
            {seatedList.length === 0 && (
              <li style={{ color: 'var(--text-muted)', padding: '4px 0' }}>尚無已排座位的學生</li>
            )}
          </ul>
        </div>

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {SEAT_ROWS.map((row, rowIdx) => (
            <div key={rowIdx} style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
              {row.map((n) => (
                <div key={n} data-seat={n} className="card" style={{ padding: 10 }}>
                  <strong>{n} 號桌</strong>
                  {blocks.map((b) => {
                    const seat = (seatsByBlock[b.key] || []).find((s) => s.seat_number === n);
                    const hasAssignment = seat && (seat.teacher_id || seat.students.length > 0);
                    return (
                      <div key={b.key} style={{ marginTop: 6, fontSize: 13 }}>
                        {b.label && <div style={{ color: 'var(--text-muted)' }}>{b.label}</div>}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 4 }}>
                          <span>
                            {hasAssignment
                              ? `${teacherName(seat.teacher_id) || '未安排教師'} - ${seat.students.map((s) => s.name).join(', ') || '未安排學生'}`
                              : '未安排'}
                          </span>
                          {isAdmin && hasAssignment && (
                            <button style={{ fontSize: 11 }} onClick={() => clearBlockSeat(n, b)}>清空</button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
