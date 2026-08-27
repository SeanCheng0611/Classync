import { db } from '../db/index.js';

// invoices/invoice_items、payslips/payslip_items、ledger_entries、tuition_records 高度耦合
// （收支明細會反查繳費單/薪資條明細，繳費單/薪資條又反查課堂），集中在同一個 repository，
// 跟 Wave 2 的 scheduling.repository.js 是同樣的理由，不強行拆開。
//
// Wave 3A 範圍：讀取查詢 + 低風險單表 CRUD（ledger_entries、tuition_records）。
// Wave 3B 補上「建立/刪除繳費單＋明細」「建立/刪除薪資條＋明細」的細粒度 persistence 方法
// （insertInvoice/insertInvoiceItems/deleteInvoiceLedgerEntries/deleteInvoiceRow 等）——
// 這些方法本身「不」自帶 transaction（不像 Wave 2 的 scheduling.repository 有幾個方法會自己
// runInTransaction），因為這幾個 use case 的 transaction 需要橫跨 financeRepository 之外的
// trash 寫入（`services/trash.js` 的 `insertTrashRow`），transaction ownership 因此上移到
// services/finance.js，由 service 組合呼叫多個「不自帶 transaction」的細粒度方法，見
// docs/REPOSITORY_ARCHITECTURE.md 的 Finance Transaction Boundary 段落。
export const financeRepository = {
  // ---- invoices / invoice_items（write，Wave 3B）----

  insertInvoice({ id, schoolId, studentId, totalAmount, note }) {
    db.prepare(`INSERT INTO invoices (id, school_id, student_id, total_amount, note) VALUES (?, ?, ?, ?, ?)`).run(
      id,
      schoolId,
      studentId,
      totalAmount,
      note ?? null
    );
  },

  insertInvoiceItems(invoiceId, items) {
    const insert = db.prepare('INSERT INTO invoice_items (id, invoice_id, session_id, unit_price) VALUES (?, ?, ?, ?)');
    for (const item of items) insert.run(item.id, invoiceId, item.sessionId, item.unitPrice);
  },

  deleteInvoiceLedgerEntries(invoiceId) {
    db.prepare('DELETE FROM ledger_entries WHERE related_invoice_id = ?').run(invoiceId);
  },

  // invoice_items 靠 schema 的 ON DELETE CASCADE 外鍵自動清除，不需要應用層額外 DELETE
  deleteInvoiceRow(schoolId, id) {
    db.prepare('DELETE FROM invoices WHERE id = ? AND school_id = ?').run(id, schoolId);
  },

  // ---- payslips / payslip_items（write，Wave 3B）----

  insertPayslip({ id, schoolId, teacherId, totalAmount, note }) {
    db.prepare(`INSERT INTO payslips (id, school_id, teacher_id, total_amount, note) VALUES (?, ?, ?, ?, ?)`).run(
      id,
      schoolId,
      teacherId,
      totalAmount,
      note ?? null
    );
  },

  insertPayslipItems(payslipId, items) {
    const insert = db.prepare('INSERT INTO payslip_items (id, payslip_id, session_id, hours, rate, pay) VALUES (?, ?, ?, ?, ?, ?)');
    for (const item of items) insert.run(item.id, payslipId, item.sessionId, item.hours, item.rate, item.pay);
  },

  deletePayslipLedgerEntries(payslipId) {
    db.prepare('DELETE FROM ledger_entries WHERE related_payslip_id = ?').run(payslipId);
  },

  // payslip_items 靠 schema 的 ON DELETE CASCADE 外鍵自動清除，不需要應用層額外 DELETE
  deletePayslipRow(schoolId, id) {
    db.prepare('DELETE FROM payslips WHERE id = ? AND school_id = ?').run(id, schoolId);
  },
  // ---- ledger_entries ----

  findLedgerEntries(schoolId, { start, end, category } = {}) {
    let sql = 'SELECT * FROM ledger_entries WHERE school_id = ?';
    const params = [schoolId];
    if (start) { sql += ' AND entry_date >= ?'; params.push(start); }
    if (end) { sql += ' AND entry_date < ?'; params.push(end); }
    if (category) { sql += ' AND category = ?'; params.push(category); }
    sql += ' ORDER BY entry_date DESC, created_at DESC';
    return db.prepare(sql).all(...params);
  },

  // 依 entry_type + category 分組加總，summary 計算（income/expense/net）留在 route/service 做
  findLedgerSummaryRows(schoolId, start, end) {
    return db
      .prepare(
        `SELECT entry_type, category, SUM(amount) as total FROM ledger_entries
         WHERE school_id = ? AND entry_date >= ? AND entry_date < ?
         GROUP BY entry_type, category`
      )
      .all(schoolId, start, end);
  },

  findLedgerEntryById(schoolId, id) {
    return db.prepare('SELECT * FROM ledger_entries WHERE id = ? AND school_id = ?').get(id, schoolId);
  },

  findLedgerEntryByPayslip(schoolId, payslipId) {
    return db.prepare(`SELECT id FROM ledger_entries WHERE school_id = ? AND category = 'salary' AND related_payslip_id = ?`).get(schoolId, payslipId);
  },

  findLedgerEntryByInvoice(schoolId, invoiceId) {
    return db.prepare(`SELECT id FROM ledger_entries WHERE school_id = ? AND category = 'tuition' AND related_invoice_id = ?`).get(schoolId, invoiceId);
  },

  createLedgerEntry({ id, schoolId, entryType, category, amount, entryDate, relatedStudentId, relatedTeacherId, relatedInvoiceId, relatedPayslipId, note }) {
    db.prepare(
      `INSERT INTO ledger_entries (id, school_id, entry_type, category, amount, entry_date, related_student_id, related_teacher_id, related_invoice_id, related_payslip_id, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, schoolId, entryType, category, amount, entryDate, relatedStudentId ?? null, relatedTeacherId ?? null, relatedInvoiceId ?? null, relatedPayslipId ?? null, note ?? null);
  },

  updateLedgerEntryAmountNote(id, { amount, note }) {
    db.prepare('UPDATE ledger_entries SET amount = ?, note = ? WHERE id = ?').run(amount, note, id);
  },

  updateLedgerEntryFields(id, { amount, entryDate, note }) {
    db.prepare('UPDATE ledger_entries SET amount = ?, entry_date = ?, note = ? WHERE id = ?').run(amount, entryDate, note, id);
  },

  deleteLedgerEntry(schoolId, id) {
    db.prepare('DELETE FROM ledger_entries WHERE id = ? AND school_id = ?').run(id, schoolId);
  },

  // ---- invoices（read-only in Wave 3A; create/delete 仍在 routes/invoices.js 直接用 db，見檔案頂端說明）----

  findInvoicesByStudent(schoolId, studentId) {
    return db
      .prepare(
        `SELECT i.*, (SELECT COUNT(*) FROM invoice_items WHERE invoice_id = i.id) as item_count
         FROM invoices i WHERE i.school_id = ? AND i.student_id = ?
         ORDER BY i.issued_date DESC, i.created_at DESC`
      )
      .all(schoolId, studentId);
  },

  findInvoiceById(schoolId, id) {
    return db.prepare('SELECT * FROM invoices WHERE id = ? AND school_id = ?').get(id, schoolId);
  },

  findInvoiceItemsWithSession(invoiceId) {
    return db
      .prepare(
        `SELECT ii.id, ii.unit_price, cs.session_date, cs.subject, cs.type, cs.start_slot, cs.duration_slots, cs.teacher_id,
                origin.session_date as origin_session_date, origin.start_slot as origin_start_slot
         FROM invoice_items ii JOIN class_sessions cs ON cs.id = ii.session_id
         LEFT JOIN class_sessions origin ON origin.id = cs.origin_session_id
         WHERE ii.invoice_id = ? ORDER BY cs.session_date`
      )
      .all(invoiceId);
  },

  // 給「開立繳費單」頁勾選用：該學生某區間的課堂，含出缺勤狀態與是否已開立過
  findInvoiceableSessionsForStudent(schoolId, studentId, start, end) {
    return db
      .prepare(
        `SELECT cs.id as session_id, cs.session_date, cs.start_slot, cs.duration_slots, cs.subject, cs.teacher_id, cs.type,
                ss.unit_price, ar.status as attendance_status,
                CASE WHEN ii.id IS NOT NULL THEN 1 ELSE 0 END as invoiced,
                origin.session_date as origin_session_date, origin.start_slot as origin_start_slot
         FROM session_students ss
         JOIN class_sessions cs ON cs.id = ss.session_id
         LEFT JOIN attendance_records ar ON ar.session_id = cs.id AND ar.person_type = 'student' AND ar.person_id = ss.student_id
         LEFT JOIN invoice_items ii ON ii.session_id = cs.id
         LEFT JOIN class_sessions origin ON origin.id = cs.origin_session_id
         WHERE cs.school_id = ? AND ss.student_id = ? AND cs.session_date >= ? AND cs.session_date < ? AND cs.cancelled = 0
         ORDER BY cs.session_date, cs.start_slot`
      )
      .all(schoolId, studentId, start, end);
  },

  findInvoicesIssuedInRange(schoolId, start, end) {
    return db
      .prepare(
        `SELECT inv.*, s.name as student_name FROM invoices inv
         JOIN students s ON s.id = inv.student_id
         WHERE inv.school_id = ? AND inv.issued_date >= ? AND inv.issued_date < ?`
      )
      .all(schoolId, start, end);
  },

  hasInvoiceItemForSession(sessionId) {
    return !!db.prepare('SELECT 1 FROM invoice_items WHERE session_id = ?').get(sessionId);
  },

  // 開立繳費單時驗證單一課堂：須屬於該學生、屬於這間補習班，回傳計價需要的欄位
  findInvoiceableSessionRow(schoolId, studentId, sessionId) {
    return db
      .prepare(
        `SELECT cs.id, cs.session_date, cs.subject, ss.unit_price
         FROM class_sessions cs
         JOIN session_students ss ON ss.session_id = cs.id AND ss.student_id = ?
         WHERE cs.id = ? AND cs.school_id = ?`
      )
      .get(studentId, sessionId, schoolId);
  },

  // ---- payslips（read-only in Wave 3A; create/delete 仍在 routes/payslips.js 直接用 db，見檔案頂端說明）----

  findPayslipsByTeacher(schoolId, teacherId) {
    return db
      .prepare(
        `SELECT p.*, (SELECT COUNT(*) FROM payslip_items WHERE payslip_id = p.id) as item_count
         FROM payslips p WHERE p.school_id = ? AND p.teacher_id = ?
         ORDER BY p.issued_date DESC, p.created_at DESC`
      )
      .all(schoolId, teacherId);
  },

  findPayslipById(schoolId, id) {
    return db.prepare('SELECT * FROM payslips WHERE id = ? AND school_id = ?').get(id, schoolId);
  },

  findPayslipItemsWithSession(payslipId) {
    return db
      .prepare(
        `SELECT pi.id, pi.session_id, pi.hours, pi.rate, pi.pay, cs.session_date, cs.subject, cs.type, cs.start_slot, cs.duration_slots,
                origin.session_date as origin_session_date, origin.start_slot as origin_start_slot
         FROM payslip_items pi JOIN class_sessions cs ON cs.id = pi.session_id
         LEFT JOIN class_sessions origin ON origin.id = cs.origin_session_id
         WHERE pi.payslip_id = ? ORDER BY cs.session_date`
      )
      .all(payslipId);
  },

  // ledger detail 的薪資分支專用：欄位形狀跟 findPayslipItemsWithSession 略有不同（多一個 class_session_id 別名），
  // 沿用原本 route 的寫法，不強行合併成同一個方法造成呼叫端還要轉欄位名稱
  findPayslipItemsWithSessionForLedgerDetail(payslipId) {
    return db
      .prepare(
        `SELECT pi.id as session_id, pi.session_id as class_session_id, pi.hours, pi.rate, pi.pay, cs.session_date, cs.subject, cs.type, cs.start_slot, cs.duration_slots,
                origin.session_date as origin_session_date, origin.start_slot as origin_start_slot
         FROM payslip_items pi JOIN class_sessions cs ON cs.id = pi.session_id
         LEFT JOIN class_sessions origin ON origin.id = cs.origin_session_id
         WHERE pi.payslip_id = ? ORDER BY cs.session_date`
      )
      .all(payslipId);
  },

  findPayslipsIssuedInRange(schoolId, start, end) {
    return db
      .prepare(
        `SELECT p.*, t.name as teacher_name FROM payslips p
         JOIN teachers t ON t.id = p.teacher_id
         WHERE p.school_id = ? AND p.issued_date >= ? AND p.issued_date < ?`
      )
      .all(schoolId, start, end);
  },

  hasPayslipItemForSession(sessionId) {
    return !!db.prepare('SELECT 1 FROM payslip_items WHERE session_id = ?').get(sessionId);
  },

  // 開立薪資條時驗證單一課堂：須屬於該教師、屬於這間補習班
  findPayslipableSessionRow(schoolId, teacherId, sessionId) {
    return db.prepare('SELECT * FROM class_sessions WHERE id = ? AND school_id = ? AND teacher_id = ?').get(sessionId, schoolId, teacherId);
  },

  // 沿用原本用 SQLite date('now') 判斷「今天」的寫法（跟 Node Date 在時區語意上可能不同，
  // 這是既有行為，Wave 3B 不改），給「未來日期不可開薪資」的規則用
  today() {
    return db.prepare(`SELECT date('now') as d`).get().d;
  },

  // 給薪資試算/開立薪資條頁用：某堂課的學生姓名清單（is_admin 由呼叫端依 length===0 判斷）
  findSessionStudentNames(sessionId) {
    return db
      .prepare(`SELECT s.name FROM session_students ss JOIN students s ON s.id = ss.student_id WHERE ss.session_id = ?`)
      .all(sessionId)
      .map((r) => r.name);
  },

  // ---- tuition_records ----

  findTuitionRecord(studentId, month) {
    return db.prepare('SELECT * FROM tuition_records WHERE student_id = ? AND month = ?').get(studentId, month);
  },

  findTuitionRecordScoped(schoolId, studentId, month) {
    return db.prepare('SELECT * FROM tuition_records WHERE school_id = ? AND student_id = ? AND month = ?').get(schoolId, studentId, month);
  },

  createTuitionRecord({ id, schoolId, studentId, month, sessionCount, unitPrice, expectedAmount, actualAmount, rollover, note }) {
    db.prepare(
      `INSERT INTO tuition_records (id, school_id, student_id, month, session_count, unit_price, expected_amount, actual_amount, rollover, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, schoolId, studentId, month, sessionCount, unitPrice, expectedAmount, actualAmount, rollover ? 1 : 0, note ?? null);
  },

  updateTuitionRecord(id, { sessionCount, unitPrice, expectedAmount, actualAmount, rollover, note }) {
    db.prepare(
      `UPDATE tuition_records SET session_count=?, unit_price=?, expected_amount=?, actual_amount=?, rollover=?, note=?, updated_at=datetime('now')
       WHERE id = ?`
    ).run(sessionCount, unitPrice, expectedAmount, actualAmount, rollover ? 1 : 0, note ?? null, id);
  },

  deleteTuitionRecord(schoolId, studentId, month) {
    db.prepare('DELETE FROM tuition_records WHERE school_id = ? AND student_id = ? AND month = ?').run(schoolId, studentId, month);
  },

  // ---- finance calculation 用的唯讀查詢（services/finance.js 呼叫）----

  // 某堂課的學生名單 + 這堂課的出缺勤狀態，給薪資試算判斷「已請假/已調課/尚未點名」用
  findSessionStudentsWithAttendance(sessionId) {
    return db
      .prepare(
        `SELECT s.id, s.name, s.grade, ar.status as attendance_status, ar.makeup_arranged
         FROM session_students ss
         JOIN students s ON s.id = ss.student_id
         LEFT JOIN attendance_records ar ON ar.session_id = ss.session_id AND ar.person_type = 'student' AND ar.person_id = ss.student_id
         WHERE ss.session_id = ?`
      )
      .all(sessionId);
  },

  // 學費試算用：某學生某區間內「已出席」的課堂 + 對應單堂價錢
  findBillableAttendedSessions(schoolId, studentId, start, end) {
    return db
      .prepare(
        `SELECT cs.id as session_id, cs.session_date, cs.subject, cs.type, cs.start_slot, cs.duration_slots, ss.unit_price
         FROM session_students ss
         JOIN class_sessions cs ON cs.id = ss.session_id
         JOIN attendance_records ar ON ar.session_id = cs.id AND ar.person_type = 'student' AND ar.person_id = ss.student_id
         WHERE cs.school_id = ? AND ss.student_id = ? AND cs.session_date >= ? AND cs.session_date < ?
           AND cs.cancelled = 0 AND ar.status = 'present'
         ORDER BY cs.session_date, cs.start_slot`
      )
      .all(schoolId, studentId, start, end);
  },
};
