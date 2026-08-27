import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, '../../data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'app.db');
export const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
db.exec(schema);

// node:sqlite 的 DatabaseSync 沒有 better-sqlite3 那種 db.transaction() helper，手動包 BEGIN/COMMIT/ROLLBACK
export function runInTransaction(fn) {
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// 輕量 migration：為既有資料庫補上新欄位（新資料庫由上面的 CREATE TABLE 直接建好，不受影響）
function ensureColumn(table, column, ddl) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

ensureColumn('users', 'is_owner', 'is_owner INTEGER NOT NULL DEFAULT 0');
ensureColumn('template_students', 'unit_price', 'unit_price INTEGER NOT NULL DEFAULT 0');
ensureColumn('session_students', 'unit_price', 'unit_price INTEGER NOT NULL DEFAULT 0');
ensureColumn('class_sessions', 'cancelled', 'cancelled INTEGER NOT NULL DEFAULT 0');
ensureColumn('tuition_records', 'session_count', 'session_count INTEGER NOT NULL DEFAULT 0');
ensureColumn('tuition_records', 'unit_price', 'unit_price INTEGER NOT NULL DEFAULT 0');
ensureColumn('ledger_entries', 'related_invoice_id', 'related_invoice_id TEXT REFERENCES invoices(id) ON DELETE SET NULL');
ensureColumn('students', 'student_no', 'student_no TEXT');
ensureColumn('teachers', 'teacher_no', 'teacher_no TEXT');
ensureColumn('ledger_entries', 'related_payslip_id', 'related_payslip_id TEXT REFERENCES payslips(id) ON DELETE SET NULL');
ensureColumn('schools', 'default_price_grade_1_6', 'default_price_grade_1_6 INTEGER NOT NULL DEFAULT 1180');
ensureColumn('schools', 'default_price_grade_7_9', 'default_price_grade_7_9 INTEGER NOT NULL DEFAULT 1180');
ensureColumn('schools', 'default_price_grade_10_12', 'default_price_grade_10_12 INTEGER NOT NULL DEFAULT 1480');
ensureColumn('notes', 'category', "category TEXT NOT NULL DEFAULT '備註'");
ensureColumn('notes', 'done', 'done INTEGER NOT NULL DEFAULT 0');
ensureColumn('notes', 'categories', "categories TEXT NOT NULL DEFAULT '[]'");
ensureColumn('schools', 'seat_layout', "seat_layout TEXT NOT NULL DEFAULT '[[1,2,3,4],[5,6,7,8],[9,10,11],[12,13]]'");
ensureColumn('schools', 'removed_default_categories', "removed_default_categories TEXT NOT NULL DEFAULT '[]'");
ensureColumn('teachers', 'flexible_schedule', "flexible_schedule TEXT NOT NULL DEFAULT '{}'");
ensureColumn('trash', 'related_student_ids', "related_student_ids TEXT NOT NULL DEFAULT '[]'");
ensureColumn('trash', 'related_teacher_id', 'related_teacher_id TEXT');
ensureColumn('schools', 'group_class_max_students', 'group_class_max_students INTEGER NOT NULL DEFAULT 2');
ensureColumn('schools', 'time_picker_range_start', "time_picker_range_start TEXT NOT NULL DEFAULT '18:00'");
ensureColumn('schools', 'time_picker_range_end', "time_picker_range_end TEXT NOT NULL DEFAULT '21:00'");
ensureColumn('schools', 'default_schedule_span_months', 'default_schedule_span_months INTEGER NOT NULL DEFAULT 4');
ensureColumn('schedule_templates', 'rate_override', 'rate_override INTEGER');
ensureColumn('class_sessions', 'rate_override', 'rate_override INTEGER');
ensureColumn(
  'schools',
  'subjects',
  `subjects TEXT NOT NULL DEFAULT '["C","E","M","N","S","PHY","CHEM","HIST","GEO","CIV","AD","J"]'`
);
ensureColumn('schools', 'default_class_duration_hours', 'default_class_duration_hours REAL NOT NULL DEFAULT 1.5');
ensureColumn('schools', 'type_colors', `type_colors TEXT NOT NULL DEFAULT '{"regular":"camel","extra":"green","makeup":"blue","leave":"red"}'`);
ensureColumn('schools', 'schedule_type_order', `schedule_type_order TEXT NOT NULL DEFAULT '["extra","makeup","regular"]'`);
ensureColumn('schools', 'attendance_type_order', `attendance_type_order TEXT NOT NULL DEFAULT '["extra","makeup","regular"]'`);
ensureColumn('schools', 'settings_section_order', `settings_section_order TEXT NOT NULL DEFAULT '[]'`);

// 記事分類舊資料從英文代碼改為自由文字（開放使用者自訂分類前的舊值）
db.exec(`UPDATE notes SET category = '待辦' WHERE category = 'todo'`);
db.exec(`UPDATE notes SET category = '備註' WHERE category = 'note'`);

// 記事分類從單一字串（category）改成可複選的陣列（categories）：把舊資料的單一分類搬進新欄位，只搬一次
const hasLegacyCategoryColumn = db.prepare(`PRAGMA table_info(notes)`).all().some((c) => c.name === 'category');
if (hasLegacyCategoryColumn) {
  const legacyRows = db
    .prepare(`SELECT id, category FROM notes WHERE (categories IS NULL OR categories = '[]') AND category IS NOT NULL AND category != ''`)
    .all();
  const updateCategories = db.prepare('UPDATE notes SET categories = ? WHERE id = ?');
  for (const row of legacyRows) {
    updateCategories.run(JSON.stringify([row.category]), row.id);
  }
}

// role 欄位新增 front_desk（櫃台）身分：SQLite 的 CHECK 約束無法用 ALTER TABLE 修改，需重建資料表搬移資料
// （新資料庫由上面 schema.sql 的 CREATE TABLE 直接建好，CHECK 已含 front_desk，這裡會直接跳過）
function migrateRoleCheckIncludesFrontDesk(table) {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
  if (!row || row.sql.includes('front_desk')) return;

  const tmpTable = `${table}_migrating_role`;
  const newSql = row.sql
    .replace(new RegExp(`CREATE TABLE(\\s+IF NOT EXISTS)?\\s+${table}\\b`), `CREATE TABLE ${tmpTable}`)
    .replace("CHECK (role IN ('admin', 'teacher'))", "CHECK (role IN ('admin', 'teacher', 'front_desk'))");
  db.exec(newSql);
  const columns = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name)
    .join(', ');
  db.exec(`INSERT INTO ${tmpTable} (${columns}) SELECT ${columns} FROM ${table}`);
  db.exec(`DROP TABLE ${table}`);
  db.exec(`ALTER TABLE ${tmpTable} RENAME TO ${table}`);
}

migrateRoleCheckIncludesFrontDesk('memberships');
migrateRoleCheckIncludesFrontDesk('invite_codes');

// 座位數量上限從固定 13 開放為可自訂新增：CHECK 約束一樣無法用 ALTER TABLE 修改，需重建資料表
// seat_students 有 FK 指向 seat_assignments，重建期間暫時關閉 FK 檢查，重建完再開回來
function migrateSeatNumberUpperBound() {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'seat_assignments'`).get();
  if (!row || !row.sql.includes('BETWEEN 1 AND 13')) return;

  const tmpTable = 'seat_assignments_migrating';
  const newSql = row.sql
    .replace(/CREATE TABLE(\s+IF NOT EXISTS)?\s+seat_assignments\b/, `CREATE TABLE ${tmpTable}`)
    .replace('CHECK (seat_number BETWEEN 1 AND 13)', 'CHECK (seat_number >= 1)');

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(newSql);
  const columns = db.prepare(`PRAGMA table_info(seat_assignments)`).all().map((c) => c.name).join(', ');
  db.exec(`INSERT INTO ${tmpTable} (${columns}) SELECT ${columns} FROM seat_assignments`);
  db.exec('DROP TABLE seat_assignments');
  db.exec(`ALTER TABLE ${tmpTable} RENAME TO seat_assignments`);
  db.exec('PRAGMA foreign_keys = ON');
}

migrateSeatNumberUpperBound();
