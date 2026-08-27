# Persistence Inventory

Phase 0 建立時是純盤點；Phase 1B 逐步把直接 SQL 存取收斂進 `server/src/repositories/`，
Wave 4 完成後 **application layer（routes/services/auth/middleware）直接 SQL = 0**，
Phase 1B 的 Persistence Boundary 目標達成。這份文件記錄最終狀態，供 Phase 1C（PostgreSQL 遷移）
與後續 Phase 對照使用。

## 資料庫實作

- 純 `node:sqlite`（Node 內建，非 better-sqlite3），見 [server/src/db/index.js](../server/src/db/index.js)。
- 無 ORM、無 query builder。
- Schema 定義在 [server/src/db/schema.sql](../server/src/db/schema.sql)；既有資料庫的欄位新增/表格重建則用一系列
  `ensureColumn(...)` 與手動 table rebuild，在開機時執行（`db/index.js`）。這是目前唯一的 migration 機制，
  Phase 1B 不改寫，留給 Phase 1C。
- `DATABASE_PATH` 環境變數可覆蓋預設 DB 位置（Wave 1 新增），方便測試環境用獨立 SQLite 檔案，不影響
  production 預設行為。

## Repository Layer（Phase 1B 完成後全貌）

`server/src/repositories/`，composition root 在 `index.js`（同時轉出 `runInTransaction`，見
`REPOSITORY_ARCHITECTURE.md` 的 Transaction Boundary 說明）。

| Repository | 涵蓋資料表 | Wave |
|---|---|---|
| `students.repository.js` | `students` | 1 |
| `teachers.repository.js` | `teachers` | 1 |
| `schools.repository.js` | `schools`（含各項 school-scoped 設定欄位） | 1 / 4 |
| `memberships.repository.js` | `memberships`（含 join `users`/`schools`） | 1 / 4 |
| `users.repository.js` | `users`（含 LINE 登入 upsert 需要的讀寫） | 1 / 4 |
| `scheduling.repository.js` | `schedule_templates`, `template_students`, `class_sessions`, `session_students` | 2 |
| `attendance.repository.js` | `attendance_records` | 2 |
| `seats.repository.js` | `seat_assignments`, `seat_students` | 2 |
| `auditLogs.repository.js` | `audit_logs`（cross-cutting infra，不屬於任何 business domain） | 2.1 |
| `finance.repository.js` | `ledger_entries`, `invoices`/`invoice_items`, `payslips`/`payslip_items`, `tuition_records` | 3A / 3B |
| `notes.repository.js` | `notes` | 4 |
| `inviteCodes.repository.js` | `invite_codes` | 4 |
| `trash.repository.js` | `trash` + 泛用的跨表 snapshot capture/restore 存取（見下方「Trash Repository 的特殊性」） | 4 |

**Repository-layer SQL 總計（14 個 repository 合計，都是預期合法存在）：136**
**`db/index.js`（schema/migration infra）：25**

## 統計方式說明

Phase 1B 的 KPI 是 **application-layer（routes/services/auth/middleware）的直接 SQL 存取數**，不是
repository 本身的 SQL 數量（repository 裡的 SQL 是預期、合法存在的，不算「散落」）。統計方式固定為
`grep -c "db\.prepare\|db\.exec"` 逐檔精確計數，排除 `repositories/`、`db/` 兩個目錄。

```text
Application-layer direct SQL（routes + services + auth + middleware）: 0
Repository-layer SQL（14 個 repository 合計，都是預期合法存在）: 136
db/index.js（schema/migration infra）: 25
```

## Trash Repository 的特殊性

`trash.repository.js` 是唯一一個帶有「泛用、依表名參數化」方法（`findRowsByColumn(table, column,
value)`、`findRowById(table, id)`、`insertRow(table, row)`）的 repository。這不是 Section 25/74 禁止的
「Generic Repository」（例如 `find(table, ...)` 給所有 domain 共用），而是 Trash 這個 domain 自己的
persistence 需求——刪除任何實體前都要把它（與它牽連的子資料）序列化存起來、還原時再逐表插回去，這件事
本質上就是跨表的。呼叫端（`services/trash.js` 的 `capture*`/`RESTORE_HANDLERS`）永遠傳入寫死在程式碼裡
的表名/欄位名常數，從未來自使用者輸入，不是 SQL injection 風險，也不會被其他 domain 拿去當通用查詢介面
使用。詳見 `docs/REPOSITORY_ARCHITECTURE.md` 的 Trash Persistence Boundary 段落。

## Wave 4 完成明細

| 檔案 | Wave 3B 後次數 | 去向 |
|---|---:|---|
| `services/trash.js` | 16 | 全部移進 `trash.repository.js`；service 層改為呼叫 repository + 一個新的 transaction-owning `restoreTrashEntry`（見下） |
| `routes/notes.js` | 15 | 全部移進 `notes.repository.js`（含分類批次改寫，repository-local transaction）+ `schoolsRepository.updateRemovedDefaultCategories` |
| `routes/inviteCodes.js` | 7 | 全部移進 `inviteCodes.repository.js`；`/redeem` 的膜拜 membership+invite 寫入改由新的 `services/invites.js` 用單一 transaction 完成（Wave 4 修正的 atomicity gap，見下） |
| `routes/auth.js` | 4 | `upsertLineUser` 移進 `services/auth.js`（呼叫 `usersRepository`），`/me` 的 membership+school join 移進 `membershipsRepository.findForUserWithSchool` |
| `routes/trash.js` | 3 | 全部移進 `trash.repository.js`；還原流程改呼叫 `services/trash.js` 的 `restoreTrashEntry`（transaction-owning，見下） |
| `routes/dev.js` | 1 | 移進 `schoolsRepository.deleteAll()` |

**Wave 4 移動：46 → 0**

## 已修正的 Atomicity Gap（Wave 4 審計中發現）

1. **Trash Restore 原本不是 atomic**：`routes/trash.js` 的還原流程原本是「呼叫 `restoreEntity`（自己
   對 `schedule_template` 類型內部包一個 transaction）→ 回到 route 再單獨執行一次
   `DELETE FROM trash`」，這兩步之間如果第二步失敗，會留下「資料已還原、但 trash 列還在」的不一致
   （使用者理論上可以對同一筆 trash 再按一次還原，造成重複插入）。Wave 4 移除了 `insertSnapshot`/
   `schedule_template` handler 自帶的 `runInTransaction`，改由新的 `services/trash.js` 的
   `restoreTrashEntry(schoolId, trashId)` 把「讀 trash 列 → 依 entity_type 還原 → 刪掉 trash 列」整個
   包在同一個 transaction 內，任何一步失敗都會完整回滾。已用失敗注入測試驗證（monkeypatch
   `trashRepository.insertRow` 強制拋出例外，確認樣板沒有被部分插回、trash 列也還在）。
2. **邀請碼兌換（`/redeem`）原本沒有 transaction**：membership upsert 與 `invite_codes.used_at`
   標記是兩個獨立的 `db.prepare` 呼叫，中途失敗會留下「membership 已建立但邀請碼還能被重複兌換」或
   「邀請碼已標記用掉但使用者其實沒加入」的不一致。Wave 4 移進 `services/invites.js` 的
   `redeemInviteCode`，用一個 `runInTransaction` 包住兩步寫入。已用失敗注入測試驗證。

兩者都不是本 Wave 新增的風險，而是既有程式碼裡原本就存在、隨著這次全面盤點才被發現並修正的缺口——
修正前後的 API path/method/status code/response shape 完全不變，只是內部多了 transaction 保護。

## Wave 進度（完整歷史）

| Wave | 範圍 | 移動 SQL | 累計剩餘（application-layer） |
|---|---|---:|---:|
| 起點 | — | — | 218 |
| Wave 1 | students / teachers / schools / memberships | 76 | 142 |
| Wave 2 | scheduleTemplates / sessions / seats / attendance | 46 | 96 |
| Wave 2.1 | Admin Mode + Audit Log infra + attendance transaction ownership 修正 | 2 | 94 |
| Wave 3A | Finance read models + 低風險 CRUD（ledger、tuition_records）+ students.js/finance.js 殘留清理 | 23（估算） | 71（估算） |
| Wave 3B | Invoice/Payslip 跨表 atomic transaction（POST/DELETE 兩個 route 全部改用 service transaction） | 19（精確計數起） | 46 |
| Wave 4 | auth / inviteCodes / notes / trash / dev 全面清理 + trash/invite atomicity 修正 + finance UNIQUE race 500→409 | 46 | **0** |

Wave 3A 移動明細：`services/finance.js`（全部計算邏輯改呼叫 repository）、`routes/finance.js`
（ledger CRUD + summary + generate-salary/tuition，11 處全移）、`routes/students.js`
（tuition_records CRUD + 殘留的 class_sessions 查詢，4 處全移）、`routes/invoices.js` 與
`routes/payslips.js` 的 GET 系列（各自 2 處與 3 處，POST/DELETE 刻意保留給 Wave 3B）。

Wave 3B 移動明細：`routes/invoices.js` 的 POST（9 處）與 `routes/payslips.js` 的 POST/DELETE
（10 處）全部改由 `services/finance.js` 新增的 `createInvoice`/`deleteInvoice`/`createPayslip`/
`deletePayslip` 取代。

## Phase 1B 完成狀態

```text
routes:      direct DB access = 0
services:    direct DB access = 0
auth:        direct DB access = 0
middleware:  direct DB access = 0
repositories/db: expected SQL only（136 + 25）
```

見 `docs/REPOSITORY_ARCHITECTURE.md` 的完整架構說明與 Phase 1B 完成報告（本文件底部連結）。
