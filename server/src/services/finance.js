import { nanoid } from 'nanoid';
import { financeRepository, teachersRepository, studentsRepository, schedulingRepository, runInTransaction } from '../repositories/index.js';
import { insertTrashRow, captureInvoice, capturePayslip } from './trash.js';

// 業務錯誤（缺欄位/找不到/重複開立）用這個攜帶 HTTP status，route 抓到後照原本的狀態碼回應，
// 不會因為改成 Service + transaction 架構就把這些「預期內的業務錯誤」全部變成 500。
export class FinanceError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- Wave 3B：Invoice / Payslip 的 create / delete，transaction ownership 在這一層 ----------
//
// Route 只負責：HTTP request -> 呼叫這裡 -> 把 FinanceError 轉回原本的 status code。
// Repository 只提供細粒度的單一 SQL 操作，不知道「一次開立繳費單」這個完整流程長怎樣。
// 這裡負責組合驗證 + runInTransaction 內的多筆寫入，確保 all-or-nothing。

// Wave 4：createInvoice/createPayslip 在寫入前已經先 SELECT 過一次「這堂課是否已開立過」，
// 但兩個請求同時通過這個檢查、同時進 transaction 的極窄 race window 理論上仍存在——這種情況下
// 真正擋下重複計費的是 invoice_items.session_id / payslip_items.session_id 的 UNIQUE constraint，
// SQLite 會讓第二個 transaction 的 INSERT 失敗並完整 rollback（不會留下孤兒 invoice/payslip，
// Wave 3B 已保證），但這個錯誤原本會被當成未知例外往外拋、變成 500。這裡只精確辨識這一種已知情境
// （node:sqlite 的 UNIQUE constraint 錯誤、且欄位剛好是這兩個已知的重複計費防線），轉成跟先檢查
// 路徑一樣的 409；其他任何錯誤（外鍵錯誤、磁碟錯誤、語法錯誤、未知錯誤）維持原樣往外拋，
// 不做「catch 全部 DB error 都當 409」這種事。
function isDuplicateSessionConstraint(err, column) {
  return err?.code === 'ERR_SQLITE_ERROR' && typeof err.message === 'string' && err.message.includes(`UNIQUE constraint failed: ${column}`);
}

export function createInvoice(schoolId, { studentId, sessionIds, note }) {
  if (!studentId || !Array.isArray(sessionIds) || sessionIds.length === 0) {
    throw new FinanceError(400, 'student_id and session_ids required');
  }

  const student = studentsRepository.findById(schoolId, studentId);
  if (!student) throw new FinanceError(404, 'student not found');

  const items = [];
  for (const sessionId of sessionIds) {
    const row = financeRepository.findInvoiceableSessionRow(schoolId, studentId, sessionId);
    if (!row) throw new FinanceError(400, `課堂不存在或不屬於此學生（${sessionId}）`);
    if (financeRepository.hasInvoiceItemForSession(sessionId)) {
      throw new FinanceError(409, `${row.session_date} ${row.subject} 已開立過繳費單，無法重複開立`);
    }
    items.push(row);
  }

  const total = items.reduce((sum, i) => sum + i.unit_price, 0);
  const invoiceId = nanoid();

  try {
    runInTransaction(() => {
      financeRepository.insertInvoice({ id: invoiceId, schoolId, studentId, totalAmount: total, note: note || null });
      financeRepository.insertInvoiceItems(
        invoiceId,
        items.map((i) => ({ id: nanoid(), sessionId: i.id, unitPrice: i.unit_price }))
      );
    });
  } catch (err) {
    if (isDuplicateSessionConstraint(err, 'invoice_items.session_id')) {
      throw new FinanceError(409, '課堂已被搶先開立過繳費單，無法重複開立');
    }
    throw err;
  }

  return { invoiceId, itemCount: items.length, total, studentName: student.name };
}

export function deleteInvoice(schoolId, invoiceId, userId) {
  const invoice = financeRepository.findInvoiceById(schoolId, invoiceId);
  if (!invoice) throw new FinanceError(404, 'not found');

  const student = studentsRepository.findById(schoolId, invoice.student_id);
  const label = `${student?.name || '未知學生'} ${invoice.issued_date} 繳費單`;
  const snapshot = captureInvoice(invoiceId);

  runInTransaction(() => {
    insertTrashRow(schoolId, 'invoice', label, snapshot, userId, { studentIds: [invoice.student_id] });
    financeRepository.deleteInvoiceLedgerEntries(invoiceId);
    financeRepository.deleteInvoiceRow(schoolId, invoiceId);
  });

  return { label };
}

export function createPayslip(schoolId, { teacherId, sessionIds, note }) {
  if (!teacherId || !Array.isArray(sessionIds) || sessionIds.length === 0) {
    throw new FinanceError(400, 'teacher_id and session_ids required');
  }

  const teacher = teachersRepository.findById(schoolId, teacherId);
  if (!teacher) throw new FinanceError(404, 'teacher not found');

  const today = financeRepository.today();

  const items = [];
  for (const sessionId of sessionIds) {
    const session = financeRepository.findPayslipableSessionRow(schoolId, teacherId, sessionId);
    if (!session) throw new FinanceError(400, `課堂不存在或不屬於此教師（${sessionId}）`);
    if (financeRepository.hasPayslipItemForSession(sessionId)) {
      throw new FinanceError(409, `${session.session_date} ${session.subject} 已開立過薪資條，無法重複開立`);
    }
    if (session.session_date > today) {
      throw new FinanceError(400, `${session.session_date} ${session.subject} 尚未發生，無法開立薪資`);
    }
    const item = calcSessionPay(teacher, session);
    if (item.fully_on_leave) {
      const label = item.leave_is_makeup ? '已調課' : '已請假';
      throw new FinanceError(400, `${session.session_date} ${session.subject}（${label}）無法計入薪資`);
    }
    if (item.not_yet_marked) {
      throw new FinanceError(400, `${session.session_date} ${session.subject} 尚未點名，無法開立薪資`);
    }
    items.push(item);
  }

  const total = items.reduce((sum, i) => sum + i.pay, 0);
  const payslipId = nanoid();

  try {
    runInTransaction(() => {
      financeRepository.insertPayslip({ id: payslipId, schoolId, teacherId, totalAmount: Math.round(total), note: note || null });
      financeRepository.insertPayslipItems(
        payslipId,
        items.map((i) => ({ id: nanoid(), sessionId: i.session_id, hours: i.hours, rate: i.rate, pay: Math.round(i.pay) }))
      );
    });
  } catch (err) {
    if (isDuplicateSessionConstraint(err, 'payslip_items.session_id')) {
      throw new FinanceError(409, '課堂已被搶先開立過薪資條，無法重複開立');
    }
    throw err;
  }

  return { payslipId, itemCount: items.length, teacherName: teacher.name };
}

export function deletePayslip(schoolId, payslipId, userId) {
  const payslip = financeRepository.findPayslipById(schoolId, payslipId);
  if (!payslip) throw new FinanceError(404, 'not found');

  const teacher = teachersRepository.findById(schoolId, payslip.teacher_id);
  const label = `${teacher?.name || '未知教師'} ${payslip.issued_date} 薪資條`;
  const snapshot = capturePayslip(payslipId);

  runInTransaction(() => {
    insertTrashRow(schoolId, 'payslip', label, snapshot, userId, { teacherId: payslip.teacher_id });
    financeRepository.deletePayslipLedgerEntries(payslipId);
    financeRepository.deletePayslipRow(schoolId, payslipId);
  });

  return { label };
}

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
  const students = financeRepository.findSessionStudentsWithAttendance(session.id);
  const hours = session.duration_slots / 2;
  const rateColumn = sessionRateColumn(students);
  const rate = session.rate_override ?? teacher[rateColumn];
  const pay = hours * rate;
  const fullyOnLeave = students.length > 0 && students.every((s) => s.attendance_status === 'leave');
  const leaveIsMakeup = fullyOnLeave && students.some((s) => s.makeup_arranged);
  // 尚未點名：這堂課有學生，但至少一位還沒有出缺勤紀錄（attendance_status 為空）；開薪資條前應該先點名確認課堂確實發生過
  const notYetMarked = students.length > 0 && students.some((s) => !s.attendance_status);
  const origin =
    session.type === 'makeup' && session.origin_session_id ? schedulingRepository.findSessionByIdAny(session.origin_session_id) : null;
  return {
    session_id: session.id,
    session_date: session.session_date,
    subject: session.subject,
    type: session.type,
    is_admin: students.length === 0,
    student_names: students.map((s) => s.name),
    start_slot: session.start_slot,
    duration_slots: session.duration_slots,
    hours,
    rate_type: rateColumn,
    rate,
    pay,
    fully_on_leave: fullyOnLeave,
    leave_is_makeup: leaveIsMakeup,
    not_yet_marked: notYetMarked,
    origin_session_date: origin?.session_date || null,
    origin_start_slot: origin?.start_slot ?? null,
  };
}

// 教師薪資直接依排課／調課／加課（含無學生的行政課堂）計算，不再依賴教師出缺勤點名
export function calcTeacherSalary(schoolId, teacherId, startDate, endDateExclusive) {
  const teacher = teachersRepository.findById(schoolId, teacherId);
  if (!teacher) return { total: 0, items: [] };

  const sessions = schedulingRepository.findSessionsByTeacherAndDateRange(schoolId, teacherId, startDate, endDateExclusive);

  const items = sessions.map((session) => calcSessionPay(teacher, session));
  const total = items.reduce((sum, i) => sum + i.pay, 0);
  return { total, items, teacher_name: teacher.name };
}

export function calcAllTeachersSalary(schoolId, startDate, endDateExclusive) {
  const teachers = teachersRepository.findAllBySchool(schoolId);
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
  const student = studentsRepository.findById(schoolId, studentId);
  if (!student) return { total: 0, items: [], estimated: false, suggested_unit_price: 0 };

  const items = financeRepository.findBillableAttendedSessions(schoolId, studentId, startDate, endDateExclusive);

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
  const record = financeRepository.findTuitionRecord(studentId, month);
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
