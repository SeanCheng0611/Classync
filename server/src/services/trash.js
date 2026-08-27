import { nanoid } from 'nanoid';
import { db, runInTransaction } from '../db/index.js';
import { broadcastChange } from '../realtime/index.js';

const RETENTION_DAYS = 14;

function selectAll(table, whereCol, whereVal) {
  return db.prepare(`SELECT * FROM ${table} WHERE ${whereCol} = ?`).all(whereVal);
}

function insertRow(table, row) {
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(
    ...cols.map((c) => row[c])
  );
}

// snapshot 是依「還原順序」（父表先於子表）排列的 [{ table, rows }]，整批寫回包在同一個 transaction 裡
function insertSnapshot(snapshot) {
  runInTransaction(() => {
    for (const { table, rows } of snapshot.tables) {
      for (const row of rows) insertRow(table, row);
    }
  });
}

// ---------- 各實體的擷取（刪除前呼叫，把該筆資料與所有會被 CASCADE / 應用層連帶刪除的子資料收集起來）----------

export function captureNote(noteId) {
  const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId);
  return { tables: [{ table: 'notes', rows: [note] }] };
}

export function captureTeacher(teacherId) {
  const teacher = db.prepare('SELECT * FROM teachers WHERE id = ?').get(teacherId);
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
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(studentId);
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
  const session = db.prepare('SELECT * FROM class_sessions WHERE id = ?').get(sessionId);
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
  const entry = db.prepare('SELECT * FROM ledger_entries WHERE id = ?').get(entryId);
  return { tables: [{ table: 'ledger_entries', rows: [entry] }] };
}

// 刪除薪資條會一併刪除對應的收支明細（應用層連帶刪除，非 FK CASCADE）
export function capturePayslip(payslipId) {
  const payslip = db.prepare('SELECT * FROM payslips WHERE id = ?').get(payslipId);
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
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
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
  const membership = db.prepare('SELECT * FROM memberships WHERE id = ?').get(membershipId);
  return { tables: [{ table: 'memberships', rows: [membership] }] };
}

export function captureInviteCode(inviteCodeId) {
  const inviteCode = db.prepare('SELECT * FROM invite_codes WHERE id = ?').get(inviteCodeId);
  return { tables: [{ table: 'invite_codes', rows: [inviteCode] }] };
}

// 整堂固定課停開：template 本身 + template_students，另外記下這次連帶被取消（cancelled 0→1）的未來課堂 id，
// 讓復原時一併把這些課堂的 cancelled 改回 0、template_id 接回來
export function captureScheduleTemplate(templateId, cancelledSessionIds) {
  const template = db.prepare('SELECT * FROM schedule_templates WHERE id = ?').get(templateId);
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

const RESTORE_HANDLERS = {
  // 固定課單日軟刪除：資料列本來就還在，只是 cancelled=1，復原只需要改回 0
  session_cancelled: (payload) => {
    db.prepare('UPDATE class_sessions SET cancelled = 0 WHERE id = ?').run(payload.sessionId);
  },
  schedule_template: (payload) => {
    insertSnapshot(payload);
    const restoreCancelled = db.prepare('UPDATE class_sessions SET cancelled = 0, template_id = ? WHERE id = ?');
    for (const sessionId of payload.cancelledSessionIds || []) restoreCancelled.run(payload.templateId, sessionId);
  },
};

export function restoreEntity(entityType, payload) {
  const handler = RESTORE_HANDLERS[entityType] || insertSnapshot;
  handler(payload);
}

// ---------- 回收桶本體：新增 / 清理過期 ----------

// related：{ studentIds?: string[], teacherId?: string }，讓學生/教師詳細頁的回收桶可以篩出「跟這個人有關」的項目
// 純寫入，不 broadcast——給需要把「存進回收桶」納入自己的 transaction 的呼叫端用
// （例如 Wave 3B 的 invoice/payslip 刪除），避免 transaction 中途 rollback 時，
// broadcast 已經先發出去、通知前端「東西被刪了」但其實整個操作被回滾、資料還在的不一致。
// 一般情境（沒有跨 repository transaction 需求）請直接用下面的 addToTrash。
export function insertTrashRow(schoolId, entityType, label, payload, userId, related = {}) {
  const id = nanoid();
  db.prepare(
    `INSERT INTO trash (id, school_id, entity_type, label, payload, related_student_ids, related_teacher_id, deleted_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    schoolId,
    entityType,
    label,
    JSON.stringify(payload),
    JSON.stringify(related.studentIds || []),
    related.teacherId || null,
    userId || null
  );
  return id;
}

export function addToTrash(schoolId, entityType, label, payload, userId, related = {}) {
  const id = insertTrashRow(schoolId, entityType, label, payload, userId, related);
  broadcastChange(schoolId, 'trash');
  return id;
}

export function purgeExpiredTrash() {
  db.prepare(`DELETE FROM trash WHERE deleted_at < datetime('now', '-${RETENTION_DAYS} days')`).run();
}

export function startTrashPurgeScheduler() {
  purgeExpiredTrash();
  setInterval(purgeExpiredTrash, 60 * 60 * 1000).unref();
}
