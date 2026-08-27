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

## Wave 3A — Finance

### Money Representation

已核對 `schema.sql` 實際欄位型別（不是憑印象假設）：

| Table | Column | SQLite Type | 單位 | Nullable | 備註 |
|---|---|---|---|---|---|
| `students` | `tuition_monthly` | INTEGER | 元 | NOT NULL DEFAULT 0 | 估算備援值 |
| `teachers` | `rate_grade_1_6`/`rate_grade_7_9`/`rate_grade_10_12`/`rate_admin` | INTEGER | 元/小時 | NOT NULL DEFAULT 0 | |
| `schedule_templates`/`class_sessions` | `rate_override` | INTEGER | 元/小時 | 可 NULL（NULL = 沿用教師檔案時薪） | |
| `session_students`/`template_students` | `unit_price` | INTEGER | 元/堂 | NOT NULL DEFAULT 0 | |
| `tuition_records` | `unit_price`/`expected_amount`/`actual_amount` | INTEGER | 元 | NOT NULL DEFAULT 0 | |
| `invoices`/`payslips` | `total_amount` | INTEGER | 元 | NOT NULL DEFAULT 0 | |
| `invoice_items` | `unit_price` | INTEGER | 元 | NOT NULL DEFAULT 0 | |
| `payslip_items` | `hours` | **REAL** | 小時 | NOT NULL DEFAULT 0 | 唯一非整數金額相關欄位，因為半小時堂課 `duration_slots/2` 可能是 `1.5` 這種值 |
| `payslip_items` | `rate`/`pay` | INTEGER | 元/小時、元 | NOT NULL DEFAULT 0 | `pay` 寫入前用 `Math.round()`，見下方 Rounding |
| `ledger_entries` | `amount` | INTEGER | 元 | NOT NULL（無 DEFAULT，呼叫端必填） | |

**全部金額欄位都是 INTEGER（新台幣元，無小數位）**，只有 `payslip_items.hours` 是 REAL。這代表：
- 目前系統**沒有分幣（cents）概念**，PostgreSQL 遷移時金額欄位可以直接對應 `INTEGER`/`BIGINT`，
  不需要引入 `NUMERIC`/cents 轉換這類複雜度，除非未來產品需求真的要支援非整數金額。
- `hours` 用 REAL 儲存半小時堂課時數（`duration_slots / 2`，`duration_slots` 是整數，所以 `hours`
  只會是 `0.5` 的倍數，不會有真正的浮點誤差風險，但 PostgreSQL 對應時建議用 `NUMERIC(4,1)` 而不是
  `DOUBLE PRECISION`，避免不必要的浮點運算語意差異）。

### Rounding

- `services/finance.js` 的 `calcSessionPay`/`calcTeacherSalary` 計算過程中金額是 JS number（可能有
  小數，例如 0.5 小時 × 奇數時薪），**不會**在計算階段 round。
- 只有在寫入 `payslip_items`/`payslips` 時才 `Math.round()`（`routes/payslips.js` 的
  `Math.round(total)`、`Math.round(i.pay)`），也就是「試算階段可能顯示小數，正式開立才四捨五入定案」。
  Wave 3A **沒有**改動這個行為，只是把 SQL 位置搬動，rounding 時機與方式完全一致。
- `tuition_records`/`invoices`/`ledger_entries` 相關金額目前**沒有**看到任何 rounding 呼叫——這些金額
  來自 `unit_price`（本身就是整數輸入）加總，不會產生小數，所以不需要 round，這不是遺漏。

### SUM / NULL Behavior

- `financeRepository.findLedgerSummaryRows` 用 `SUM(amount) GROUP BY entry_type, category`。SQLite
  的 `SUM()` 對於「該分組完全沒有符合條件的列」不會出現在結果裡（不是回傳 0 的 row），這跟目前
  route 的處理方式一致（`rows.filter(...).reduce(...)`，沒有列就是加總 0，行為正確）。PostgreSQL 的
  `SUM()` 語意相同，這裡遷移風險低。
- `ledger_entries.amount` 是 `NOT NULL`，schema 沒有允許 NULL，遷移到 PostgreSQL 維持 `NOT NULL`
  沒有語意落差。

### Date / Month Representation

- `invoices.issued_date`/`payslips.issued_date`：`DATE`（`date('now')` 預設，格式 `YYYY-MM-DD`）。
- `tuition_records.month`：**TEXT**，格式 `'YYYY-MM'`（不是真正的 DATE 型別，只是字串），
  `services/finance.js` 的 `monthRange()`/`shiftMonth()` 純用字串切割與加減運算這個「月份字串」，
  沒有依賴 SQLite 的 date 函式做月份運算。PostgreSQL 遷移時這個「月份用字串表示」的慣例可以直接沿用
  （`TEXT` 對應 `TEXT`/`VARCHAR`），或者改用 PostgreSQL 的 `DATE`（每月固定存第一天）── 這是 Phase 1C
  的設計決策，Wave 3A 不建議現在改，因為 `UNIQUE (student_id, month)` 這個 constraint 現在是綁在字串
  相等比對上，改型別要一併確認 constraint 語意不變。
- `ledger_entries.entry_date`：`TEXT NOT NULL`（沒有 DEFAULT，由呼叫端提供，可能是使用者輸入的日期或
  `invoices/payslips.issued_date` 帶過來的值）。

### Unique Constraints

- `invoice_items.session_id UNIQUE`、`payslip_items.session_id UNIQUE`：這是「每堂課只能被開立一次」
  業務規則的資料庫層防線（route 層有先查後寫的邏輯，但 UNIQUE constraint 是最後一道防線，見
  `docs/FINANCE_TRANSACTION_INVENTORY.md` 的併發風險分析）。PostgreSQL 對應 `UNIQUE` 語法完全相同。
- `tuition_records UNIQUE (student_id, month)`：同理，PostgreSQL 相容。

### Foreign Keys

- `ledger_entries` 對 `invoices`/`payslips`/`students`/`teachers` 全部是 `ON DELETE SET NULL`
  （不是 CASCADE）——這是刻意設計：業務邏輯用應用層 `DELETE FROM ledger_entries WHERE
  related_invoice_id = ?` 先手動清除相關 ledger，而不是依賴 FK CASCADE 自動處理，PostgreSQL 遷移時
  這個「應用層先清除、FK 只是保險」的模式要維持一致，不要因為 PostgreSQL 支援更靈活的 CASCADE 選項
  就順手改掉語意。
- `invoice_items`/`payslip_items` 對 `invoices`/`payslips` 是 `ON DELETE CASCADE`，這個沒問題，
  PostgreSQL 語法相同。

### Transaction Assumptions（Wave 3B 待處理，先記錄現況）

Invoice/Payslip 的建立與刪除目前**完全沒有** transaction 保護（見
`docs/FINANCE_TRANSACTION_INVENTORY.md` 的詳細分析）。Phase 1C 遷移到 PostgreSQL 時，如果 Wave 3B
還沒把這些操作包成 repository 自帶 transaction 的方法，遷移後的 async transaction（見本文件開頭
「Transaction 語意」段落）**必須**同時解決這個問題，不能延續「沒有 transaction 保護」的現況——
PostgreSQL 環境下網路延遲更容易放大「invoice 建立成功但 items 寫入中途失敗」的機率。

## 待補充（後續 Wave）

- Wave 4（cross-cutting）：`auth.js`（LINE Login upsert）、`inviteCodes.js`、`notes.js`、`trash.js` 的
  SQLite 特定行為。
- Wave 3B：Invoice/Payslip transaction 化後，補充實際採用的 transaction 設計對 Phase 1C 的影響。
