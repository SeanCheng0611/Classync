# Finance Transaction Inventory

Wave 3A 盤點了 Finance domain 裡跨表、需要 atomic 保證的四個寫入操作（Create/Delete Invoice、
Create/Delete Payslip），當時**沒有**動 transaction boundary。Wave 3B（Financial Atomic
Transactions）完成了這四個操作的 atomic 化，這份文件記錄 Wave 3B 之後的實際狀態。

## 架構總覽

- Transaction ownership 在 **Service 層**（`server/src/services/finance.js`），不在 Route、也不在
  Repository。理由：這四個操作除了 `financeRepository` 之外，還需要協調 `services/trash.js` 的
  `insertTrashRow`（trash capture），單一 repository 方法無法覆蓋跨 repository/service 的寫入範圍，
  見 `docs/REPOSITORY_ARCHITECTURE.md` 的 Finance Transaction Boundary 段落。
- Route（`routes/invoices.js`、`routes/payslips.js`）現在**完全不含** `db.prepare`/`db.exec`，
  只做：解析 request → 呼叫 `financeService.createInvoice(...)` 等 → 把拋出的 `FinanceError`
  轉回原本的 HTTP status/message → 成功才 `broadcastChange` + `logEvent` + 回應。
- `financeRepository` 新增的 write 方法（`insertInvoice`/`insertInvoiceItems`/
  `deleteInvoiceLedgerEntries`/`deleteInvoiceRow` 及 payslip 對應方法）都是單一 SQL statement 的
  細粒度操作，**不**自帶 `runInTransaction`——不像 Wave 2 的 `scheduling.repository.js` 有些方法會
  自己包 transaction，這裡刻意讓 transaction 留在呼叫端（service），因為 service 還要在同一個
  transaction 裡呼叫 `trash.js`。
- `services/trash.js` 的 `addToTrash()` 被拆成 `insertTrashRow()`（純寫入，不 broadcast）+
  `addToTrash()`（`insertTrashRow` + broadcast，給所有其他既有呼叫端維持原行為不變）。Wave 3B 的
  delete 流程一律呼叫 `insertTrashRow`，broadcast 延後到 transaction commit 之後才由 route 觸發，
  避免「transaction 中途 rollback，但 broadcast 已經先發出去通知前端東西被刪了」的不一致。

## Create Invoice

```text
Use case: POST /api/schools/:schoolId/invoices
Service:  server/src/services/finance.js — createInvoice()
```

**Wave 3A 記錄的風險**：items 迴圈中途失敗（例如某堂課被別的請求搶先開立、撞上
`invoice_items.session_id` 的 `UNIQUE` constraint）會留下「invoice 存在但 items 不完整」的孤兒繳費單。

**Transaction owner**：`services/finance.js` 的 `createInvoice()`。

**Atomic writes**：先在 transaction **外**完成所有唯讀驗證（學生存在、逐堂課存在且屬於該學生、
逐堂課尚未開立過），驗證全部通過才進入 `runInTransaction`，裡面只做兩件事：
`financeRepository.insertInvoice()` + `financeRepository.insertInvoiceItems()`。

**Rollback guarantee**：`runInTransaction` 內任何一步拋出例外（包含唯一約束衝突、或測試用的強制
失敗），SQLite 執行 `ROLLBACK`，`invoices` 與 `invoice_items` 兩張表都不會留下任何一行——已用失敗
注入測試驗證（見下方 Failure Injection）。

**Failure injection 測試**：
- Failure A（驗證期失敗）：session_ids 內混入不存在的 session id → 拋出 400，**在進入 transaction
  之前**就失敗，資料庫完全沒有變動。已測試通過。
- Failure B（transaction 內強制失敗）：monkeypatch `financeRepository.insertInvoiceItems` 讓它拋出
  例外，驗證 `invoices` 表也沒有留下已插入的那一行（確認 `insertInvoice` 的效果被完整 rollback）。
  已測試通過。
- 重複開立（`invoice_items.session_id` UNIQUE）→ 409，驗證前的唯讀檢查（`hasInvoiceItemForSession`）
  已經先擋下，不會進入 transaction。已測試通過。

**Ledger side effect**：無變化（跟 Wave 3A 記錄的一樣，開立當下不產生 ledger_entries）。

**Audit side effect**：`invoice.create` 只在 `createInvoice()` 正常 return（即 transaction 已
commit）之後、route 裡才呼叫 `logEvent`；任何 `FinanceError`（400/404/409）或非預期例外都會在
`logEvent` 之前就 return/throw，不會出現「操作失敗但寫了成功的 audit log」。

**Remaining concurrency risk**：低。原本「中」的風險（invoice 建立成功但 items 插入失敗留下孤兒）
已經被 transaction 消除；剩下的唯一併發場景（兩個請求同時對同一堂課開立）仍然依賴
`invoice_items.session_id` 的 `UNIQUE` constraint 作最後防線——第二個請求的 transaction 會在
`insertInvoiceItems` 內失敗並完整 rollback（不會留下孤兒 invoice），跟 Wave 3A 記錄的「有 UNIQUE
擋著、但沒有 atomicity 保證」的風險相比，現在有了 atomicity 保證，殘餘風險只是「第二個請求會拿到
500 而不是預期的 409」（因為 UNIQUE 撞到的是 raw SQLite constraint error，不是應用層預先檢查出的
`FinanceError(409)`）——這個 race window 極窄（兩個請求的驗證讀取剛好都通過、寫入才撞上），
留給 Wave 4 視情況決定是否要把 SQLite constraint error 轉譯成 409。

---

## Delete Invoice

```text
Use case: DELETE /api/schools/:schoolId/invoices/:id
Service:  server/src/services/finance.js — deleteInvoice()
```

**Wave 3A 記錄的風險**：ledger_entries 刪除成功、invoices 刪除失敗，會留下「繳費單看似完好但收支
明細已消失」的不一致狀態。

**Transaction owner**：`services/finance.js` 的 `deleteInvoice()`。

**Atomic writes**：`findInvoiceById`（404 檢查）與 `captureInvoice`（trash snapshot 讀取）都在
transaction **外**完成（純讀取，不影響 atomicity）；`runInTransaction` 內依序：
`insertTrashRow()` → `deleteInvoiceLedgerEntries()` → `deleteInvoiceRow()`（`invoice_items` 靠
`ON DELETE CASCADE` 自動清除，不需要應用層額外 DELETE）。

**Rollback guarantee**：三步驟中任何一步失敗都會完整 rollback——已用失敗注入測試驗證：
monkeypatch `financeRepository.deleteInvoiceRow` 讓它拋出例外，驗證 `trash` 表沒有多出那一筆（也就是
`insertTrashRow` 的效果被回滾）、`invoices`/`ledger_entries` 都還在原狀。

**Ledger/trash broadcast 順序**：`insertTrashRow`（transaction 內）不 broadcast；transaction commit
成功之後，route 才依序 `broadcastChange('trash')` + `broadcastChange('finance')`，確保前端收到的
「東西被刪了」通知一定對應一個已經真正發生的刪除。

**Audit side effect**：`invoice.delete` 只在 transaction commit 成功後才 log，同上一節的保證。

**Remaining concurrency risk**：低（刪除操作本身沒有明顯的併發競爭場景，跟 Wave 3A 記錄的一致）。

**Restore behavior**：`trash.js` 的 restore handler 目前仍**沒有**專門處理 `invoice` 類型的還原邏輯
（沿用 Wave 3A 的記錄，屬於 Wave 4 cross-cutting 範圍，Wave 3B 沒有變動這部分）。

---

## Create Payslip

```text
Use case: POST /api/schools/:schoolId/payslips
Service:  server/src/services/finance.js — createPayslip()
```

**Wave 3A 記錄的風險**：與 Create Invoice 完全對稱——items 迴圈中途失敗留下孤兒 payslip。

**Transaction owner**：`services/finance.js` 的 `createPayslip()`。

**Atomic writes**：所有業務規則驗證（課堂存在且屬於該教師、尚未開立過、「未來日期不可開薪資」、
已請假/調課、尚未點名）都在 transaction 外完成；`runInTransaction` 內只做
`financeRepository.insertPayslip()` + `financeRepository.insertPayslipItems()`。

**Rollback guarantee**：與 Create Invoice 相同分析，已用失敗注入測試（monkeypatch
`insertPayslipItems` 強制拋出例外）驗證 `payslips` 表沒有殘留孤兒行。

**業務規則保留驗證（Wave 3B 明確要求）**：「未來日期不可開薪資」規則的錯誤訊息與 status code
（`400`，訊息 `${session_date} ${subject} 尚未發生，無法開立薪資`）逐字保留，已用 regression 測試
比對字串完全一致；「已請假/已調課」「尚未點名」的錯誤訊息與 400 status 同樣逐字保留。

**Ledger side effect**：無變化（跟 invoice 一樣，靠 `POST /finance/generate-salary` 另外產生）。

**Audit side effect**：`payslip.create` 只在 transaction commit 成功後才 log，同 Create Invoice。

**Remaining concurrency risk**：低，分析與 Create Invoice 對稱（UNIQUE constraint 撞擊時會拿到 500
而非預先檢查出的 409，同樣是極窄的 race window，留給 Wave 4）。

---

## Delete Payslip

```text
Use case: DELETE /api/schools/:schoolId/payslips/:id
Service:  server/src/services/finance.js — deletePayslip()
```

**Transaction owner / Atomic writes / Rollback guarantee**：與 Delete Invoice 完全對稱（
`insertTrashRow()` → `deletePayslipLedgerEntries()` → `deletePayslipRow()`，`payslip_items` 靠
CASCADE 清除），已用相同方式的失敗注入測試驗證（monkeypatch `deletePayslipRow`）。

**Audit / broadcast 順序**：與 Delete Invoice 相同——trash 寫入不在 transaction 內 broadcast，
commit 成功後才 broadcast + log。

**Remaining concurrency risk**：低。

**Restore behavior**：沿用 Wave 3A 記錄，`payslip` 類型還原邏輯留給 Wave 4。

---

## Generate Monthly Tuition / Salary（Wave 3A 分析，Wave 3B 未變動）

```text
Use case: POST /api/schools/:schoolId/finance/generate-tuition
          POST /api/schools/:schoolId/finance/generate-salary
File: server/src/routes/finance.js
```

不在 Wave 3B 範圍內，原因與 Wave 3A 記錄相同：迴圈裡每一輪只寫一張表（`ledger_entries`，
insert-or-update 二選一），單一 SQL statement 本身就有 SQLite 保證的 atomicity，不需要額外
transaction；迴圈中途失敗只會留下「部分月份已產生 ledger_entries、其餘沒有」，可安全重跑補齊，
不會造成資料損毀或重複入帳。Wave 3B 沒有變動這兩個 endpoint。

---

## Wave 3B 完成摘要

| Use case | Transaction owner | Atomic writes | Rollback 驗證 | Audit 時機 | 殘餘風險 |
|---|---|---|---|---|---|
| Create Invoice | `financeService.createInvoice` | insertInvoice + insertInvoiceItems | ✅ 失敗注入測試通過 | 僅 commit 後 | 低（UNIQUE race 會變 500 而非 409） |
| Delete Invoice | `financeService.deleteInvoice` | insertTrashRow + deleteLedger + deleteInvoiceRow | ✅ 失敗注入測試通過 | 僅 commit 後 | 低 |
| Create Payslip | `financeService.createPayslip` | insertPayslip + insertPayslipItems | ✅ 失敗注入測試通過 | 僅 commit 後 | 低（同 Create Invoice） |
| Delete Payslip | `financeService.deletePayslip` | insertTrashRow + deleteLedger + deletePayslipRow | ✅ 失敗注入測試通過 | 僅 commit 後 | 低 |

**測試方式**：全部針對 `DATABASE_PATH` 指向的隔離 SQLite 檔案執行（種子建立 school/user/student/
teacher/session 等最小資料），涵蓋 happy path、驗證期失敗（不進入 transaction）、transaction 內
強制失敗（monkeypatch repository 方法拋出例外）、重複開立/請假/未來日期等既有業務規則、
`PRAGMA foreign_key_check`、孤兒 row 檢查、跨 process 重啟後資料持久性驗證，共 19 項全數通過，
未使用正式的 `server/data/app.db` 或 Docker named volume。
