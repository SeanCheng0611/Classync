import { db } from '../db/index.js';

export function monthRange(month) {
  // month: 'YYYY-MM' -> [第一天, 下個月第一天)
  const [y, m] = month.split('-').map(Number);
  const start = `${month}-01`;
  const nextMonth = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return [start, `${nextMonth}-01`];
}

export function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const total = y * 12 + (m - 1) + delta;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

function gradeBandColumn(grade) {
  if (grade <= 6) return 'rate_grade_1_6';
  if (grade <= 9) return 'rate_grade_7_9';
  return 'rate_grade_10_12';
}

function sessionStudents(sessionId) {
  return db
    .prepare(
      `SELECT s.id, s.name, s.grade, ar.status as attendance_status, ar.makeup_arranged
       FROM session_students ss
       JOIN students s ON s.id = ss.student_id
       LEFT JOIN attendance_records ar ON ar.session_id = ss.session_id AND ar.person_type = 'student' AND ar.person_id = ss.student_id
       WHERE ss.session_id = ?`
    )
    .all(sessionId);
}

// 依課程當下的學生年級分佈，決定該堂課適用哪一段時薪；沒有學生（行政課堂）則用行政時薪
function sessionRateColumn(students) {
  if (students.length === 0) return 'rate_admin';
  const counts = {};
  for (const s of students) {
    const band = gradeBandColumn(s.grade);
    counts[band] = (counts[band] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

// 單一課堂的薪資試算（供 calcTeacherSalary 批次計算，以及薪資條開立時針對個別課堂計算共用）
// fully_on_leave：這堂課的學生全部已請假/調課（等同這堂課實際上沒有上課），此類課堂不應計入薪資條開立清單
export function calcSessionPay(teacher, session) {
  const students = sessionStudents(session.id);
  const hours = session.duration_slots / 2;
  const rateColumn = sessionRateColumn(students);
  const rate = teacher[rateColumn];
  const pay = hours * rate;
  const fullyOnLeave = students.length > 0 && students.every((s) => s.attendance_status === 'leave');
  const leaveIsMakeup = fullyOnLeave && students.some((s) => s.makeup_arranged);
  const origin =
    session.type === 'makeup' && session.origin_session_id
      ? db.prepare('SELECT session_date, start_slot FROM class_sessions WHERE id = ?').get(session.origin_session_id)
      : null;
  return {
    session_id: session.id,
    session_date: session.session_date,
    subject: session.subject,
    type: session.type,
    is_admin: students.length === 0,
    student_names: students.map((s) => s.name),
    start_slot: session.start_slot,
    hours,
    rate_type: rateColumn,
    rate,
    pay,
    fully_on_leave: fullyOnLeave,
    leave_is_makeup: leaveIsMakeup,
    origin_session_date: origin?.session_date || null,
    origin_start_slot: origin?.start_slot ?? null,
  };
}

// 教師薪資直接依排課／調課／加課（含無學生的行政課堂）計算，不再依賴教師出缺勤點名
export function calcTeacherSalary(schoolId, teacherId, startDate, endDateExclusive) {
  const teacher = db.prepare('SELECT * FROM teachers WHERE id = ? AND school_id = ?').get(teacherId, schoolId);
  if (!teacher) return { total: 0, items: [] };

  const sessions = db
    .prepare(
      `SELECT * FROM class_sessions WHERE school_id = ? AND teacher_id = ? AND session_date >= ? AND session_date < ? AND cancelled = 0
       ORDER BY session_date, start_slot`
    )
    .all(schoolId, teacherId, startDate, endDateExclusive);

  const items = sessions.map((session) => calcSessionPay(teacher, session));
  const total = items.reduce((sum, i) => sum + i.pay, 0);
  return { total, items, teacher_name: teacher.name };
}

export function calcAllTeachersSalary(schoolId, startDate, endDateExclusive) {
  const teachers = db.prepare('SELECT * FROM teachers WHERE school_id = ?').all(schoolId);
  return teachers.map((t) => ({
    teacher_id: t.id,
    teacher_name: t.name,
    ...calcTeacherSalary(schoolId, t.id, startDate, endDateExclusive),
  }));
}

// 計算某學生在區間內應繳金額：只算「確定出席」的課堂（regular/makeup/extra 皆算，行政課堂沒有學生不會出現），
// 加總其單堂價錢；固定課堂新增當下不會立刻計入，要點名確定出席才算。
// 若區間內完全沒有已出席的計價課堂，退回使用學生的次繳費金額（單價）估算。
export function calcStudentTuition(schoolId, studentId, startDate, endDateExclusive) {
  const student = db.prepare('SELECT * FROM students WHERE id = ? AND school_id = ?').get(studentId, schoolId);
  if (!student) return { total: 0, items: [], estimated: false, suggested_unit_price: 0 };

  const items = db
    .prepare(
      `SELECT cs.id as session_id, cs.session_date, cs.subject, ss.unit_price
       FROM session_students ss
       JOIN class_sessions cs ON cs.id = ss.session_id
       JOIN attendance_records ar ON ar.session_id = cs.id AND ar.person_type = 'student' AND ar.person_id = ss.student_id
       WHERE cs.school_id = ? AND ss.student_id = ? AND cs.session_date >= ? AND cs.session_date < ?
         AND cs.cancelled = 0 AND ar.status = 'present'
       ORDER BY cs.session_date, cs.start_slot`
    )
    .all(schoolId, studentId, startDate, endDateExclusive);

  const priced = items.filter((i) => i.unit_price > 0);
  if (priced.length > 0) {
    const total = priced.reduce((sum, i) => sum + i.unit_price, 0);
    // 建議單價：這些已出席課堂中最常見的單堂價錢，供表單預設用
    const counts = {};
    for (const i of priced) counts[i.unit_price] = (counts[i.unit_price] || 0) + 1;
    const suggestedUnitPrice = Number(Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]);
    return {
      total,
      items: priced,
      estimated: false,
      student_name: student.name,
      suggested_session_count: priced.length,
      suggested_unit_price: suggestedUnitPrice,
    };
  }

  return {
    total: student.tuition_monthly || 0,
    items: [],
    estimated: true,
    student_name: student.name,
    suggested_session_count: 0,
    suggested_unit_price: 0,
  };
}

// 往回找「最近一筆有存檔的月結紀錄」，取得其未收餘額；中間沒有存檔的月份一律視為已收（沿用系統預設），
// 不會憑空幫沒存檔的月份估算新的欠款，只延續已證實（已存檔）的未收金額，避免漏存月份導致舊欠款消失或被灌水。
function findNearestUnpaidRollover(schoolId, studentId, month, depth) {
  if (depth >= 24) return { amount: 0, gapFound: true };
  const record = db.prepare('SELECT * FROM tuition_records WHERE student_id = ? AND month = ?').get(studentId, month);
  if (record) {
    const amount = record.rollover && record.actual_amount < record.expected_amount
      ? record.expected_amount - record.actual_amount
      : 0;
    return { amount, gapFound: false };
  }
  const result = findNearestUnpaidRollover(schoolId, studentId, shiftMonth(month, -1), depth + 1);
  return { amount: result.amount, gapFound: true };
}

// 某學生某月「應收金額」= 當月排課加總 + 上個月若設定併入次月且未收齊的餘額。
// 若上個月沒有存檔紀錄（可能忘記儲存），往回找最近一筆有存檔的未收餘額繼續併入；
// rollover_unsaved 標記併入金額並非直接來自上個月的存檔資料（中間有漏存的月份），提醒管理者確認補存。
export function calcStudentTuitionForMonth(schoolId, studentId, month) {
  const [start, end] = monthRange(month);
  const base = calcStudentTuition(schoolId, studentId, start, end);

  const prevMonth = shiftMonth(month, -1);
  const { amount: rolloverAmount, gapFound } = findNearestUnpaidRollover(schoolId, studentId, prevMonth, 0);

  return {
    ...base,
    expected_amount: base.total + rolloverAmount,
    rollover_amount: rolloverAmount,
    rollover_unsaved: gapFound && rolloverAmount > 0,
  };
}
