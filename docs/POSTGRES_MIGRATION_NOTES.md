# PostgreSQL Migration Notes

Phase 1B 不遷移 PostgreSQL，只記錄。這份文件隨每個 Wave 累積，供 Phase 1C 使用。

## DatabaseSync（node:sqlite）語意，PostgreSQL 需注意的差異

- `node:sqlite` 的 `DatabaseSync` 是**同步 API**（`db.prepare(...).get()/.all()/.run()` 都同步回傳）。
  PostgreSQL client（`pg`、`postgres` 等）幾乎都是 **async**。Phase 1B 刻意保持 repository method 同步，
  避免同時做「repository 抽離」+「async 化」+「DB 遷移」三件事。
  → **Phase 1C 需要把所有 repository method 轉成 `async`/回傳 Promise**，呼叫端（route handler）
  本來就是 Express async handler 慣用寫法，改動風險相對集中在 repository 內部與少數呼叫端的 `await`。
- `runInTransaction(fn)`（`db/index.js`）目前是同步包 `BEGIN`/`COMMIT`/`ROLLBACK`。PostgreSQL 需要
  await 每個 client query，這個 helper 在 Phase 1C 需要重寫為 async 版本（例如用一個 client 開 transaction，
  所有 repository call 都要接受可選的 client/transaction context 參數）。

## Timestamp Handling

- `created_at`/`updated_at` 目前一律由 **SQLite 端**用 `datetime('now')`產生（schema.sql 的欄位 DEFAULT，
  或 UPDATE 語句裡明寫 `updated_at = datetime('now')`），不是 Node.js 產生。
- `datetime('now')` 回傳 UTC，格式 `YYYY-MM-DD HH:MM:SS`（無時區資訊字尾）。PostgreSQL 的
  `now()`/`CURRENT_TIMESTAMP` 預設回傳帶時區的 `timestamptz`，字串格式不同，**前端如果有直接顯示或
  解析這個欄位格式，需要在遷移時一併確認**。
- 目前沒有欄位由 Node.js 產生 timestamp 後寫入 DB（都是交給 DB default 或顯式 SQL 函式）。
- API 直接輸出的 timestamp 欄位：`created_at`、`updated_at`（students/teachers/schools/memberships 等
  多數資料表皆有），格式即上述 SQLite 字串，前端目前用字串切片（例如 `.slice(0, 10)`）取日期部分，
  遷移時若格式改變會直接影響前端顯示，需要一併測試。

## SQLite-specific Constructs Inventory

以下是目前程式碼中已確認會受 PostgreSQL 遷移影響的寫法，隨 Wave 進度持續補充：

| Construct | 出現位置 | PostgreSQL 對應 |
|---|---|---|
| `PRAGMA journal_mode = WAL` / `PRAGMA foreign_keys = ON/OFF` | `db/index.js` | 不適用，PostgreSQL 用 `SET` 或 connection 層級設定，foreign key 預設就是強制的 |
| `datetime('now')` | schema.sql 多處欄位 DEFAULT、部分 UPDATE 語句 | `now()` / `CURRENT_TIMESTAMP`，注意時區語意差異（見上） |
| `CHECK (...)` constraint（例如 `role IN (...)`, `grade BETWEEN 1 AND 12`） | schema.sql 多個資料表 | PostgreSQL 語法相容，可直接沿用，但目前有多處是「改 CHECK 需要整張表重建」的 SQLite 限制（見下） |
| 手動 table rebuild migration（`CREATE TABLE tmp ... / INSERT ... SELECT / DROP / RENAME`） | `db/index.js` 的 `migrateRoleCheckIncludesFrontDesk`、`migrateSeatNumberUpperBound` | PostgreSQL 可以直接 `ALTER TABLE ... ALTER CONSTRAINT` 或 `DROP CONSTRAINT` + `ADD CONSTRAINT`，不需要整張表重建；Phase 1C 的正式 migration framework 應該用這個簡化寫法 |
| JSON 存成 `TEXT`，應用層 `JSON.stringify`/`JSON.parse` | 見下方「JSON Columns」 | PostgreSQL 有原生 `JSON`/`JSONB` 型別，可以直接存物件、用 `->`/`->>` 查詢，遷移時可考慮改用 `JSONB`（但這是 schema 層決定，不在 Phase 1B/1C repository 抽離範圍內，需另外評估） |
| Boolean 用 `INTEGER`（0/1） | 例如 `is_owner`、`cancelled`、`rollover`、`makeup_arranged` | PostgreSQL 有原生 `BOOLEAN`；目前 repository 層有些地方會手動 `!!record.rollover` 轉真正的 boolean 給 API response，這個轉換邏輯遷移後可能可以省略（但要小心 API response shape 不能變） |
| `nanoid()` 產生 ID（Node.js 端，非 DB） | 各 repository 的 `create()` 呼叫端（目前是 route 層傳入 id，Wave 1 沒有改變這個慣例） | 不受 DB 影響，維持現狀 |

## ID Generation Convention（現況記錄，Phase 1B 未更動）

目前 ID 由 **Route 層**在呼叫 repository `create()` 之前用 `nanoid()` 產生，再作為參數傳入
（例如 `students.js` 的 `const id = nanoid(); studentsRepository.create({ id, ... })`）。
這不是 Phase 1B 建議的理想慣例（理想是 Service 產生），但為了維持 Zero Behavior Change、不在
Repository 抽離的同時又動 ID 產生時機，Wave 1 刻意保持現狀。之後的 Wave 若要統一慣例，會另外記錄
決策，不要求一次改完。

## JSON Columns（現況，Wave 1 涵蓋部分）

已確認的 JSON-as-TEXT 欄位（`schools`、`students`、`teachers`）：

- `schools.subjects`、`schools.type_colors`、`schools.schedule_type_order`、`schools.attendance_type_order`、
  `schools.settings_section_order`、`schools.seat_layout`、`schools.removed_default_categories`
- `students.subjects`
- `teachers.subjects`、`teachers.flexible_schedule`

Wave 1 的 repository 已經把這些欄位的 serialize（寫入前 `JSON.stringify`）集中在 repository 內部；
deserialize（讀出後 `JSON.parse`）目前**還留在 route 層的 `serialize(row)` 函式**（`students.js`/`teachers.js`），
因為這牽涉到 route 回傳給前端的 response shape，Phase 1B 為了 Zero Behavior Change 沒有把這個搬進
repository（避免 repository 回傳的物件形狀跟 route 預期的不一致造成隱藏 bug）。這是明確記錄的
technical debt，Wave 2/3 遇到類似狀況會依樣處理，最後統一評估要不要把 deserialize 也收進 repository。

其餘資料表（`class_sessions`、`schedule_templates`、`invoices` 等）的 JSON 欄位待該 Wave 處理時再補充。

## Wave 2 — Scheduling

### `date('now')` / `datetime('now')` 用法

- `schedule_templates.active_from` 預設 `date('now')`（只有日期，無時間）。
- `class_sessions`/`schedule_templates` 的多個查詢用 `session_date >= date('now')` 判斷「尚未發生」，
  例如樣板刪除時判斷哪些已展開課堂要一併取消。PostgreSQL 對應 `CURRENT_DATE`，語意相同（皆為
  「執行當下的日期」），但要注意 SQLite 的 `date('now')` 預設是 **UTC**，PostgreSQL 的 `CURRENT_DATE`
  預設吃**連線 session 的 timezone 設定**——如果 Postgres 連線沒有明確設成 UTC，`session_date >=
  CURRENT_DATE` 這類比較在午夜前後可能跟現在的 SQLite 行為有幾小時的落差，需要在 Phase 1C 明確指定
  connection timezone 為 UTC 或改用 `(now() AT TIME ZONE 'utc')::date`。

### Transaction 語意（同步 vs async）

- Wave 2 是第一個真正大量使用多步驟 transaction 的 Wave（樣板+學生、課堂+學生+請假連動、撤銷點名+
  取消調課課堂）。目前 `runInTransaction(fn)` 是同步、單一全域 `db` 連線的 `BEGIN`/`COMMIT`/`ROLLBACK`，
  fn 內部所有 repository 呼叫共用同一個連線與同一個 transaction。
- PostgreSQL client 通常需要**顯式從 connection pool 借一個 client**、在同一個 client 上跑
  `BEGIN`/連續 query/`COMMIT`，而且是 async。Phase 1C 的 `runInTransaction` 等價實作需要：
  1. 從 pool acquire 一個 client
  2. 把這個 client（或包一層的 transaction context）傳給 transaction 內部呼叫的每一個 repository method
     （目前 SQLite 版本因為只有一個全域連線，repository method 不需要接收 connection 參數；PostgreSQL
     版本的 repository method 簽名很可能需要新增一個可選的 `client`/`tx` 參數）
  3. finally 一定要 release client 回 pool
- 這是 Phase 1C 需要規劃、但 Phase 1B 明確不做的部分（避免同時做 repository 抽離 + async 化 + DB 遷移）。

### FK 約束與 rollback

- `class_sessions`/`session_students`/`template_students`/`attendance_records`/`seat_students` 都有
  `REFERENCES ... ON DELETE CASCADE`/`ON DELETE SET NULL` 外鍵，`db/index.js` 開機時 `PRAGMA foreign_keys
  = ON` 強制生效。Wave 2 實際驗證過：在 transaction 中途發生 FK violation（插入不存在的 `student_id`）
  會拋錯並被 `runInTransaction` 的 `catch` 區塊執行 `ROLLBACK`，不會留下部分寫入的 row。PostgreSQL 的
  FK 約束預設就是強制的（不需要額外 PRAGMA），行為應該一致，但這是 Phase 1C 實際遷移後仍要重新驗證的項目。

### 沒有 JSON-as-TEXT 欄位

- `schedule_templates`/`class_sessions`/`session_students`/`template_students`/`attendance_records`/
  `seat_assignments`/`seat_students` 這些 Wave 2 涵蓋的資料表本身**沒有** JSON-as-TEXT 欄位，跟 Wave 1
  的 `schools`/`teachers` 不同。這個 Wave 沒有新的 JSON serialization 技術債需要記錄。

### `INSERT OR ...` 用法

- Wave 2 涵蓋的 repository 沒有使用 `INSERT OR IGNORE`/`INSERT OR REPLACE`。點名（`attendance_records`）
  的 upsert 是應用層先 `SELECT` 再決定 `INSERT` 或 `UPDATE`（見 REPOSITORY_ARCHITECTURE.md 的技術債段落），
  不是靠 SQLite 的 `INSERT OR REPLACE` 語法糖。PostgreSQL 若要優化這個 upsert，可以用
  `INSERT ... ON CONFLICT (session_id, person_type, person_id) DO UPDATE SET ...`（`attendance_records`
  已經有這個 UNIQUE constraint），但這是 Phase 1C 的優化選項，不是遷移必須項目。

## 待補充（後續 Wave）

- Wave 3（finance）：`invoices`/`invoice_items`/`payslips`/`payslip_items`/`ledger_entries` 是否有多步驟
  transaction 需要在 Phase 1C 特別注意。
- Wave 4（cross-cutting）：`auth.js`（LINE Login upsert）、`inviteCodes.js`、`notes.js`、`trash.js` 的
  SQLite 特定行為。
