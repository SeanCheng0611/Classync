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

## 統計方式說明（Wave 2.1 起）

Phase 1B 的 KPI 是 **application-layer（routes/services/auth）的直接 SQL 存取數**，不是 repository
本身的 SQL 數量（repository 裡的 SQL 是預期、合法存在的，不算「散落」）。因此以下分開回報：

```text
Application-layer direct SQL（routes + services + auth，扣掉 repositories/db）: 94
Repository-layer SQL（8 個既有 repository + auditLogs.repository.js 合計，都是預期合法存在）: 79
```

`auditLogs.repository.js` 的 2 處 SQL 是這個 Wave 新增的 cross-cutting infra，**不算 architecture
regression**——它本來就該在 repository 裡，符合 Completion Gate。

## 直接存取 db 的檔案（Wave 2.1 之後現況，application layer）

| 檔案 | 次數 | Domain / 備註 |
|---|---:|---|
| server/src/db/index.js | 26 | schema 建置 + migration，infra 層，不算「散落」 |
| server/src/services/trash.js | 18 | Wave 4（cross-cutting） |
| server/src/routes/notes.js | 17 | Wave 4（cross-cutting） |
| server/src/routes/payslips.js | 13 | Wave 3（finance） |
| server/src/routes/finance.js | 11 | Wave 3（finance） |
| server/src/routes/invoices.js | 11 | Wave 3（finance） |
| server/src/routes/inviteCodes.js | 7 | Wave 4（cross-cutting，含 memberships insert，需與 memberships.repository 協調） |
| server/src/services/finance.js | 5 | Wave 3（finance） |
| server/src/routes/students.js | 4 | 僅 `tuition`/`sessions` 子路由，Wave 3（finance：`tuition_records`） |
| server/src/routes/auth.js | 4 | Wave 4（cross-cutting，LINE Login upsert） |
| server/src/routes/trash.js | 3 | Wave 4（cross-cutting） |
| server/src/routes/dev.js | 1 | 開發用假登入輔助路由，Wave 4 可能整條淘汰 |

共 12 個非 infra/repository 檔案、94 處直接 SQL 呼叫。

`server/src/routes/attendance.js` 與 `server/src/services/attendance.service.js` 都**沒有**任何
`db.prepare`/`db.exec`。`attendance.service.js` 用 `runInTransaction`（從 `repositories/index.js` 轉出）
組合 `attendanceRepository` 與 `schedulingRepository` 的呼叫（撤銷點名要同時改 `attendance_records` 與
`class_sessions`），這是允許的例外（transaction orchestration，不是直接 SQL），符合 Completion Gate。

## Wave 進度

| Wave | 範圍 | 移動 SQL | 累計剩餘（application-layer） |
|---|---|---:|---:|
| 起點 | — | — | 218 |
| Wave 1 | students / teachers / schools / memberships | 76 | 142 |
| Wave 2 | scheduleTemplates / sessions / seats / attendance | 46 | 96 |
| Wave 2.1 | Admin Mode + Audit Log infra（新功能，非既有 SQL 搬遷）+ attendance transaction ownership 修正 | 2（attendance.js 的 runInTransaction 呼叫搬進 service） | 94 |
| Wave 3（待進行） | finance / invoices / payslips | — | — |
| Wave 4（待進行） | auth / inviteCodes / notes / trash / dev | — | — |

## 目標（Wave 4 完成後）

```text
routes: 0
services: 0
auth: 0
repositories/db: expected SQL only
```
