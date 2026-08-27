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
| `nanoid()` 產生 ID（Node.js 端，非 DB） | 各 repository 的 `create()` 呼叫端（Route 或 Service，見「ID Generation Convention」） | 不受 DB 影響，維持現狀 |
| `datetime('now', '-N days')` 相對時間運算 | `trash.repository.js` 的 `deleteExpired`（trash retention）、`auditLogs.repository.js` 的 `deleteOlderThan` | PostgreSQL 用 `now() - interval 'N days'`，語法不同但語意等價 |
| 動態表名字串拼接（`` `SELECT * FROM ${table} WHERE ...` ``） | `trash.repository.js`（見 `docs/PERSISTENCE_INVENTORY.md` 的「Trash Repository 的特殊性」） | PostgreSQL 的 prepared statement 也不能對表名做參數綁定，一樣需要字串拼接；因為表名永遠是程式碼常數（不是使用者輸入），沒有 injection 風險，遷移時可以照搬同樣的寫法，只需要確認每個被拼接的表名在 PostgreSQL schema 裡存在 |
| `ERR_SQLITE_ERROR` + 錯誤訊息字串比對辨識 constraint 種類 | `services/finance.js` 的 `isDuplicateSessionConstraint`（Wave 4，見 `docs/FINANCE_TRANSACTION_INVENTORY.md` 的 Finance Duplicate Race） | PostgreSQL 的 `pg` client 對 constraint violation 有結構化的 `error.code`（例如 `23505` = unique_violation）與 `error.constraint`（約束名稱），比 SQLite 目前用字串 `includes()` 比對訊息文字更可靠；遷移時建議改用 `error.code === '23505' && error.constraint === '<known constraint name>'`，這是一個遷移時的**改善機會**，不是阻塞項 |

## ID Generation Convention（現況記錄，Phase 1B 未更動）

目前 ID 由 **Route 層**在呼叫 repository `create()` 之前用 `nanoid()` 產生，再作為參數傳入
（例如 `students.js` 的 `const id = nanoid(); studentsRepository.create({ id, ... })`）。
這不是 Phase 1B 建議的理想慣例（理想是 Service 產生），但為了維持 Zero Behavior Change、不在
Repository 抽離的同時又動 ID 產生時機，Wave 1 刻意保持現狀。之後的 Wave 若要統一慣例，會另外記錄
決策，不要求一次改完。

**Wave 4 稽核結果（現況記錄，不強行統一）**：`grep -rn "nanoid()" routes/ services/` 顯示目前是
「ID 產生的位置跟著擁有這段業務邏輯的層走」——多數簡單 CRUD route（`students.js`、`teachers.js`、
`schools.js`、`notes.js`、`inviteCodes.js`、`scheduleTemplates.js`、`sessions.js`、`seats.js`）仍在
Route 層產生 ID，跟 Wave 1 記錄的現狀一致；而 Wave 2.1 之後新增的、真正有 orchestration 邏輯的
Service（`attendance.service.js`、`auditLog.service.js`、`services/finance.js`、`services/auth.js`、
`services/invites.js`、`services/trash.js`、`services/sessions.js`）則是在 Service 內部產生 ID——
這不是刻意規劃的規則，而是「程式碼被搬到 Service 層的同時，ID 產生也自然跟著搬」的結果（例如
Wave 3B 把 invoice/payslip 的建立邏輯整段搬進 `services/finance.js`，原本在 route 裡的
`const invoiceId = nanoid()` 也就一起搬過去了，不是額外的設計決策）。這是一個**已知的不一致**，
沒有造成任何行為問題（每個 create 路徑各自維持自己原本的 ID 產生時機，Zero Behavior Change），
Phase 1B 不強行統一成單一慣例；如果未來要統一，建議方向是「ID 產生跟著 create 操作本身，統一放在
Service 層（沒有 Service 的簡單 CRUD 則留在 Route）」，但這是留給後續 Phase 的決定，不是本 Wave
的阻塞項。

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

### Transaction Assumptions（Wave 3B 已完成，記錄現況供 Phase 1C 參考）

Invoice/Payslip 的建立與刪除在 Wave 3B 已經有完整 transaction 保護（見
`docs/FINANCE_TRANSACTION_INVENTORY.md`），但 ownership 位置對 Phase 1C 的 async 化有直接影響，
記錄如下：

- transaction ownership 在 **Service 層**（`services/finance.js`），不是 repository 方法自帶——
  跟 Wave 2 開頭「Transaction 語意」段落記錄的「PostgreSQL 版本的 repository method 可能需要接收
  `client`/`tx` 參數」規劃**完全吻合**：Wave 3B 的 `runInTransaction(() => { ...組合呼叫多個
  repository 方法... })` 這個 pattern，換成 PostgreSQL 版本時，最自然的作法就是把 `runInTransaction`
  改成 async、把借來的 pool client 透過某種 context 傳給 callback 內呼叫的每個 repository 方法。因為
  Wave 3B 的 service function（`createInvoice`/`deleteInvoice`/`createPayslip`/`deletePayslip`）已經
  把「呼叫哪些 repository 方法、順序為何」明確攤平寫在一個函式裡（不是藏在某個 repository 的
  巨型方法內），Phase 1C 遷移時只需要改 `runInTransaction` 的實作與這些 repository 方法的簽名
  （加上可選的 `client` 參數），呼叫端的邏輯結構不需要重寫。
- `BEGIN`/`COMMIT`/`ROLLBACK` 映射：目前 `runInTransaction` 是同步呼叫 `db.exec('BEGIN')` /
  `db.exec('COMMIT')` / `db.exec('ROLLBACK')`（`node:sqlite` 單一全域連線）。PostgreSQL 版本這三個
  操作都要在**同一個借來的 pool client** 上執行（`client.query('BEGIN')` 等），且都是 async，
  呼叫端全部要改成 `await`。Wave 3B 的四個 service function 目前是同步函式，遷移後會變成 async
  函式，連帶 `routes/invoices.js`/`routes/payslips.js` 的 handler 也要改成 `async (req, res) => {...}`
  並 `await` service 呼叫——這是 Phase 1C 的範圍，Wave 3B 沒有提前做。
- Isolation level 考量：目前 SQLite 的 `BEGIN` 是預設的 deferred transaction，配合 Wave 3B 的作法
  （先在 transaction 外做完所有唯讀驗證，transaction 內只做確定要寫入的操作），實際上把「檢查 -
  寫入」的競態窗口壓縮到很小，但沒有消除（見 `FINANCE_TRANSACTION_INVENTORY.md` 的「Remaining
  concurrency risk」）。PostgreSQL 預設 isolation level 是 `READ COMMITTED`，跟 SQLite 的行為不完全
  對等；如果 Phase 1C 想徹底消除 Wave 3B 記錄的「UNIQUE constraint race 導致 500 而非 409」這個殘餘
  風險，可以考慮把 create invoice/payslip 的 transaction 提升到 `SERIALIZABLE`（會增加重試邏輯的
  複雜度）——這是留給 Phase 1C 決定是否值得做的取捨，Wave 3B 不做決定，只記錄現況與選項。
- Rollback 語意本身（例外拋出 → 整個 transaction 內的寫入全部復原）在 SQLite 與 PostgreSQL 之間預期
  一致，Wave 3B 的失敗注入測試方法論（monkeypatch repository 方法拋出例外、驗證資料庫行數沒有變化）
  可以直接沿用到 Phase 1C 遷移後的 regression test，不需要重新設計測試策略，只需要把測試從同步呼叫
  改成 `await`。

## Wave 4 — Persistence Boundary 封板

Wave 4 完成了剩餘 domain（`auth`/`inviteCodes`/`notes`/`trash`/`dev`）的 repository 化，
`routes`/`services`/`auth`/`middleware` 的直接 SQL 降到 0（見 `docs/PERSISTENCE_INVENTORY.md`）。
對 PostgreSQL 遷移的影響：

### Trash 的動態表名拼接

見上方 SQLite-specific Constructs Inventory 表格。這是唯一一個遷移後**寫法不會變**的地方
（PostgreSQL 一樣不支援對表名做 parameter binding），但建議 Phase 1C 順便加一層表名白名單檢查
（雖然目前所有呼叫端都是常數，多一層防呆不會壞事，且不影響行為）。

### 沒有新的 JSON-as-TEXT 欄位

`notes.categories`、`trash.payload`/`trash.related_student_ids` 都是既有欄位（Wave 1 前就存在的
schema），Wave 4 只是把讀寫這些欄位的 SQL 搬進 repository，沒有新增欄位、沒有改變 JSON 欄位的
序列化方式。

### Restore 機制的 transaction 語意

`services/trash.js` 的 `restoreTrashEntry` 是 Wave 4 新增的、涉及「讀取多筆 → 動態插入多張表 →
刪除一筆」的 transaction，PostgreSQL 化時遵循跟 Wave 3B 的 finance transaction 完全相同的模式
（見上方 Transaction Assumptions 段落），沒有引入新的遷移複雜度。

### Finance Duplicate Race 的錯誤辨識方式

見上方表格新增的一列：目前用 `err.code === 'ERR_SQLITE_ERROR'` + 訊息字串 `includes()` 比對，
PostgreSQL 遷移時建議改用結構化的 `error.code`/`error.constraint`（`pg` client 提供），這是遷移時的
改善機會，記錄在此供 Phase 1C 參考，不在 Wave 4 範圍內處理。

## 待補充（後續 Phase）

- Phase 1C 開始 PostgreSQL 遷移時，逐一驗證本文件記錄的每一項差異（尤其是 Timestamp 格式、
  Transaction 語意、Unique/FK constraint 錯誤訊息格式）在真實 PostgreSQL 環境下的行為，
  不能只靠這份文件的記錄就假設遷移會順利。
- Wave 3B：Invoice/Payslip transaction 化後，補充實際採用的 transaction 設計對 Phase 1C 的影響。
