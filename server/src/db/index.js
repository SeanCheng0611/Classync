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

// 記事分類舊資料從英文代碼改為自由文字（開放使用者自訂分類前的舊值）
db.exec(`UPDATE notes SET category = '待辦' WHERE category = 'todo'`);
db.exec(`UPDATE notes SET category = '備註' WHERE category = 'note'`);

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
