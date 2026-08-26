# Persistence Inventory（Phase 1 遷移用清單）

Phase 0 不重寫這些檔案，這份清單只是盤點現況，供 Phase 1 建立
`Controller → Service → Repository → Database` 分層、遷移 PostgreSQL 時對照使用。

## 資料庫實作

- 純 `node:sqlite`（Node 內建，非 better-sqlite3），見 [server/src/db/index.js](../server/src/db/index.js)。
- 無 ORM、無 query builder，全部手寫 SQL 字串。
- Schema 定義在 [server/src/db/schema.sql](../server/src/db/schema.sql)；既有資料庫的欄位新增/表格重建則用一系列
  `ensureColumn(...)` 與手動 `CREATE TABLE ... / INSERT ... SELECT ... / DROP TABLE / RENAME` 在開機時執行
  （見 `db/index.js` 第 30-135 行）。這是目前唯一的 migration 機制。

## 直接存取 db 的檔案（`db.prepare` / `db.exec` / `runInTransaction` 出現次數）

| 檔案 | 次數 | 備註 |
|---|---:|---|
| server/src/routes/schools.js | 29 | |
| server/src/routes/notes.js | 17 | |
| server/src/services/trash.js | 18 | |
| server/src/routes/sessions.js | 15 | |
| server/src/routes/scheduleTemplates.js | 15 | |
| server/src/routes/payslips.js | 13 | |
| server/src/routes/students.js | 13 | |
| server/src/routes/finance.js | 11 | |
| server/src/routes/invoices.js | 11 | |
| server/src/routes/teachers.js | 10 | |
| server/src/routes/attendance.js | 7 | |
| server/src/routes/inviteCodes.js | 7 | |
| server/src/routes/seats.js | 7 | |
| server/src/routes/auth.js | 4 | |
| server/src/services/finance.js | 5 | |
| server/src/routes/trash.js | 3 | |
| server/src/services/sessions.js | 3 | |
| server/src/auth/middleware.js | 1 | |
| server/src/routes/dev.js | 1 | 開發用假登入，Phase 1 可能整條路由淘汰 |
| server/src/services/conflicts.js | 1 | |
| server/src/db/index.js | 27 | schema 建置 + migration，本身就是 infra 層，不算「散落」 |

共 21 個檔案、218 處直接 SQL 呼叫（不含 db/index.js 本身的 27 處）。

## Phase 1 建議方向（先記錄，不在 Phase 0 執行）

1. 依 route 對應的資料表分組，建立 `server/src/repositories/*.js`，把每個檔案裡的 `db.prepare(...)` 搬過去，
   route 只呼叫 repository 方法。
2. `db/index.js` 目前的 imperative migration（`ensureColumn` 等）之後應改用正式 migration 工具
   （例如 node-pg-migrate，配合 PostgreSQL），現在的寫法保留到 Phase 1 一起換掉，不要在 Phase 0 補新的。
3. Phase 0 之後任何新功能，**不要**再直接在新 route 裡寫 `db.prepare`，如果一定要加，優先寫進既有檔案、
   不要建立新的 domain-specific coupling（例如不要新增 `CramSchoolDatabase` 這類命名）。
