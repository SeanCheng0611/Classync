import { useEffect, useState, useCallback } from 'react';
import ExcelJS from 'exceljs';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { subscribeSchool } from '../socket';
import { todayStr, timeToSlot, slotRangeLabel } from '../lib/time';
import TimeInput from '../components/TimeInput';

// 座位版面預設值（新補習班或還沒載入時使用），實際版面存在 school.seat_layout，可透過拖曳調整、新增座位
const DEFAULT_SEAT_LAYOUT = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11], [12, 13]];

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

// 「上課資訊」／「已排座位清單」兩張表共用同一組固定欄寬，讓上下欄位對齊；四欄平均分配寬度
function ScheduleColGroup() {
  return (
    <colgroup>
      <col style={{ width: '25%' }} />
      <col style={{ width: '25%' }} />
      <col style={{ width: '25%' }} />
      <col style={{ width: '25%' }} />
    </colgroup>
  );
}

const CELL_PADDING = '8px 6px';
const nowrapCellStyle = { whiteSpace: 'nowrap', padding: CELL_PADDING };

const studentCellStyle = (expanded, clickable) => ({
  cursor: clickable ? 'pointer' : 'default',
  whiteSpace: expanded ? 'normal' : 'nowrap',
  wordBreak: expanded ? 'break-all' : 'normal',
  padding: CELL_PADDING,
});

function StudentCell({ session, expanded, onToggle }) {
  const extra = session.students.length - 1;
  const label = expanded
    ? session.students.map((s) => s.name).join('、')
    : `${session.students[0]?.name || ''}${extra > 0 ? `+${extra}` : ''}`;
  return (
    <td onClick={extra > 0 ? onToggle : undefined} title={extra > 0 ? '點擊展開/收合' : undefined} style={studentCellStyle(expanded, extra > 0)}>
      {label}
    </td>
  );
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
  const [seatLayout, setSeatLayout] = useState(null); // null＝版面資料還沒讀回來，避免切頁時先閃一下預設 13 桌版面才換成實際版面
  const [draggedSeat, setDraggedSeat] = useState(null);
  const [draggedSession, setDraggedSession] = useState(null);
  const [draggedAssignment, setDraggedAssignment] = useState(null); // { seatNumber, blockKey }：拖曳單一時段格子時的來源
  const [dragOverTarget, setDragOverTarget] = useState(null); // 目前拖曳懸停中的目標 key，用來顯示可否放置的即時提示
  const [deleteSeatMode, setDeleteSeatMode] = useState(false);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [expandedBlocks, setExpandedBlocks] = useState(new Set()); // `${座位號}:${blockKey}`：座位卡片內學生名單展開/收合
  const [expandedRows, setExpandedRows] = useState(new Set());
  const [blockOverrides, setBlockOverrides] = useState({}); // { [sessionId]: blockKey }，手動覆蓋「上課資訊」判斷的時段

  const seatNumbers = seatLayout ? seatLayout.flat() : [];

  const blocks =
    mode === 'single'
      ? [{ key: 'single', label: '', start: singleTime.start, end: singleTime.end }]
      : DOUBLE_BLOCKS;

  const load = useCallback(async () => {
    if (!currentSchoolId) return;
    const [s, te, sch] = await Promise.all([
      api.get(`/api/schools/${currentSchoolId}/sessions?date=${date}`),
      api.get(`/api/schools/${currentSchoolId}/teachers`),
      api.get(`/api/schools/${currentSchoolId}`),
    ]);
    setSessions(s);
    setTeachers(te);
    try {
      const layout = JSON.parse(sch.seat_layout);
      if (Array.isArray(layout) && layout.length > 0) {
        setSeatLayout(layout);
      } else {
        // 版面資料異常/空白：如果畫面上已經有讀到過的版面就維持現狀，只有從沒讀過（新補習班）才退回預設值
        setSeatLayout((prev) => prev ?? DEFAULT_SEAT_LAYOUT);
      }
    } catch {
      setSeatLayout((prev) => prev ?? DEFAULT_SEAT_LAYOUT);
    }
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
      if (['sessions', 'schedule', 'teachers', 'students', 'seat-layout'].includes(resource)) load();
      if (resource === 'seats') loadSeats();
    });
  }, [currentSchoolId, load, loadSeats]);

  const teacherName = (id) => teachers.find((t) => t.id === id)?.name || '';

  // 判斷某桌在目前所有時段是否完全沒有排課；只有完全空桌才能拖曳搬移「桌子本身的位置」，
  // 有課堂的桌子拖曳只能跟別桌互換課堂資訊，不會更動桌號版面
  const isSeatEmpty = (seatNumber) =>
    blocks.every((b) => {
      const seat = (seatsByBlock[b.key] || []).find((s) => s.seat_number === seatNumber);
      return !seat || (!seat.teacher_id && seat.students.length === 0);
    });

  const toggleRowExpanded = (sessionId) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  };

  const toggleBlockExpanded = (key) => {
    setExpandedBlocks((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // 該課堂目前對應的時段：若管理者手動選過就用手動選的，否則依開始時間自動判斷（19:30 前=時段1，19:30 後=時段2）
  const resolvedBlock = (session) => {
    if (mode !== 'double') return blocks[0];
    const overrideKey = blockOverrides[session.id];
    if (overrideKey) return blocks.find((b) => b.key === overrideKey) || blockForSession(session, blocks);
    return blockForSession(session, blocks);
  };

  // 直接掃過每個時段實際的座位資料找這堂課排在哪，不依賴「上課資訊」的時段欄位（blockOverrides）——
  // 這樣不管座位資料是透過指派、拖曳互換，還是清空之後重排的，「上課資訊」跟「已排座位清單」都能準確反映目前狀態
  const findAssignedBlock = (session) => {
    for (const b of blocks) {
      const seat = (seatsByBlock[b.key] || []).find((s) => s.teacher_id === session.teacher_id && sameStudents(s, session));
      if (seat) return { block: b, seat };
    }
    return null;
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

  // 從「上課資訊」拖課堂卡片，直接丟到某張桌子指定的時段格子：以拖放目標的時段為準（不管這堂課原本自動判斷是哪個時段），
  // 並清掉這堂課在其他時段既有的座位資料，避免同一堂課同時佔用兩個時段
  const assignSeatToBlock = async (session, newSeatNumber, blockKey) => {
    setError('');
    const block = blocks.find((b) => b.key === blockKey);
    if (!block) return;
    const slot = timeToSlot(block.start);
    try {
      for (const b of blocks) {
        if (b.key === blockKey) continue;
        const existingElsewhere = (seatsByBlock[b.key] || []).find(
          (s) => s.teacher_id === session.teacher_id && sameStudents(s, session)
        );
        if (existingElsewhere) {
          await api.del(
            `/api/schools/${currentSchoolId}/seats/${existingElsewhere.seat_number}?date=${date}&time_slot=${timeToSlot(b.start)}`
          );
        }
      }
      const existing = (seatsByBlock[blockKey] || []).find(
        (s) => s.teacher_id === session.teacher_id && sameStudents(s, session)
      );
      if (existing && existing.seat_number !== newSeatNumber) {
        await api.del(`/api/schools/${currentSchoolId}/seats/${existing.seat_number}?date=${date}&time_slot=${slot}`);
      }
      await api.put(`/api/schools/${currentSchoolId}/seats/${newSeatNumber}`, {
        date,
        time_slot: slot,
        teacher_id: session.teacher_id,
        student_ids: session.students.slice(0, 2).map((s) => s.id),
      });
      setBlockOverrides({ ...blockOverrides, [session.id]: blockKey });
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

  // 新增座位：由使用者輸入要新增的桌號；接在最後一排後面，該排未滿 4 個就補進去，滿了就另開新的一排
  const addSeat = async () => {
    if (!seatLayout) return;
    setError('');
    const input = prompt('請輸入要新增的桌號：');
    if (input === null) return;
    const seatNumber = Number(input.trim());
    if (!Number.isInteger(seatNumber) || seatNumber < 1) {
      setError('桌號必須是正整數');
      return;
    }
    if (seatNumbers.includes(seatNumber)) {
      setError(`${seatNumber} 號桌已經存在`);
      return;
    }
    const newLayout = seatLayout.map((row) => row.slice());
    const lastRow = newLayout[newLayout.length - 1];
    if (lastRow && lastRow.length < 4) {
      lastRow.push(seatNumber);
    } else {
      newLayout.push([seatNumber]);
    }
    try {
      await api.put(`/api/schools/${currentSchoolId}/seat-layout`, { layout: newLayout });
      setSeatLayout(newLayout);
    } catch (err) {
      setError(err.message);
    }
  };

  // 拖曳互換座位資料的共用邏輯：先把每一對「桌號+時段」原本的資料都清空，再寫入互換後的資料，
  // 避免同一位教師同時出現在兩桌而被後端擋下
  const swapAssignmentPairs = async (pairs) => {
    setError('');
    try {
      const withData = pairs.map(({ seatA, slotA, blockKeyA, seatB, slotB, blockKeyB }) => ({
        seatA,
        slotA,
        seatB,
        slotB,
        dataA: (seatsByBlock[blockKeyA] || []).find((s) => s.seat_number === seatA),
        dataB: (seatsByBlock[blockKeyB] || []).find((s) => s.seat_number === seatB),
      }));

      for (const { seatA, slotA, seatB, slotB, dataA, dataB } of withData) {
        if (dataA) await api.del(`/api/schools/${currentSchoolId}/seats/${seatA}?date=${date}&time_slot=${slotA}`);
        if (dataB) await api.del(`/api/schools/${currentSchoolId}/seats/${seatB}?date=${date}&time_slot=${slotB}`);
      }
      for (const { seatA, slotA, seatB, slotB, dataA, dataB } of withData) {
        if (dataB) {
          await api.put(`/api/schools/${currentSchoolId}/seats/${seatA}`, {
            date,
            time_slot: slotA,
            teacher_id: dataB.teacher_id,
            student_ids: dataB.students.map((s) => s.id),
          });
        }
        if (dataA) {
          await api.put(`/api/schools/${currentSchoolId}/seats/${seatB}`, {
            date,
            time_slot: slotB,
            teacher_id: dataA.teacher_id,
            student_ids: dataA.students.map((s) => s.id),
          });
        }
      }
      loadSeats();
    } catch (err) {
      setError(err.message);
      loadSeats();
    }
  };

  // 拖曳單一時段格子：只交換那一個時段的資料，另一個時段不受影響
  const swapBlockAssignment = (seatA, blockKeyA, seatB, blockKeyB) => {
    if (seatA === seatB && blockKeyA === blockKeyB) return;
    const blockA = blocks.find((b) => b.key === blockKeyA);
    const blockB = blocks.find((b) => b.key === blockKeyB);
    if (!blockA || !blockB) return;
    return swapAssignmentPairs([
      { seatA, slotA: timeToSlot(blockA.start), blockKeyA, seatB, slotB: timeToSlot(blockB.start), blockKeyB },
    ]);
  };

  // 拖曳「N 號桌」標題：兩個時段的資料一起交換
  const swapSeatAssignments = (seatA, seatB) => {
    if (seatA === seatB) return;
    return swapAssignmentPairs(
      blocks.map((b) => ({ seatA, slotA: timeToSlot(b.start), blockKeyA: b.key, seatB, slotB: timeToSlot(b.start), blockKeyB: b.key }))
    );
  };

  // 兩桌都是空桌時，直接互換桌號本身（版面位置對調）；反正兩邊都沒課堂資料可換，跟一般的
  // 「有課堂只能換資料」規則不衝突——只有這種兩邊皆空的情況，拖曳才會真的搬動桌號版面
  const swapSeatPositions = async (seatA, seatB) => {
    if (!seatLayout || seatA === seatB) return;
    const newLayout = seatLayout.map((row) => row.map((n) => (n === seatA ? seatB : n === seatB ? seatA : n)));
    setSeatLayout(newLayout);
    try {
      await api.put(`/api/schools/${currentSchoolId}/seat-layout`, { layout: newLayout });
    } catch (err) {
      setError(err.message);
      load();
    }
  };

  // 拖曳整桌丟到另一張桌子：兩邊都空桌就對調桌號位置，否則維持原本的規則（只換課堂資料，不動位置）
  const dropSeatOnSeat = (seatA, seatB) => {
    if (isSeatEmpty(seatA) && isSeatEmpty(seatB)) {
      return swapSeatPositions(seatA, seatB);
    }
    return swapSeatAssignments(seatA, seatB);
  };

  // 刪除座位：直接從版面上移除該桌號，不影響已產生的課堂/出缺勤紀錄
  const deleteSeat = async (seatNumber) => {
    if (!seatLayout) return;
    if (!confirm(`確定要刪除 ${seatNumber} 號桌嗎？`)) return;
    setError('');
    const newLayout = seatLayout.map((row) => row.filter((n) => n !== seatNumber)).filter((row) => row.length > 0);
    setSeatLayout(newLayout);
    try {
      await api.put(`/api/schools/${currentSchoolId}/seat-layout`, { layout: newLayout });
    } catch (err) {
      setError(err.message);
      load();
    }
  };

  // 自動排座位：把「上課資訊」裡還沒排入的課堂（人數 2 人以下者）依序塞進空桌；
  // 雙時段模式下，同一位教師若在兩個時段都有課，會盡量安排在同一張桌（已排過的時段優先沿用該桌號）
  const autoAssignSeats = async () => {
    setError('');
    const seatableSessions = daySessions.filter((s) => s.students.length <= 2);
    if (seatableSessions.length === 0) return;

    const takenByBlock = {};
    const teacherSeatByBlock = {};
    for (const b of blocks) {
      const blockSeats = seatsByBlock[b.key] || [];
      takenByBlock[b.key] = new Set(blockSeats.map((s) => s.seat_number));
      teacherSeatByBlock[b.key] = {};
      for (const s of blockSeats) {
        if (s.teacher_id) teacherSeatByBlock[b.key][s.teacher_id] = s.seat_number;
      }
    }

    const byTeacher = new Map();
    for (const session of seatableSessions) {
      const list = byTeacher.get(session.teacher_id) || [];
      list.push(session);
      byTeacher.set(session.teacher_id, list);
    }

    const assignments = [];
    let failedCount = 0;

    for (const [teacherId, sessionsForTeacher] of byTeacher) {
      let preferred = null;
      for (const b of blocks) {
        if (teacherSeatByBlock[b.key][teacherId]) {
          preferred = teacherSeatByBlock[b.key][teacherId];
          break;
        }
      }
      if (!preferred) {
        const neededBlocks = sessionsForTeacher.map((s) => resolvedBlock(s));
        preferred = seatNumbers.find((n) => neededBlocks.every((b) => !takenByBlock[b.key].has(n))) || null;
      }
      for (const session of sessionsForTeacher) {
        const block = resolvedBlock(session);
        let seatNumber = preferred && !takenByBlock[block.key].has(preferred) ? preferred : null;
        if (!seatNumber) seatNumber = seatNumbers.find((n) => !takenByBlock[block.key].has(n)) || null;
        if (!seatNumber) {
          failedCount += 1;
          continue;
        }
        takenByBlock[block.key].add(seatNumber);
        teacherSeatByBlock[block.key][teacherId] = seatNumber;
        assignments.push({ session, seatNumber, block });
      }
    }

    try {
      for (const { session, seatNumber, block } of assignments) {
        await api.put(`/api/schools/${currentSchoolId}/seats/${seatNumber}`, {
          date,
          time_slot: timeToSlot(block.start),
          teacher_id: session.teacher_id,
          student_ids: session.students.slice(0, 2).map((s) => s.id),
        });
      }
      loadSeats();
      if (failedCount > 0) setError(`已自動排入 ${assignments.length} 堂課，桌位不足，${failedCount} 堂課請手動安排`);
    } catch (err) {
      setError(err.message);
      loadSeats();
    }
  };

  // 拖曳到某一排的空位：把座位從原本的位置移出，接到目標排的最後面（該排最多 4 個，畫面上空位只會出現在未滿的排尾）
  const moveSeatToRow = async (seatNumber, targetRowIdx) => {
    if (!seatLayout) return;
    const newLayout = seatLayout.map((row) => row.filter((n) => n !== seatNumber));
    if (newLayout[targetRowIdx].length >= 4) return;
    newLayout[targetRowIdx].push(seatNumber);
    const cleaned = newLayout.filter((row) => row.length > 0);
    setSeatLayout(cleaned);
    try {
      await api.put(`/api/schools/${currentSchoolId}/seat-layout`, { layout: cleaned });
    } catch (err) {
      setError(err.message);
      load();
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

      for (const n of seatNumbers) {
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

  // 上課資訊：列出當日全部有學生、且「尚未排好座位」的課堂，依教師姓名、時間排序；已經排好座位的課堂改到下方「已排座位清單」顯示，這裡就不重複列了
  const daySessions = sessions
    .filter((s) => s.students.length > 0)
    .filter((s) => !findAssignedBlock(s))
    .slice()
    .sort((a, b) => teacherName(a.teacher_id).localeCompare(teacherName(b.teacher_id)) || a.start_slot - b.start_slot);

  // 已排座位清單：跟「上課資訊」相反，只列出已經排好座位的課堂，欄位跟「上課資訊」一致方便對照
  const seatedSessions = sessions
    .filter((s) => s.students.length > 0)
    .map((s) => {
      const found = findAssignedBlock(s);
      return found ? { session: s, block: found.block, assigned: found.seat } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.assigned.seat_number - b.assigned.seat_number);

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>座位系統</h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="single">單時段</option>
            <option value="double">雙時段</option>
          </select>
          {isAdmin && <button onClick={autoAssignSeats}>自動排座位</button>}
          {isAdmin && <button onClick={addSeat}>+ 新增座位</button>}
          {isAdmin && (
            <button onClick={() => setDeleteSeatMode((v) => !v)}>
              {deleteSeatMode ? '結束刪除模式' : '- 刪除座位'}
            </button>
          )}
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
          <table style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', fontSize: 13 }}>
            <ScheduleColGroup />
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '2px solid var(--border-strong)' }}>
                <th style={nowrapCellStyle}>時間</th>
                <th style={nowrapCellStyle}>教師</th>
                <th style={nowrapCellStyle}>科目</th>
                <th style={{ padding: CELL_PADDING }}>學生</th>
              </tr>
            </thead>
            <tbody>
              {daySessions.map((session) => {
                const tooManyStudents = session.students.length > 2;
                const draggableRow = isAdmin && !tooManyStudents;
                return (
                  <tr
                    key={session.id}
                    draggable={draggableRow}
                    onDragStart={() => draggableRow && setDraggedSession(session)}
                    onDragEnd={() => {
                      setDraggedSession(null);
                      setDragOverTarget(null);
                    }}
                    style={{
                      borderBottom: '1px solid var(--border)',
                      cursor: draggableRow ? 'grab' : 'default',
                      opacity: draggedSession?.id === session.id ? 0.5 : 1,
                    }}
                  >
                    <td style={nowrapCellStyle}>{slotRangeLabel(session.start_slot, session.duration_slots)}</td>
                    <td style={nowrapCellStyle}>{teacherName(session.teacher_id)}</td>
                    <td style={nowrapCellStyle}>{session.subject}</td>
                    <StudentCell
                      session={session}
                      expanded={expandedRows.has(session.id)}
                      onToggle={() => toggleRowExpanded(session.id)}
                    />
                  </tr>
                );
              })}
              {daySessions.length === 0 && (
                <tr><td colSpan={4} style={{ color: 'var(--text-muted)', padding: 12 }}>這天沒有課</td></tr>
              )}
            </tbody>
          </table>

          <h3 style={{ margin: '16px 0 6px' }}>已排座位清單</h3>
          <table style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', fontSize: 13 }}>
            <ScheduleColGroup />
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '2px solid var(--border-strong)' }}>
                <th style={nowrapCellStyle}>時間</th>
                <th style={nowrapCellStyle}>教師</th>
                <th style={nowrapCellStyle}>科目</th>
                <th style={{ padding: CELL_PADDING }}>學生</th>
              </tr>
            </thead>
            <tbody>
              {seatedSessions.map(({ session }) => (
                <tr key={session.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={nowrapCellStyle}>{slotRangeLabel(session.start_slot, session.duration_slots)}</td>
                  <td style={nowrapCellStyle}>{teacherName(session.teacher_id)}</td>
                  <td style={nowrapCellStyle}>{session.subject}</td>
                  <StudentCell
                    session={session}
                    expanded={expandedRows.has(session.id)}
                    onToggle={() => toggleRowExpanded(session.id)}
                  />
                </tr>
              ))}
              {seatedSessions.length === 0 && (
                <tr><td colSpan={4} style={{ color: 'var(--text-muted)', padding: 12 }}>尚無已排座位的學生</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {!seatLayout && <p style={{ color: 'var(--text-muted)' }}>載入座位版面中...</p>}
          {seatLayout && seatLayout.map((row, rowIdx) => {
            const slots = [...row, ...Array(Math.max(0, 4 - row.length)).fill(null)];
            return (
              <div key={rowIdx} style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
                {slots.map((n, slotIdx) => {
                  if (n == null) {
                    // 拖到這個空位＝把桌子搬過來這裡；只有空桌才能這樣移動位置，有課堂的桌子拖過來不會有作用
                    const targetKey = `empty-${rowIdx}-${slotIdx}`;
                    const isHovered = dragOverTarget === targetKey;
                    const hoverValid = isHovered && draggedSeat != null && isSeatEmpty(draggedSeat);
                    const hoverInvalid = isHovered && draggedSeat != null && !isSeatEmpty(draggedSeat);
                    return (
                      <div
                        key={targetKey}
                        style={{
                          minHeight: 150,
                          borderRadius: 'var(--radius)',
                          border: hoverInvalid
                            ? '1px dashed var(--danger)'
                            : hoverValid
                            ? '1px dashed var(--accent)'
                            : isAdmin
                            ? '1px dashed var(--border-strong)'
                            : 'none',
                          background: hoverValid ? 'var(--accent-soft)' : undefined,
                          cursor: hoverInvalid ? 'not-allowed' : undefined,
                        }}
                        onDragOver={(e) => isAdmin && e.preventDefault()}
                        onDragEnter={() => isAdmin && setDragOverTarget(targetKey)}
                        onDragLeave={() => setDragOverTarget((k) => (k === targetKey ? null : k))}
                        onDrop={(e) => {
                          e.preventDefault();
                          if (draggedSeat != null && isSeatEmpty(draggedSeat)) {
                            moveSeatToRow(draggedSeat, rowIdx);
                          }
                          setDraggedSeat(null);
                          setDragOverTarget(null);
                        }}
                      />
                    );
                  }
                  return (
                    <div
                      key={n}
                      data-seat={n}
                      className="card"
                      style={{
                        padding: 10,
                        minHeight: 150,
                        opacity: draggedSeat === n ? 0.5 : 1,
                      }}
                      onDragOver={(e) => isAdmin && e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (draggedSession) {
                          assignSeat(draggedSession, n);
                          setDraggedSession(null);
                        } else if (draggedSeat != null) {
                          dropSeatOnSeat(draggedSeat, n);
                        }
                        setDraggedSeat(null);
                        setDragOverTarget(null);
                      }}
                    >
                      <div
                        draggable={isAdmin}
                        onDragStart={() => setDraggedSeat(n)}
                        onDragEnd={() => {
                          setDraggedSeat(null);
                          setDragOverTarget(null);
                        }}
                        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: isAdmin ? 'grab' : 'default' }}
                        title={
                          isAdmin
                            ? isSeatEmpty(n)
                              ? '拖曳可移動桌子位置，或跟其他桌互換課堂資訊'
                              : '此桌已有課堂：拖曳只能跟其他桌互換課堂資訊，無法移動位置'
                            : undefined
                        }
                      >
                        <strong>{n} 號桌</strong>
                        {isAdmin && deleteSeatMode && (
                          <button
                            type="button"
                            title="刪除座位"
                            onClick={() => deleteSeat(n)}
                            style={{
                              width: 22,
                              height: 18,
                              padding: 0,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              background: 'var(--accent-soft)',
                              borderColor: 'var(--accent-soft)',
                              borderRadius: 4,
                            }}
                          >
                            <span style={{ width: 10, height: 2, borderRadius: 1, background: 'var(--accent-hover)' }} />
                          </button>
                        )}
                      </div>
                      {blocks.map((b) => {
                        const seat = (seatsByBlock[b.key] || []).find((s) => s.seat_number === n);
                        const hasAssignment = seat && (seat.teacher_id || seat.students.length > 0);
                        const isDraggingThis = draggedAssignment?.seatNumber === n && draggedAssignment?.blockKey === b.key;
                        const blockCellKey = `${n}:${b.key}`;
                        const namesExpanded = expandedBlocks.has(blockCellKey);
                        const blockTargetKey = `block-${blockCellKey}`;
                        const isBlockHovered = dragOverTarget === blockTargetKey;
                        return (
                          <div
                            key={b.key}
                            draggable={isAdmin}
                            onDragStart={(e) => {
                              e.stopPropagation();
                              setDraggedAssignment({ seatNumber: n, blockKey: b.key });
                            }}
                            onDragEnd={() => {
                              setDraggedAssignment(null);
                              setDragOverTarget(null);
                            }}
                            onDragOver={(e) => {
                              if (!isAdmin) return;
                              e.preventDefault();
                              e.stopPropagation();
                            }}
                            onDragEnter={(e) => {
                              if (!isAdmin) return;
                              e.stopPropagation();
                              setDragOverTarget(blockTargetKey);
                            }}
                            onDragLeave={(e) => {
                              e.stopPropagation();
                              setDragOverTarget((k) => (k === blockTargetKey ? null : k));
                            }}
                            onDrop={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              if (draggedSession) {
                                assignSeatToBlock(draggedSession, n, b.key);
                                setDraggedSession(null);
                              } else if (draggedAssignment) {
                                swapBlockAssignment(draggedAssignment.seatNumber, draggedAssignment.blockKey, n, b.key);
                              } else if (draggedSeat != null) {
                                dropSeatOnSeat(draggedSeat, n);
                              }
                              setDraggedAssignment(null);
                              setDraggedSeat(null);
                              setDragOverTarget(null);
                            }}
                            style={{
                              marginTop: 6,
                              fontSize: 13,
                              minHeight: 42, // 固定最小高度，讓「未安排」跟排好課堂的格子大小一致，指派/清空時不會跳動
                              overflow: 'visible',
                              padding: 4,
                              borderRadius: 4,
                              border: '1px solid var(--border)',
                              cursor: isAdmin ? 'grab' : 'default',
                              opacity: isDraggingThis ? 0.5 : 1,
                              background: isBlockHovered ? 'var(--accent-soft)' : undefined,
                              boxShadow: isDraggingThis ? 'inset 0 0 0 1px var(--accent)' : undefined,
                            }}
                          >
                            {(b.label || (isAdmin && hasAssignment)) && (
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 4 }}>
                                <span style={{ color: 'var(--text-muted)' }}>{b.label}</span>
                                {isAdmin && hasAssignment && (
                                  <button
                                    style={{ fontSize: 11, padding: '2px 6px', flexShrink: 0 }}
                                    onClick={() => clearBlockSeat(n, b)}
                                  >
                                    清空
                                  </button>
                                )}
                              </div>
                            )}
                            {hasAssignment ? (
                              <div style={{ minWidth: 0, display: 'flex', alignItems: 'flex-start', gap: 4, flexWrap: 'wrap' }}>
                                <span style={{ wordBreak: 'break-word' }}>
                                  <strong>{teacherName(seat.teacher_id) || '未安排教師'}</strong>
                                  <span style={{ color: 'var(--text-muted)' }}>
                                    -
                                    {namesExpanded
                                      ? seat.students.map((s) => s.name).join('、') || '未安排學生'
                                      : (seat.students[0]?.name || '未安排學生')}
                                  </span>
                                </span>
                                {seat.students.length > 1 && (
                                  <span
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      toggleBlockExpanded(blockCellKey);
                                    }}
                                    title={namesExpanded ? '收合' : `共 ${seat.students.length} 位學生`}
                                    style={{ flexShrink: 0, fontSize: 9, color: 'var(--text-muted)', cursor: 'pointer' }}
                                  >
                                    {namesExpanded ? '▲' : '▼'}
                                  </span>
                                )}
                              </div>
                            ) : (
                              <div style={{ color: 'var(--text-muted)' }}>未安排</div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
