-- 補習班營運系統 schema (SQLite)
PRAGMA foreign_keys = ON;

-- default_price_*：學生單堂預設金額（依年級級距），新增固定課程/單堂加課時作為預設單價，仍可手動覆蓋
CREATE TABLE IF NOT EXISTS schools (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  invite_code TEXT NOT NULL UNIQUE,
  default_price_grade_1_6 INTEGER NOT NULL DEFAULT 1180,
  default_price_grade_7_9 INTEGER NOT NULL DEFAULT 1180,
  default_price_grade_10_12 INTEGER NOT NULL DEFAULT 1480,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- is_owner: 平台最高權限者（唯一，通常是系統建置者本人），可跨補習班刪除整間補習班
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  line_user_id TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  picture_url TEXT,
  is_owner INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 一個 user 在不同補習班可能有不同角色；role='teacher' 時 teacher_id 對應到該補習班的 teachers.id
-- role='front_desk'（櫃台）：對學生檔案/教師檔案/課表/點名/座位五項子系統有完整操作權限，但無財務（繳費單/薪資/收支）與成員管理權限
CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'teacher', 'front_desk')),
  teacher_id TEXT REFERENCES teachers(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, school_id)
);

CREATE TABLE IF NOT EXISTS teachers (
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  teacher_no TEXT, -- 補習班自訂的教師編號（非系統內部 id），僅供顯示/對照用
  name TEXT NOT NULL,
  subjects TEXT NOT NULL DEFAULT '[]',
  rate_grade_1_6 INTEGER NOT NULL DEFAULT 0,
  rate_grade_7_9 INTEGER NOT NULL DEFAULT 0,
  rate_grade_10_12 INTEGER NOT NULL DEFAULT 0,
  rate_admin INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS students (
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_no TEXT, -- 補習班自訂的學生編號（非系統內部 id），僅供顯示/對照用
  name TEXT NOT NULL,
  grade INTEGER NOT NULL CHECK (grade BETWEEN 1 AND 12),
  school_name TEXT,
  subjects TEXT NOT NULL DEFAULT '[]',
  teacher_id TEXT REFERENCES teachers(id) ON DELETE SET NULL,
  tuition_monthly INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 每週固定課表樣板
CREATE TABLE IF NOT EXISTS schedule_templates (
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  teacher_id TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6), -- 0=Sun
  start_slot INTEGER NOT NULL, -- 半小時單位, 0 = 00:00, 1 = 00:30 ...
  duration_slots INTEGER NOT NULL DEFAULT 2,
  active_from TEXT NOT NULL DEFAULT (date('now')),
  active_until TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS template_students (
  template_id TEXT NOT NULL REFERENCES schedule_templates(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  unit_price INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (template_id, student_id)
);

-- 單次上課實例：由 template 展開的 regular，或手動建立的 makeup / extra
CREATE TABLE IF NOT EXISTS class_sessions (
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  template_id TEXT REFERENCES schedule_templates(id) ON DELETE SET NULL,
  teacher_id TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  session_date TEXT NOT NULL, -- YYYY-MM-DD
  start_slot INTEGER NOT NULL,
  duration_slots INTEGER NOT NULL DEFAULT 2,
  type TEXT NOT NULL DEFAULT 'regular' CHECK (type IN ('regular', 'makeup', 'extra')),
  origin_session_id TEXT REFERENCES class_sessions(id) ON DELETE SET NULL, -- makeup 課回指原本被取消的那堂
  cancelled INTEGER NOT NULL DEFAULT 0, -- regular 類型刪除單一天時用軟刪除，避免樣板懶生成時又展開回來
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS session_students (
  session_id TEXT NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  unit_price INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, student_id)
);

-- 出缺勤：學生與教師共用一張表，用 person_type 區分
CREATE TABLE IF NOT EXISTS attendance_records (
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE,
  person_type TEXT NOT NULL CHECK (person_type IN ('student', 'teacher')),
  person_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('present', 'absent', 'leave')),
  makeup_arranged INTEGER NOT NULL DEFAULT 0,
  makeup_session_id TEXT REFERENCES class_sessions(id) ON DELETE SET NULL,
  note TEXT,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (session_id, person_type, person_id)
);

-- 一次性邀請碼：管理者先指定身分(admin 或指定某位既有教師)才產生，兌換後即失效
CREATE TABLE IF NOT EXISTS invite_codes (
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'teacher', 'front_desk')),
  teacher_id TEXT REFERENCES teachers(id) ON DELETE CASCADE,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  used_at TEXT,
  used_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS seat_assignments (
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  seat_date TEXT NOT NULL,
  time_slot INTEGER NOT NULL, -- 半小時單位
  seat_number INTEGER NOT NULL CHECK (seat_number BETWEEN 1 AND 13),
  teacher_id TEXT REFERENCES teachers(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (school_id, seat_date, time_slot, seat_number)
);

CREATE TABLE IF NOT EXISTS seat_students (
  seat_assignment_id TEXT NOT NULL REFERENCES seat_assignments(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  PRIMARY KEY (seat_assignment_id, student_id)
);

-- 每位學生每月的實收金額紀錄，由學生詳細頁維護；收支統計的「產生本月學費」直接讀這張表
CREATE TABLE IF NOT EXISTS tuition_records (
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  month TEXT NOT NULL, -- 'YYYY-MM'
  session_count INTEGER NOT NULL DEFAULT 0, -- 計費堂數，可由管理者手動調整，不一定等於系統試算的出席堂數
  unit_price INTEGER NOT NULL DEFAULT 0, -- 計費用的單堂價錢，可由管理者手動調整
  expected_amount INTEGER NOT NULL DEFAULT 0, -- = session_count * unit_price（含上月併入金額另計）
  actual_amount INTEGER NOT NULL DEFAULT 0,
  rollover INTEGER NOT NULL DEFAULT 0, -- 未收餘額是否併入次月
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (student_id, month)
);

-- 繳費單：管理者從學生已出席的課堂中挑選（可跨月）開立，每堂課只能被開立一次，避免重複收費
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  issued_date TEXT NOT NULL DEFAULT (date('now')),
  total_amount INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE,
  unit_price INTEGER NOT NULL DEFAULT 0,
  UNIQUE (session_id)
);

-- 薪資條：管理者從教師的當月排課中挑選（可跨月）開立，每堂課只能被開立一次，避免重複計薪
CREATE TABLE IF NOT EXISTS payslips (
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  teacher_id TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  issued_date TEXT NOT NULL DEFAULT (date('now')),
  total_amount INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payslip_items (
  id TEXT PRIMARY KEY,
  payslip_id TEXT NOT NULL REFERENCES payslips(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE,
  hours REAL NOT NULL DEFAULT 0,
  rate INTEGER NOT NULL DEFAULT 0,
  pay INTEGER NOT NULL DEFAULT 0,
  UNIQUE (session_id)
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('income', 'expense')),
  category TEXT NOT NULL CHECK (category IN ('tuition', 'salary', 'manual')),
  amount INTEGER NOT NULL,
  entry_date TEXT NOT NULL,
  related_student_id TEXT REFERENCES students(id) ON DELETE SET NULL,
  related_teacher_id TEXT REFERENCES teachers(id) ON DELETE SET NULL,
  related_invoice_id TEXT REFERENCES invoices(id) ON DELETE SET NULL,
  related_payslip_id TEXT REFERENCES payslips(id) ON DELETE SET NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 記事：僅管理者可用的備忘/日誌，可選擇性連結到某位學生或教師
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  author_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  category TEXT NOT NULL DEFAULT '備註', -- 自由文字，使用者可自訂新分類
  done INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL,
  note_date TEXT NOT NULL DEFAULT (date('now')),
  related_student_id TEXT REFERENCES students(id) ON DELETE SET NULL,
  related_teacher_id TEXT REFERENCES teachers(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_students_school ON students(school_id);
CREATE INDEX IF NOT EXISTS idx_teachers_school ON teachers(school_id);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_school ON memberships(school_id);
CREATE INDEX IF NOT EXISTS idx_sessions_school_date ON class_sessions(school_id, session_date);
CREATE INDEX IF NOT EXISTS idx_attendance_session ON attendance_records(session_id);
CREATE INDEX IF NOT EXISTS idx_seat_school_date ON seat_assignments(school_id, seat_date, time_slot);
CREATE INDEX IF NOT EXISTS idx_ledger_school_date ON ledger_entries(school_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_invite_codes_school ON invite_codes(school_id);
CREATE INDEX IF NOT EXISTS idx_tuition_records_student ON tuition_records(student_id, month);
CREATE INDEX IF NOT EXISTS idx_notes_school_date ON notes(school_id, note_date);
