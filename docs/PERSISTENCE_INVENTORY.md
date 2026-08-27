# Persistence Inventory

Phase 0 建立時是純盤點；Phase 1B 開始逐步把直接 SQL 存取收斂進 `server/src/repositories/`。
這份文件記錄目前進度，供後續 Wave 與 Phase 1C（PostgreSQL 遷移）對照使用。

## 資料庫實作

- 純 `node:sqlite`（Node 內建，非 better-sqlite3），見 [server/src/db/index.js](../server/src/db/index.js)。
- 無 ORM、無 query builder。
- Schema 定義在 [server/src/db/schema.sql](../server/src/db/schema.sql)；既有資料庫的欄位新增/表格重建則用一系列
  `ensureColumn(...)` 與手動 table rebuild，在開機時執行（`db/index.js`）。這是目前唯一的 migration 機制，
  Phase 1B 不改寫，留給 Phase 1C。
- `DATABASE_PATH` 環境變數可覆蓋預設 DB 位置（Wave 1 新增），方便測試環境用獨立 SQLite 檔案，不影響
  production 預設行為。

## Repository Layer

`server/src/repositories/`，composition root 在 `index.js`（同時轉出 `runInTransaction`，見
`REPOSITORY_ARCHITECTURE.md` 的 Transaction Boundary 說明）。

| Repository | 涵蓋資料表 | Wave |
|---|---|---|
| `students.repository.js` | `students` | 1 |
| `teachers.repository.js` | `teachers` | 1 |
| `schools.repository.js` | `schools` | 1 |
| `memberships.repository.js` | `memberships`（含 join `users`） | 1 |
| `users.repository.js` | `users`（最小讀取集合） | 1 |
| `scheduling.repository.js` | `schedule_templates`, `template_students`, `class_sessions`, `session_students` | 2 |
| `attendance.repository.js` | `attendance_records` | 2 |
| `seats.repository.js` | `seat_assignments`, `seat_students` | 2 |
| `auditLogs.repository.js` | `audit_logs`（cross-cutting infra，不屬於任何 business domain） | 2.1 |
| `finance.repository.js` | `ledger_entries`, `invoices`/`invoice_items`, `payslips`/`payslip_items`, `tuition_records`（Wave 3A 唯讀 + Wave 3B 補上細粒度 write 方法） | 3A / 3B |

## 統計方式說明（Wave 2.1 起）

Phase 1B 的 KPI 是 **application-layer（routes/services/auth）的直接 SQL 存取數**，不是 repository
本身的 SQL 數量（repository 裡的 SQL 是預期、合法存在的，不算「散落」）。

```text
Application-layer direct SQL（routes + services + auth，扣掉 repositories/db）: 46
Repository-layer SQL（10 個 repository 合計，都是預期合法存在）: 118
db/index.js（schema/migration infra）: 26
```

（Wave 3B 起改用 `grep -c "db\.prepare\|db\.exec"` 逐檔精確計數，取代先前的估算數字；上一輪 Wave 3A
記錄的 71 是估算值，跟這次的精確重新計算方式不完全一致，這裡改以精確計數為準，往後 Wave 沿用同一方式。）

## 直接存取 db 的檔案（Wave 3B 之後現況，application layer）

| 檔案 | 次數 | Domain / 備註 |
|---|---:|---|
| server/src/services/trash.js | 16 | Wave 4（cross-cutting） |
| server/src/routes/notes.js | 15 | Wave 4（cross-cutting） |
| server/src/routes/inviteCodes.js | 7 | Wave 4（cross-cutting，含 memberships insert，需與 memberships.repository 協調） |
| server/src/routes/auth.js | 4 | Wave 4（cross-cutting，LINE Login upsert） |
| server/src/routes/trash.js | 3 | Wave 4（cross-cutting） |
| server/src/routes/dev.js | 1 | 開發用假登入輔助路由，Wave 4 可能整條淘汰 |

共 6 個非 infra/repository 檔案、46 處直接 SQL 呼叫。

`server/src/routes/invoices.js`、`server/src/routes/payslips.js` **在 Wave 3B 之後也已經沒有任何**
直接 SQL——POST（create invoice/payslip + items）與 DELETE（invoice/payslip + ledger + trash）全部改由
`services/finance.js` 的 `createInvoice`/`deleteInvoice`/`createPayslip`/`deletePayslip` 在單一
`runInTransaction` 內組合呼叫 `financeRepository` 的細粒度 write 方法完成，見
`docs/FINANCE_TRANSACTION_INVENTORY.md`。

`server/src/services/finance.js`、`server/src/routes/students.js`、`server/src/routes/finance.js`
**都已經沒有任何**直接 SQL——Wave 3A 完成前 `finance.js`（route）11 處、`students.js` 4 處直接 SQL
全部移進 `financeRepository`/`schedulingRepository`。

`server/src/services/attendance.service.js` 使用 `runInTransaction`（從 `repositories/index.js` 轉出）
組合 `attendanceRepository` 與 `schedulingRepository`，**沒有**任何 `db.prepare`/`db.exec`，屬於允許的
transaction orchestration 例外（Wave 2.1 已修正，非本 Wave 新增）。

## Wave 進度

| Wave | 範圍 | 移動 SQL | 累計剩餘（application-layer） |
|---|---|---:|---:|
| 起點 | — | — | 218 |
| Wave 1 | students / teachers / schools / memberships | 76 | 142 |
| Wave 2 | scheduleTemplates / sessions / seats / attendance | 46 | 96 |
| Wave 2.1 | Admin Mode + Audit Log infra + attendance transaction ownership 修正 | 2 | 94 |
| Wave 3A | Finance read models + 低風險 CRUD（ledger、tuition_records）+ students.js/finance.js 殘留清理 | 23（估算） | 71（估算，見上方精確計數說明） |
| Wave 3B | Invoice/Payslip 跨表 atomic transaction（POST/DELETE 兩個 route 全部改用 service transaction） | 19（精確計數） | 46 |
| Wave 4（待進行） | auth / inviteCodes / notes / trash / dev | — | — |

Wave 3A 移動明細：`services/finance.js`（全部計算邏輯改呼叫 repository）、`routes/finance.js`
（ledger CRUD + summary + generate-salary/tuition，11 處全移）、`routes/students.js`
（tuition_records CRUD + 殘留的 class_sessions 查詢，4 處全移）、`routes/invoices.js` 與
`routes/payslips.js` 的 GET 系列（各自 2 處與 3 處，POST/DELETE 刻意保留給 Wave 3B）。

Wave 3B 移動明細：`routes/invoices.js` 的 POST（9 處）與 `routes/payslips.js` 的 POST/DELETE
（10 處）全部改由 `services/finance.js` 新增的 `createInvoice`/`deleteInvoice`/`createPayslip`/
`deletePayslip` 取代，這四個 service function 各自用一個 `runInTransaction` 組合呼叫
`financeRepository` 新增的細粒度 write 方法（`insertInvoice`/`insertInvoiceItems`/
`deleteInvoiceLedgerEntries`/`deleteInvoiceRow` 及 payslip 對應方法）與 `trash.js` 新增的
`insertTrashRow`（transaction-safe，不 broadcast）。兩個 route 檔案現在完全不含 `db.prepare`/
`db.exec`，只呼叫 service + repository。

## 目標（Wave 4 完成後）

```text
routes: 0（Wave 3B 完成前，invoices.js/payslips.js 仍會各剩個位數 SQL，屬已知且有文件記錄的例外）
services: 0
auth: 0
repositories/db: expected SQL only
```
