# Logging Architecture

通用診斷/稽核事件記錄基礎設施，刻意不綁死補習班 domain，設計目標是未來 Classync 抽象成跨產業平台時，
這套 Audit/Diagnostic Infrastructure 可以原封不動保留。

## 兩種 Log 概念

同一張表（`audit_logs`），但 `log_type` 欄位把每筆事件分成兩種、UI 上可以切換：

- **Audit Log**（`log_type = 'audit'`）：誰在什麼時間改了什麼，正式營運重要的稽核紀錄。
  對應 category：`USER_ACTION`、`DATA_CHANGE`、`AUTH`、`SECURITY`。
- **Diagnostic Log**（`log_type = 'diagnostic'`）：錯誤、Automation、API/整合狀態，工程維運用。
  對應 category：`SYSTEM`、`ERROR`、`AUTOMATION`、`INTEGRATION`。

`log_type` 是一個真實欄位（不是每次查詢時從 category 現算），這個對應關係集中在
`server/src/services/auditLog.service.js` 的 `AUDIT_CATEGORIES`/`DIAGNOSTIC_CATEGORIES`，只有一份，
呼叫端跟前端都不用各自維護對照表。

## Dependency Chain

```text
Route（或 Service，優先在 Service 完成才記）
  ↓
AuditLog Service（server/src/services/auditLog.service.js）
  ↓
AuditLog Repository（server/src/repositories/auditLogs.repository.js）
  ↓
SQLite（audit_logs 資料表）
```

Route/Service 只呼叫 `logEvent({...})`，完全不知道底下是 SQLite、不知道 SQL、不知道 JSON 欄位怎麼序列化。

## Audit Event Schema

```text
id                主鍵，nanoid
created_at        DB 產生的時間戳記
log_type          'audit' | 'diagnostic'
level             'INFO' | 'WARN' | 'ERROR'
category          USER_ACTION / DATA_CHANGE / AUTH / SECURITY / SYSTEM / ERROR / AUTOMATION / INTEGRATION
page_key          對應 constants/pageKeys.js 的其中一個 key，可為 null（系統層級事件不一定有對應頁面）
action            例如 'student.create'、'admin.unlock.failed'
message           人類看得懂的一句話描述
user_id           觸發者，可為 null（未登入的系統事件）
school_id         目前借用作 tenant scope（見下方「Tenant Scope」），可為 null
entity_type       例如 'student'、'schedule_template'，通用命名，不是教育專用欄位
entity_id
request_id        目前未大量使用，保留給未來串接同一次 request 的多筆事件
metadata_json     額外脈絡（JSON 字串），寫入前會經過敏感欄位過濾（見下方）
```

Schema 定義見 `server/src/db/schema.sql` 的 `audit_logs` 區塊，用 `CREATE TABLE IF NOT EXISTS` 建立，
既有 production 資料庫開機時會安全地新增這張表，不影響既有資料。

## Page Key Registry

`server/src/constants/pageKeys.js` 與 `client/src/constants/pageKeys.js` 各自維護一份（兩邊分屬不同
build，沒有共用 package），內容必須保持一致。禁止在程式碼裡自由輸入 `"Student Page"` /
`"students-page"` 這類不一致的字串，一律用 `PAGE_KEYS.STUDENTS` 這樣的常數。

## Tenant Scope

目前借用 `school_id` 當作 tenant scope。未來 Generic Core Phase 若把 `school_id` 抽象成
`organization_id`/`tenant_id`，這張表要跟著調整——這是刻意的技術債，本 Wave 不處理 schema
genericization。

## Sensitive Data Policy

**絕對禁止**記錄：密碼、admin 密碼、JWT、session token、cookie、API key、secret、信用卡卡號、完整
Authorization header。

- `auditLog.service.js` 的 `sanitizeMetadata()` 會遞迴過濾 metadata 物件裡任何 key 名稱（不分大小寫）
  命中 `password`/`token`/`secret`/`cookie`/... 這類清單的欄位。這是**最後一道防線**，不是主要防護——
  主要防護是呼叫端本來就不應該把整包 request body 塞進 metadata。
- Admin unlock 失敗/成功只記錄「這件事發生了」，絕不記錄提交的密碼本身（見 `routes/admin.js`）。
- 已用實際測試驗證：建立一筆會觸發密碼相關 log 的請求後，直接查資料庫確認 log 裡沒有出現密碼字串
  （見 Wave 2.1 完成報告的 Sensitive Data Test）。

## Instrumented Operations（第一版範圍）

- **Auth**：LINE 登入成功、開發用假登入、登出、admin 解鎖成功/失敗/rate-limited、admin 離開。
- **Students**：create / update / delete。
- **Teachers**：create / update / delete。
- **Scheduling**：schedule_template create / update / delete；session create（makeup/extra）/
  update / delete。
- **Attendance**：set（含 present/absent/leave）、revoke。
- **Seats**：座位安排更新。
- **Finance / Settings**：本 Wave 未 instrument（見 Technical Debt）。

## Logging Failure 不能影響主要操作

`logEvent()` 內部包 try/catch，寫入失敗只 `console.error`，**不會 throw**，不會讓原本已經成功的 CRUD
操作變成 500。所有呼叫點都放在主要業務操作（repository 寫入 + `broadcastChange`）**之後**，不是放進
同一個 transaction。

Admin unlock 這類 security-critical log 也走一樣的 fire-and-forget 寫法——資料庫本身寫入失敗時系統
已經有更大的問題，不應該因為「log 失敗就擋登入」製造新的 single point of failure。

## Pagination & Sorting

`GET /api/admin/logs` 一律分頁：`limit`（預設 50，上限 100）+ `offset`，`ORDER BY created_at DESC, id
DESC`（newest first）。禁止 `SELECT * FROM audit_logs` 不分頁整包回傳，見
`repositories/auditLogs.repository.js` 的 `find()`。

## Retention（設計，未自動排程）

SQLite 不適合無限累積 log。本 Wave 只：

1. 提供 `auditLogsRepository.deleteOlderThan(cutoffDateStr)` 供未來排程或手動清理使用。
2. 記錄建議策略：保留最近 30～90 天（依實際 log 量決定），**沒有**自動排程執行這個清理，避免
   誤刪還在調查中的稽核紀錄。真正要排程時，可以參考 `services/trash.js` 的
   `startTrashPurgeScheduler()` 寫法（14 天自動清回收桶），但這是刻意留給後續處理的項目。

## Indexes

`audit_logs` 建了 `created_at`、`(log_type, created_at)`、`(page_key, created_at)`、
`(level, created_at)`、`user_id`、`school_id` 六個 index，對應目前 `find()` 支援的 filter 組合。沒有對
`action`/`message`/`category` 單獨建 index（`category` 查詢量小、`message` 用 `LIKE` 全文比對本來就
不吃 index）。
