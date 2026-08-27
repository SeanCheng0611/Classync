# Finance Transaction Inventory

Wave 3A 的交付項目：盤點 Finance domain 裡跨表、需要 atomic 保證的寫入操作，留給 Wave 3B
（Financial Atomic Transactions）處理。Wave 3A **沒有**搬動這些操作的 transaction boundary，
它們目前仍是 routes/invoices.js、routes/payslips.js 裡直接呼叫 `db.prepare(...)` 的原始寫法
（沒有用 `runInTransaction` 包起來，維持 refactor 前的原始行為，不是這個 Wave 新增的風險）。

## Create Invoice

```text
Use case: POST /api/schools/:schoolId/invoices
File: server/src/routes/invoices.js
```

**Writes（順序）**：
1. `INSERT INTO invoices`
2. loop：`INSERT INTO invoice_items`（每個 session 一筆）

**目前 transaction boundary**：無。每個 `db.prepare(...).run(...)` 各自 autocommit。

**Failure risks**：
- Invoice 建立成功，但 items 迴圈中途失敗（例如某個 session 已被別的請求搶先開立、觸發 UNIQUE
  constraint on `invoice_items.session_id`）→ 留下一張「有 invoice 但 items 不完整」的孤兒繳費單，
  `total_amount` 會跟實際 items 加總對不上。
- 高併發下兩個請求同時對同一堂課開立繳費單：目前用「先 SELECT 已開立過的 invoice_items 擋掉」
  （route 裡 `SELECT 1 FROM invoice_items WHERE session_id = ?`）不是原子操作，理論上有 race window，
  但實務上 `invoice_items.session_id` 有 `UNIQUE` constraint，真的撞上時第二個 INSERT 會直接失敗
  （不會靜默造成重複收費，但會讓 invoice 本身已經建立、items 卻插入失敗，一樣是孤兒 invoice 的風險）。

**Ledger side effect**：無（開立繳費單當下不會自動產生 ledger_entries，要另外呼叫
`POST /finance/generate-tuition` 才會產生對應收支明細，那是獨立的操作）。

**Audit side effect**：Wave 3A 已加（`invoice.create`，見 `routes/invoices.js`）。

**Delete/Restore**：見下方「Delete Invoice」。

**Concurrency risk**：中（同一堂課被搶先開立時，UNIQUE constraint 會擋下第二次寫入，但第一步的
invoice row 已經建立，需要應用層清理或 Wave 3B 用 transaction 包起來自動 rollback）。

---

## Delete Invoice

```text
Use case: DELETE /api/schools/:schoolId/invoices/:id
File: server/src/routes/invoices.js
```

**Writes（順序）**：
1. `addToTrash(...)`（讀取 invoice + invoice_items + 相關 ledger_entries，寫進 `trash` 表 —— 這一步
   必須在下面兩個 DELETE **之前**執行，否則 capture 會讀到已經被刪除的資料，這個順序目前是對的）
2. `DELETE FROM ledger_entries WHERE related_invoice_id = ?`
3. `DELETE FROM invoices WHERE id = ?`（`invoice_items` 靠 `ON DELETE CASCADE` 外鍵自動清除，
   不需要應用層額外 DELETE）

**目前 transaction boundary**：無。

**Failure risks**：
- Step 2 成功、step 3 失敗：ledger_entries 已刪但 invoice 還在，畫面上會看到「這張繳費單看似完好，
  但收支明細已經消失」的不一致狀態。
- trash capture（step 1）本身如果失敗（例如序列化錯誤），目前會直接拋出例外中斷整個請求，
  不會執行到後面的 DELETE，這種情況下沒有不一致風險，但使用者會看到 500 且完全刪不掉。

**Restore behavior**：`trash.js` 的 restore handler 目前**沒有**專門處理 `invoice` 類型的還原邏輯
（只確認過 `session_cancelled`/`schedule_template` 有對應 handler，`invoice`/`payslip`/`ledger_entry`
的還原邏輯屬於 Wave 4 cross-cutting 範圍，Wave 3A 沒有進一步查證，留待 Wave 4 一併確認）。

**Concurrency risk**：低（刪除操作本身沒有明顯的併發競爭場景）。

---

## Create Payslip

```text
Use case: POST /api/schools/:schoolId/payslips
File: server/src/routes/payslips.js
```

**Writes（順序）**：
1. `INSERT INTO payslips`
2. loop：`INSERT INTO payslip_items`（每個 session 一筆）

**目前 transaction boundary**：無。

**Failure risks**：與 Create Invoice 完全對稱——payslip 建立成功但 items 中途失敗會留下孤兒
payslip；`payslip_items.session_id` 同樣有 `UNIQUE` constraint 防止重複計薪，但不保證 atomicity。

**額外業務規則（跟 Invoice 不同的地方）**：建立前會逐堂課檢查「是否已在未來」「是否已請假/調課」
「是否尚未點名」，這些檢查本身是唯讀，不影響 atomicity 分析，但代表 Wave 3B 設計 transaction 時
如果要在寫入前重新驗證，必須把這些規則也一併考慮進去（例如寫入過程中課堂被別的請求同時改成請假）。

**Ledger side effect**：無（跟 invoice 一樣，靠 `POST /finance/generate-salary` 另外產生）。

**Audit side effect**：Wave 3A 已加（`payslip.create`）。

**Concurrency risk**：中（同 Create Invoice）。

---

## Delete Payslip

```text
Use case: DELETE /api/schools/:schoolId/payslips/:id
File: server/src/routes/payslips.js
```

**Writes（順序）**：與 Delete Invoice 完全對稱：
1. `addToTrash(...)`（讀取 payslip + payslip_items + 相關 ledger_entries）
2. `DELETE FROM ledger_entries WHERE related_payslip_id = ?`
3. `DELETE FROM payslips WHERE id = ?`（`payslip_items` 靠 CASCADE 清除）

**Failure risks / Restore behavior / Concurrency risk**：與 Delete Invoice 相同分析。

---

## Generate Monthly Tuition / Salary（Wave 3A 範圍內，非 3B）

```text
Use case: POST /api/schools/:schoolId/finance/generate-tuition
          POST /api/schools/:schoolId/finance/generate-salary
File: server/src/routes/finance.js
```

這兩個**不**列入 Wave 3B 待處理清單，原因：迴圈裡每一輪只寫**一張表**（`ledger_entries`，
insert-or-update 二選一），不像 invoice/payslip 的 create 需要同時對兩張表原子寫入。單一
ledger_entries 的 insert/update 本身就是一個 SQL statement，SQLite 保證單一 statement 的 atomicity，
不需要額外包 transaction。

**Failure risks**：迴圈中某一輪（某張 invoice/payslip）寫入失敗會中斷整個迴圈，但已經成功的前幾輪
不會被回滾——最壞情況是「一部分 invoice/payslip 已經產生對應 ledger_entries，其餘沒有」，這是可以
安全重跑的狀態（重新呼叫這個 endpoint，已經有 ledger_entries 的會走 update 分支，沒有的會補上），
不會造成資料損毀或重複入帳（`related_invoice_id`/`related_payslip_id` 各自最多一筆的假設由呼叫端邏輯
維持，沒有 DB 層 UNIQUE constraint 強制，但目前查詢邏輯是先查後寫，維持這個不變量）。

**Duplicate risk**：低（先查 `findLedgerEntryByPayslip`/`findLedgerEntryByInvoice` 再決定 update 或
insert，不會重複建立）。

---

## Wave 3B 待處理摘要

| Use case | Tables | Atomicity gap | 優先度 |
|---|---|---|---|
| Create Invoice | invoices + invoice_items | 中：items 迴圈中途失敗留孤兒 invoice | 高 |
| Delete Invoice | ledger_entries + invoices | 低：目前執行順序正確，只差沒有整體 rollback 保證 | 中 |
| Create Payslip | payslips + payslip_items | 中：同 Create Invoice | 高 |
| Delete Payslip | ledger_entries + payslips | 低：同 Delete Invoice | 中 |

Wave 3B 建議做法（先記錄方向，不在 Wave 3A 實作）：仿照 Wave 2 的
`schedulingRepository.createTemplate`/`updateTemplate` 模式，把「建立 invoice + items」「刪除
invoice 的 ledger + invoice 本身」各自包成 `financeRepository` 裡自帶 `runInTransaction` 的單一方法，
route 只呼叫一次；「刪除」流程要特別注意 trash capture 必須在真正 DELETE 之前完成（跟 Wave 2 處理
`schedule_template` 刪除時踩過的坑一樣，見 `docs/REPOSITORY_ARCHITECTURE.md`）。
