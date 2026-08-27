import { nanoid } from 'nanoid';
import { trashRepository, runInTransaction } from '../repositories/index.js';
import { broadcastChange } from '../realtime/index.js';

const RETENTION_DAYS = 14;

function selectAll(table, whereCol, whereVal) {
  return trashRepository.findRowsByColumn(table, whereCol, whereVal);
}

// snapshot 是依「還原順序」（父表先於子表）排列的 [{ table, rows }]；不自帶 transaction——
// 呼叫端（restoreTrashEntry）已經把整個「還原 + 刪掉 trash 這一列」包在同一個 transaction 裡，
// 這裡如果自己再 BEGIN 會變成 nested transaction（node:sqlite 不支援）
function insertSnapshot(snapshot) {
  for (const { table, rows } of snapshot.tables) {
    for (const row of rows) trashRepository.insertRow(table, row);
  }
}

// ---------- 各實體的擷取（刪除前呼叫，把該筆資料與所有會被 CASCADE / 應用層連帶刪除的子資料收集起來）----------

export function captureNote(noteId) {
  const note = trashRepository.findRowById('notes', noteId);
  return { tables: [{ table: 'notes', rows: [note] }] };
}

export function captureTeacher(teacherId) {
  const teacher = trashRepository.findRowById('teachers', teacherId);
  const scheduleTemplates = selectAll('schedule_templates', 'teacher_id', teacherId);
  const classSessions = selectAll('class_sessions', 'teacher_id', teacherId);
  const payslips = selectAll('payslips', 'teacher_id', teacherId);
  const inviteCodes = selectAll('invite_codes', 'teacher_id', teacherId);

  const templateStudents = scheduleTemplates.flatMap((t) => selectAll('template_students', 'template_id', t.id));
  const sessionStudents = classSessions.flatMap((s) => selectAll('session_students', 'session_id', s.id));
  const attendanceRecords = classSessions.flatMap((s) => selectAll('attendance_records', 'session_id', s.id));
  const invoiceItems = classSessions.flatMap((s) => selectAll('invoice_items', 'session_id', s.id));
  const payslipItems = payslips.flatMap((p) => selectAll('payslip_items', 'payslip_id', p.id));

  return {
    tables: [
      { table: 'teachers', rows: [teacher] },
      { table: 'schedule_templates', rows: scheduleTemplates },
      { table: 'class_sessions', rows: classSessions },
      { table: 'payslips', rows: payslips },
      { table: 'template_students', rows: templateStudents },
      { table: 'session_students', rows: sessionStudents },
      { table: 'attendance_records', rows: attendanceRecords },
      { table: 'invoice_items', rows: invoiceItems },
      { table: 'payslip_items', rows: payslipItems },
      { table: 'invite_codes', rows: inviteCodes },
    ],
  };
}

export function captureStudent(studentId) {
  const student = trashRepository.findRowById('students', studentId);
  const invoices = selectAll('invoices', 'student_id', studentId);
  const templateStudents = selectAll('template_students', 'student_id', studentId);
  const sessionStudents = selectAll('session_students', 'student_id', studentId);
  const seatStudents = selectAll('seat_students', 'student_id', studentId);
  const tuitionRecords = selectAll('tuition_records', 'student_id', studentId);
  const invoiceItems = invoices.flatMap((inv) => selectAll('invoice_items', 'invoice_id', inv.id));

  return {
    tables: [
      { table: 'students', rows: [student] },
      { table: 'invoices', rows: invoices },
      { table: 'template_students', rows: templateStudents },
      { table: 'session_students', rows: sessionStudents },
      { table: 'seat_students', rows: seatStudents },
      { table: 'tuition_records', rows: tuitionRecords },
      { table: 'invoice_items', rows: invoiceItems },
    ],
  };
}

// 單堂課硬刪除（extra / makeup）
export function captureSession(sessionId) {
  const session = trashRepository.findRowById('class_sessions', sessionId);
  const sessionStudents = selectAll('session_students', 'session_id', sessionId);
  const attendanceRecords = selectAll('attendance_records', 'session_id', sessionId);
  const invoiceItems = selectAll('invoice_items', 'session_id', sessionId);
  const payslipItems = selectAll('payslip_items', 'session_id', sessionId);

  return {
    tables: [
      { table: 'class_sessions', rows: [session] },
      { table: 'session_students', rows: sessionStudents },
      { table: 'attendance_records', rows: attendanceRecords },
      { table: 'invoice_items', rows: invoiceItems },
      { table: 'payslip_items', rows: payslipItems },
    ],
  };
}

export function captureLedgerEntry(entryId) {
  const entry = trashRepository.findRowById('ledger_entries', entryId);
  return { tables: [{ table: 'ledger_entries', rows: [entry] }] };
}

// 刪除薪資條會一併刪除對應的收支明細（應用層連帶刪除，非 FK CASCADE）
export function capturePayslip(payslipId) {
  const payslip = trashRepository.findRowById('payslips', payslipId);
  const payslipItems = selectAll('payslip_items', 'payslip_id', payslipId);
  const ledgerEntries = selectAll('ledger_entries', 'related_payslip_id', payslipId);
  return {
    tables: [
      { table: 'payslips', rows: [payslip] },
      { table: 'payslip_items', rows: payslipItems },
      { table: 'ledger_entries', rows: ledgerEntries },
    ],
  };
}

// 刪除繳費單會一併刪除對應的收支明細（應用層連帶刪除，非 FK CASCADE）
export function captureInvoice(invoiceId) {
  const invoice = trashRepository.findRowById('invoices', invoiceId);
  const invoiceItems = selectAll('invoice_items', 'invoice_id', invoiceId);
  const ledgerEntries = selectAll('ledger_entries', 'related_invoice_id', invoiceId);
  return {
    tables: [
      { table: 'invoices', rows: [invoice] },
      { table: 'invoice_items', rows: invoiceItems },
      { table: 'ledger_entries', rows: ledgerEntries },
    ],
  };
}

export function captureMembership(membershipId) {
  const membership = trashRepository.findRowById('memberships', membershipId);
  return { tables: [{ table: 'memberships', rows: [membership] }] };
}

export function captureInviteCode(inviteCodeId) {
  const inviteCode = trashRepository.findRowById('invite_codes', inviteCodeId);
  return { tables: [{ table: 'invite_codes', rows: [inviteCode] }] };
}

// 整堂固定課停開：template 本身 + template_students，另外記下這次連帶被取消（cancelled 0→1）的未來課堂 id，
// 讓復原時一併把這些課堂的 cancelled 改回 0、template_id 接回來
export function captureScheduleTemplate(templateId, cancelledSessionIds) {
  const template = trashRepository.findRowById('schedule_templates', templateId);
  const templateStudents = selectAll('template_students', 'template_id', templateId);
  return {
    templateId,
    cancelledSessionIds,
    tables: [
      { table: 'schedule_templates', rows: [template] },
      { table: 'template_students', rows: templateStudents },
    ],
  };
}

// ---------- 還原 ----------
//
// 每個 handler 都「不」自帶 transaction——transaction ownership 屬於下面的 restoreTrashEntry，
// 還原（不論哪個 entity type）與刪掉對應的 trash 那一列，必須是同一個 all-or-nothing 操作，
// 否則會出現「資料已經還原、但 trash 列還在」或「trash 列被刪了、但還原寫到一半失敗」的不一致。

const RESTORE_HANDLERS = {
  // 固定課單日軟刪除：資料列本來就還在，只是 cancelled=1，復原只需要改回 0
  session_cancelled: (payload) => {
    trashRepository.updateSessionCancelled(payload.sessionId, false);
  },
  schedule_template: (payload) => {
    insertSnapshot(payload);
    for (const sessionId of payload.cancelledSessionIds || []) {
      trashRepository.reattachCancelledSession(payload.templateId, sessionId);
    }
  },
};

export function restoreEntity(entityType, payload) {
  const handler = RESTORE_HANDLERS[entityType] || insertSnapshot;
  handler(payload);
}

// 讀取 trash 列 → 依 entity_type 還原 → 刪掉這一列 trash，全部在同一個 transaction 內完成；
// 任何一步失敗（例如關聯資料已不存在、UNIQUE 衝突）整個復原動作都會回滾，不會留下部分還原的狀態。
// 回傳 null 代表這筆 trash 不存在（給 route 轉 404）；還原失敗會直接把例外往外拋，給 route 轉 409。
export function restoreTrashEntry(schoolId, trashId) {
  const row = trashRepository.findById(schoolId, trashId);
  if (!row) return null;

  runInTransaction(() => {
    restoreEntity(row.entity_type, JSON.parse(row.payload));
    trashRepository.deleteById(trashId);
  });

  return row;
}

// ---------- 回收桶本體：新增 / 清理過期 ----------

// related：{ studentIds?: string[], teacherId?: string }，讓學生/教師詳細頁的回收桶可以篩出「跟這個人有關」的項目
// 純寫入，不 broadcast——給需要把「存進回收桶」納入自己的 transaction 的呼叫端用
// （例如 Wave 3B 的 invoice/payslip 刪除），避免 transaction 中途 rollback 時，
// broadcast 已經先發出去、通知前端「東西被刪了」但其實整個操作被回滾、資料還在的不一致。
// 一般情境（沒有跨 repository transaction 需求）請直接用下面的 addToTrash。
export function insertTrashRow(schoolId, entityType, label, payload, userId, related = {}) {
  const id = nanoid();
  trashRepository.insert({
    id,
    schoolId,
    entityType,
    label,
    payloadJson: JSON.stringify(payload),
    relatedStudentIdsJson: JSON.stringify(related.studentIds || []),
    relatedTeacherId: related.teacherId || null,
    deletedBy: userId || null,
  });
  return id;
}

export function addToTrash(schoolId, entityType, label, payload, userId, related = {}) {
  const id = insertTrashRow(schoolId, entityType, label, payload, userId, related);
  broadcastChange(schoolId, 'trash');
  return id;
}

export function purgeExpiredTrash() {
  trashRepository.deleteExpired(RETENTION_DAYS);
}

export function startTrashPurgeScheduler() {
  purgeExpiredTrash();
  setInterval(purgeExpiredTrash, 60 * 60 * 1000).unref();
}
