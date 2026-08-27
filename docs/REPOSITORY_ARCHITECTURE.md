# Repository Architecture

Phase 1B 引入的 Persistence Boundary 說明。目標：Application Logic 只知道「我要取得學生」
「我要儲存課程」，不知道「SELECT ...」「SQLite」「PRAGMA」。

## Dependency Rule

```text
Route → Service → Repository → DB
```

- Route、Service、`auth/` 不得 `import { db } from '../db/index.js'`，也不得 `db.prepare(...)` / `db.exec(...)`。
- 唯一例外：`db/` 本身（schema 建置、migration）與 `repositories/` 本身。
- 目前尚未完成全部 domain（見 `docs/PERSISTENCE_INVENTORY.md` 的 Wave 進度），未搬遷的檔案暫時仍直接使用 `db`，
  這是明確記錄的技術債，不是默默保留。

## Repository Responsibilities

- 撰寫/執行 SQL。
- Row ↔ Application 物件的欄位命名轉換（例如 DB 的 `snake_case` 對應到方法參數用 `camelCase`）。
- JSON-as-TEXT 欄位的 serialize/deserialize（例如 `subjects`、`flexible_schedule`）。
- 不決定業務規則、不決定 HTTP 狀態碼、不做跨 repository 的 orchestration。

Repository API 範例（`students.repository.js`）：

```js
studentsRepository.findAllBySchool(schoolId)
studentsRepository.findById(schoolId, id)
studentsRepository.findByName(schoolId, name, excludeId)
studentsRepository.create({ id, schoolId, name, ... })
studentsRepository.update(id, { name, ... })
studentsRepository.delete(schoolId, id)
```

不會出現 `executeQuery` / `prepare` / `getSqliteRow` 這類洩漏底層實作的方法名稱。

## Service Responsibilities

- Business rule、計算、跨 repository 的 orchestration（例如 Wave 2 之後的 `SessionService`）。
- 目前 `services/` 內尚未完成 repository 化的部分（`trash.js`、`finance.js`、`sessions.js`、`conflicts.js`）
  仍直接使用 `db`，屬於 Wave 2/3/4 待辦。

## Route Responsibilities

- HTTP 輸入/輸出、request parsing、status code、掛 auth middleware。
- 目前 KPI 是移除 direct database access，不強求同時重寫成理想的 thin controller——
  例如 `routes/schools.js` 裡的欄位驗證（時間格式、數字範圍）仍留在 route 層，這是刻意的最小改動範圍。

## Composition Root

`server/src/repositories/index.js` 統一 export 所有 repository instance：

```js
export { studentsRepository } from './students.repository.js';
export { teachersRepository } from './teachers.repository.js';
// ...
```

呼叫端一律：

```js
import { studentsRepository } from '../repositories/index.js';
```

不直接 import 個別 repository 檔案。Phase 1C 若要替換成 PostgreSQL 實作，只需要在這個檔案替換 export 來源。

## Transaction Boundary

目前沿用 `db/index.js` 既有的 `runInTransaction(fn)`（同步 `BEGIN`/`COMMIT`/`ROLLBACK`，`node:sqlite`
的 `DatabaseSync` 沒有 `better-sqlite3` 那種 `db.transaction()` helper，手動包一層）。Wave 1 涉及的
domain（students/teachers/schools/memberships）沒有需要跨 repository atomic 的 use case，沒有引入額外
抽象。Wave 3B（finance：invoice/payslip create + delete）是第一個真正需要「transaction 內橫跨
repository 之外的 service（`trash.js`）」的 use case，見下方「Finance Transaction Boundary（Wave
3B）」——驗證後的結論是：**不需要**額外的 `transactionManager`/`withTransaction` 包裝，`runInTransaction`
搭配「transaction ownership 上移到 service 層」就足以覆蓋這個需求，維持不 overengineer 的原則。

## 為什麼不做 Generic Repository

刻意不建立 `BaseRepository` / `find(table, ...)` 這類抽象。理由：

1. 這種抽象只是把 SQL 包一層，沒有真正表達「Application 想做什麼」。
2. PostgreSQL 的語意（例如 `RETURNING`、async client）跟 SQLite 不同，generic CRUD 包裝反而會把
   底層差異隱性洩漏到呼叫端，Phase 1C 遷移時更難處理。

## 現況（Wave 3B 完成後）

已完成 repository 化：`students`、`teachers`、`schools`、`memberships`、`users`（Wave 1），
`scheduling`（`schedule_templates`/`template_students`/`class_sessions`/`session_students`）、
`attendance`、`seats`（Wave 2），`auditLogs`（Wave 2.1），`finance`（`ledger_entries`、
`tuition_records` 完整 CRUD；`invoices`/`payslips` 唯讀 + Wave 3B 補上的細粒度 write 方法）。

`routes/invoices.js`、`routes/payslips.js` 在 Wave 3B 之後**完全不含**直接 SQL，POST/DELETE 都改呼叫
`services/finance.js` 的 transaction-owning function。

尚未完成（見 `docs/PERSISTENCE_INVENTORY.md`）：cross-cutting（`auth`/`inviteCodes`/`notes`/`trash`，
Wave 4）。

## Finance Repository（Wave 3A）

`finance.repository.js` 涵蓋 `ledger_entries`、`invoice_items`/`invoices`（唯讀）、
`payslip_items`/`payslips`（唯讀）、`tuition_records`，理由跟 Wave 2 的
`scheduling.repository.js` 一樣——這幾張表的讀取高度耦合（收支明細反查繳費單/薪資條明細，
繳費單/薪資條明細又反查課堂），沒有清楚的單一 aggregate 邊界，強行拆開只會讓呼叫端要協調更多物件。

### Finance Read Boundary

Wave 3A 處理了**讀取查詢**（列表、明細、彙總）與**低風險單表 CRUD**（`ledger_entries`、
`tuition_records`，兩者都是單一資料表的寫入，沒有跨表 atomicity 疑慮）。`invoices`/`payslips` 的
建立與刪除因為橫跨兩張表（`invoices`+`invoice_items`、`payslips`+`payslip_items`，刪除還牽涉
`ledger_entries`），Wave 3A 當時刻意留給 Wave 3B。

### Finance Transaction Boundary（Wave 3B）

Wave 3B 補上了 invoice/payslip 的建立與刪除，**transaction ownership 明確歸屬 Application/Service
層**，不是 Route、也不是 Repository：

```text
Route (invoices.js / payslips.js)
  -> HTTP request 解析 + FinanceError -> status code 轉換，不寫任何 SQL
Service (finance.js)
  -> createInvoice / deleteInvoice / createPayslip / deletePayslip
  -> 業務驗證（transaction 外，純讀取）
  -> runInTransaction(() => { 呼叫多個細粒度 repository 方法 + trash.insertTrashRow })
  -> 回傳結果給 route 做 broadcast/audit log
Repository (finance.repository.js)
  -> insertInvoice / insertInvoiceItems / deleteInvoiceLedgerEntries / deleteInvoiceRow（及 payslip 對應方法）
  -> 每個方法只做一件事、一個 SQL statement，不知道「一次開立繳費單」的完整流程，也不自帶 runInTransaction
```

`financeRepository` 之所以不像 Wave 2 的 `scheduling.repository.js`（`createTemplate` 等方法會自己
包 `runInTransaction`）讓寫入方法自帶 transaction，是因為這幾個 finance use case 的 transaction
需要延伸到 `financeRepository` 之外——`services/trash.js` 的 `insertTrashRow`（刪除流程的 trash
capture）。如果讓 repository 自己包 transaction，service 就無法把 trash 寫入納入同一個
transaction，delete 流程就會退回 Wave 3A 記錄的「trash 寫成功、但後面的 DELETE 失敗」不一致風險。
因此這個 Wave 明確把 ownership 上移一層：repository 只負責細粒度、可組合的單一操作，service 負責
組合並圈定 transaction 邊界。

`services/trash.js` 的 `addToTrash()` 也因此被拆成 `insertTrashRow()`（純寫入，不 broadcast，給
transaction 內部用）+ `addToTrash()`（`insertTrashRow` + `broadcastChange`，維持所有既有呼叫端不變）
——這個拆分本身不是 Wave 3B 的核心交付，但是啟用「trash 寫入可以安全放進 finance 的 transaction」
的必要前置修正（原本的 `addToTrash` 會在自己的 INSERT 之後立刻 broadcast，如果被包進一個可能
rollback 的 transaction，會出現「broadcast 已發出但資料其實被回滾」的競態）。

實際的 transaction 內容、rollback 保證、失敗注入測試結果，見
`docs/FINANCE_TRANSACTION_INVENTORY.md`。

### Finance Calculation Ownership

`services/finance.js` 保留所有計算邏輯（薪資試算、學費試算、rollover 計算），完全沒有搬進
repository——repository 只負責回傳 `rate`、`hours`、`records`、`items` 這些原始資料，`Math.round`、
年級對應時薪級距、rollover 往回找邏輯等等全部留在 service，這是刻意維持，不是遺漏。

### Read Model Policy

允許 repository 提供「描述查詢意圖」而非「對應單一 Entity CRUD」的 read model 方法，例如
`findInvoiceableSessionsForStudent`、`findBillableAttendedSessions`、`findLedgerSummaryRows`——
這些方法內部可以包含 JOIN/GROUP BY/聚合，只要它描述的是「要取得什麼資料」而不是業務規則本身
（例如「這堂課算不算已收費」的判斷邏輯留在 service/route，repository 只負責照著條件撈資料）。

### Audit Logging Policy（Finance）

Wave 3A 已對 Finance 內實際處理的 mutation 加 log（ledger create/update/delete/generate-salary/
generate-tuition、invoice.create/delete、payslip.create/delete、tuition_record.upsert/delete）。
Metadata 只記必要資訊（`item_count`、`total`、`created`/`updated` 筆數），不記錄完整
invoice/payslip/学生財務檔案物件，遵守 Wave 2.1 建立的 sensitive-data sanitizer 政策。

Wave 3B 進一步收緊了 invoice/payslip create/delete 這四個 log 呼叫的**時機保證**：route 現在的控制流
是「呼叫 service → 如果拋出 `FinanceError` 就立刻 return 錯誤 response，不執行後面任何程式碼 →
只有 service 正常 return（代表 transaction 已經 commit）才會走到 `logEvent(...)`」。這個順序本身就是
一種結構性保證——不需要額外的「先寫 log 再檢查是否成功」防呆，因為 log 呼叫在程式碼位置上就位於
transaction 成功完成之後，rollback 的路徑（例外拋出）不可能到達 log 呼叫。

## AuditLog Service / Repository（Wave 2.1）

```text
Route（或未來的 Service）
  ↓
AuditLog Service（server/src/services/auditLog.service.js）—— logEvent/logInfo/logWarning/logError/findLogs
  ↓
AuditLog Repository（server/src/repositories/auditLogs.repository.js）—— append/find/deleteOlderThan
  ↓
SQLite（audit_logs 資料表）
```

這是一個 **cross-cutting infrastructure**，跟其他 domain repository 平行存在，不屬於任何 business
domain。詳細 schema、log_type/category 對應、sensitive data 過濾規則見 `docs/LOGGING_ARCHITECTURE.md`，
不在這裡重複。

Wave 2.1 也順便修正了 Wave 2 review 指出的問題：`routes/attendance.js` 的撤銷點名原本直接在 route 裡
呼叫 `runInTransaction` 組合兩個 repository，現在搬進 `server/src/services/attendance.service.js` 的
`revokeAttendance()`。Route 現在只呼叫這一個 service 函式，不再自己知道「要用 transaction」「要一起改
attendance 跟 scheduling 兩個 repository」這些屬於 orchestration 的細節。`setAttendance()`（點名
upsert）也一併搬進同一個 service。

## Scheduling Aggregate Boundary（Wave 2）

`schedule_templates`、`template_students`、`class_sessions`、`session_students` 四張表集中在同一個
`scheduling.repository.js`，因為它們的讀寫高度耦合（樣板展開成課堂、課堂帶學生關聯橫跨四張表），
強行拆成四個 repository 只會讓呼叫端需要協調更多物件，沒有實質的邊界價值。

`seat_assignments`/`seat_students` 獨立成 `seats.repository.js`：座位是「日期＋時段＋桌號」獨立存在的
版面資料，**沒有**外鍵指向 `class_sessions`，跟排課生命週期是平行、非從屬的關係（已用 schema 與 route
行為確認過，不是憑檔名猜的）。

`attendance_records` 獨立成 `attendance.repository.js`：出缺勤是對「課堂」的觀察紀錄，本質上是獨立的
aggregate（有自己的 unique constraint、自己的生命週期），只是外鍵指向 `class_sessions`。

## Session Generation Ownership

「今天需不需要展開 session」「樣板如何展開成課堂」這些業務規則留在 `services/sessions.js`
（`ensureSessionsForDate`/`ensureSessionsForRange`），沒有搬進 repository。Repository
（`scheduling.repository.js`）只提供：

- `findTemplatesActiveOnDate` — 給定日期/星期，回傳候選樣板（「哪些樣板生效中」是簡單的日期比對查詢，
  不是業務規則）
- `findSessionByTemplateAndDate` — 該樣板這天是否已展開過
- `createSessionFromTemplate` — 建立一筆 session + 從 template_students 複製學生關聯（atomic）

「要不要建立」「用哪個樣板建立」的判斷全部在 service 的迴圈裡決定，repository 只執行「建立」這個動作。

## Conflict Detection Ownership

`services/conflicts.js` 保留所有時段重疊判斷（`overlaps()`）、生效區間重疊判斷（`activeRangesOverlap()`）、
以及「這算不算衝堂」的業務規則。Repository 只負責回傳「候選列」（例如同星期、同教師、排除自己正在編輯的
那筆），實際判斷兩個時段是否重疊完全在 service 用 JS 計算，SQL 沒有做任何 overlap 邏輯。這是刻意維持
原本程式碼的做法（原本就是抓全部候選再用 JS filter，不是這次重構才決定的設計）。

## Attendance Persistence Ownership

Repository（`attendance.repository.js`）只負責 CRUD 與查詢。「先確認 session 存在才能點名」
「撤銷點名要連動取消/刪除已排定的調課課堂」這些規則留在 `routes/attendance.js`（Wave 2 沒有新增
獨立的 AttendanceService，因為原本邏輯量不大，硬拆一個 service 檔案效益不高，跟 Wave 1 對
`routes/schools.js` 的處理方式一致——優先移除 DB 存取，不追求每個 domain 都有對應 Service 檔案）。

## Seat Persistence Ownership

`seats.repository.js` 提供 `findOtherSeatsSameSlot`（同時段其他桌的教師/學生佔用狀況）這個查詢，
但「教師/學生是否已被安排在別桌」「每桌最多兩位學生」這些規則判斷留在 `routes/seats.js`。

## Transaction Boundary（Wave 2 更新）

延續 Wave 1 的 `runInTransaction(fn)`。Wave 2 確立的慣例：

1. **多步驟寫入限於單一 repository 內部**（例如「建立樣板 + 設定學生名單」、「建立課堂 + 學生關聯 +
   連結請假紀錄」）：repository method 自己呼叫 `runInTransaction` 包起來，呼叫端只呼叫一個方法。
   例：`schedulingRepository.createTemplate(...)`、`createSessions(...)`、`updateTemplate(...)`、
   `updateSession(...)`。
2. **橫跨兩個不同 repository 的操作**（例如撤銷點名要同時改 `attendance_records` 與 `class_sessions`）：
   `runInTransaction` 從 `repositories/index.js` 轉出，呼叫端（route）自己包一個 transaction，組合呼叫
   兩邊「不自帶 transaction」的方法。目前只有 `routes/attendance.js` 的 DELETE 用到這個模式。
3. **絕對不要巢狀 `runInTransaction`**：`node:sqlite` 的 `DatabaseSync` 不支援巢狀 `BEGIN`。這是為什麼
   repository 的「複合方法」（例如 `updateTemplate`）內部呼叫的都是不自帶 transaction 的私有 helper
   （例如模組內部的 `setTemplateStudents`），不是另一個會自己開 transaction 的 public 方法。

Wave 2 完成後已經對 rollback 做過實際驗證（見 Wave 2 完成報告），不是只停留在理論設計。

## 已知技術債（Wave 2 記錄）

- `routes/attendance.js` 的點名 upsert（POST）是「先 SELECT 是否存在、再決定 INSERT 或 UPDATE」，
  在高併發下理論上有極小的競態窗口（跟 Wave 1 前的原始程式碼行為完全一致，Phase 1B 不修正既有的
  並發行為，只搬 SQL 位置）。
- Session 的 JSON 欄位目前沒有（`class_sessions`/`schedule_templates` 本身沒有 JSON-as-TEXT 欄位，
  這點跟 Wave 1 的 `schools`/`teachers` 不同，所以 Wave 2 沒有繼承 Wave 1 「JSON deserialize 留在 route」
  的技術債）。
