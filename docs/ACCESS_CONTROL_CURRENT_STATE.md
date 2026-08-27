# Access Control — Current State

記錄 Phase 1B 封板時的權限系統現況，供 Phase 1C（RBAC + Tenant Permissions + Feature Entitlements +
Platform Owner Dashboard）規劃用。**這份文件只記錄現況，不包含任何新設計或實作**——Phase 1C 開始前
禁止新增 `roles`/`permissions`/`features`/`organization_features` 資料表或 Platform Owner Dashboard，
見 Wave 4 mission 的 Section 51/53。

## 現有資料模型

```text
users
  id, line_user_id, display_name, picture_url, is_owner
  ↑
memberships（多對多：一個 user 可以在多個 school 有不同 role）
  id, user_id, school_id, role, teacher_id
  ↓
schools
  id, name, invite_code, ...settings...
```

- `users.is_owner`：**平台層級**的單一 boolean flag，不是角色系統。目前唯一的用途：
  `requireOwner` middleware（`auth/middleware.js`），只掛在 `routes/dev.js` 的
  `POST /dev/reset`（一鍵清空所有補習班測試資料）。系統第一位登入的使用者自動變成 `is_owner = 1`
  （`services/auth.js` 的 `upsertLineUser`），之後沒有任何 UI/API 可以轉移或撤銷這個狀態。
- `memberships.role`：**school 層級**的角色，值為 `admin` / `teacher` / `front_desk` 三選一
  （CHECK constraint，`db/index.js` 的 `migrateRoleCheckIncludesFrontDesk` 處理過從只有
  `admin`/`teacher` 兩種值的舊資料庫升級）。一個 user 在不同 school 可以有不同 role（例如在 A 補習班
  是 admin，在 B 補習班是 teacher）。`role = 'teacher'` 時 `teacher_id` 對應到該 school 的
  `teachers.id`。
- 沒有第四種角色。沒有「school owner / school admin」的區分——`admin` 角色在自己的 school 內權限
  一致，沒有分級。

## Authorization Middleware（`auth/middleware.js`）

| Middleware | 驗證什麼 | 掛載範圍 |
|---|---|---|
| `requireAuth` | 有效的 session cookie（`cram_session`），解出 `req.user` | 大多數 `/api/*` 路由 |
| `requireOwner` | `req.user.is_owner === true` | 只有 `POST /dev/reset` |
| `requireSystemAdminMode` | 獨立的 Admin Mode session（`cram_admin_session`，見 `docs/ADMIN_MODE.md`），**不是** business role，是診斷/稽核用途 | `/api/admin/*` |
| `requireMembership(roles)` | `req.user` 在 URL 上的 `:schoolId` 有 membership，且 `role` 在允許清單內 | 幾乎所有 `/api/schools/:schoolId/*` 路由 |

`requireMembership` 的預設允許清單是 `['admin', 'teacher', 'front_desk']`（用於學生檔案/教師檔案/
課表/點名/座位五項子系統，`front_desk` 在這個範圍內視同 `admin`）；財務相關路由
（`invoices`/`payslips`/`finance`/`notes`/`inviteCodes`/`trash`）明確傳入 `['admin']`，只有 admin
角色可以存取。

## Tenant（School）Isolation 現況

- 每個受保護的 API 都掛在 `/api/schools/:schoolId/...` 之下，`requireMembership` 在進入 route handler
  前就確認呼叫者在這個 `schoolId` 有 membership——沒有 membership 直接 403，不會進到 repository 查詢。
- Repository 層的查詢方法幾乎都明確要求 `schoolId` 參數並在 `WHERE` 子句過濾（例如
  `studentsRepository.findAllBySchool(schoolId)`、`notesRepository.findAllBySchool(schoolId)`），
  Wave 4 對這條規則做過一次全面稽核（Section 49/50），沒有發現「應該要 school-scoped 但沒有 scope」
  的查詢方法被 route 直接呼叫（少數像 `usersRepository.findById(id)`、
  `inviteCodesRepository.findByCode(code)` 這種不帶 schoolId 的方法，都是刻意設計成「先用非 tenant
  的鍵值查到一筆，再驗證 tenant 歸屬」的模式，呼叫端會再檢查回傳結果的 `school_id` 是否符合預期，
  例如 `/redeem` 用 code 查到 invite 後才知道要加入哪個 school，不是查詢一開始就知道 schoolId）。
- Wave 4 的兩校（School A / School B）隔離 regression 測試涵蓋：memberships、students、teachers、
  notes、invite codes 的查詢結果不會互相洩漏（見 Wave 4 完成報告的 Multi-tenant Baseline 段落）。

## 目前沒有的東西（Phase 1C 的 Gap）

- **沒有 Platform Owner Dashboard**：`is_owner` 只是一個 boolean flag，沒有對應的管理介面，也看不到
  「所有 school 的清單」這種跨租戶視角。
- **沒有 Feature Entitlement**：所有 school 使用完全相同的功能集合，沒有「這個 school 可以用 A
  功能、那個 school 不行」的機制。
- **沒有細粒度的 Member Permission**：`admin` 角色在自己的 school 內是全權限（除了不能改別的
  `is_owner` 使用者這種平台層級的事），沒有「這個 admin 可以管理財務、那個 admin 不行」的區分。
- **`is_owner` 沒有管理介面**：沒有 API 可以把 `is_owner` 授予/收回給其他使用者，只有系統第一位
  登入者自動取得，之後完全靜態。
- **Admin Mode（`docs/ADMIN_MODE.md`）不是 RBAC 的一部分**：它是診斷/稽核用途的短期 session（MMDD
  密碼、45 分鐘 JWT），驗證的是「這個瀏覽器/使用者知道今天的密碼」，不是「這個使用者有什麼業務權限」，
  兩者完全獨立，未來設計 RBAC 時不應該把兩者混在一起。

## Phase 1C 需要回答的問題（不在這裡回答，只列出）

1. School Admin 與 Platform Owner 之間，是否需要第三種角色（例如「School Owner」，能管理同 school
   的其他 admin，但不能跨 school）？
2. Feature Entitlement 的授予單位是 school 還是 membership？
3. `is_owner` 現有的「系統第一位登入者自動成為」邏輯，在正式導入 Platform Owner 概念後是否要保留、
   或改成明確的手動授予流程？
4. Admin Mode 與未來 RBAC 的關係——是否有「Platform Owner 專屬看得到 Diagnostic Log」這類需求？
