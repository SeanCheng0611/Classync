# Admin Mode

系統診斷/管理模式（system admin mode），**不是**補習班的 business role（owner/admin/teacher/front_desk）。
兩者刻意分開命名與實作，避免混淆：業務角色決定「能不能管這間補習班的學生/課表/財務」，Admin Mode 決定
「能不能看系統層級的診斷/稽核資訊」，未來理想狀態是只有系統維運者才會用到 Admin Mode，跟一般補習班管理者
的日常操作完全無關。

## Unlock Flow

1. 使用者連續點擊「設定」頁標題（`<h2>設定</h2>`）10 次，4 秒內沒有繼續點會重置計數（見
   `client/src/pages/Settings.jsx` 的 `handleTitleTap`）。第 7～9 次會顯示「還差 N 次」的提示。
2. 第 10 次跳出密碼輸入框（`AdminUnlockDialog`）。
3. **10 次點擊本身不是驗證，只是找到隱藏入口的方式。** 密碼驗證完全在 backend
   （`POST /api/admin/unlock`，見 `server/src/routes/admin.js`）。
4. 驗證成功後，backend 簽發一個獨立的短效 JWT，存進 `cram_admin_session` cookie（httpOnly、
   sameSite=lax），跟一般登入 session（`cram_session`）分開。

## 密碼設計：固定前綴 + 當天日期

實際密碼 = `<固定前綴>` + `<當天日期 MMDD>`，例如前綴是 `ABCDEFGH`，8/27 當天密碼就是 `ABCDEFGH0827`，
9/1 就是 `ABCDEFGH0901`，每天自動變動，不需要手動更新任何設定。（這裡的前綴只是示意用的假值，不是任何人
實際在用的前綴。）

- `.env` 只存**前綴的 scrypt 雜湊值**（`ADMIN_MODE_PASSWORD_HASH`），不是完整每日密碼、也不是明文。
- 日期尾碼（MMDD）由 **server 自己的時鐘**計算，不接受任何 client 提供的日期——避免有人操控成
  「宣稱今天是某一天」來繞過限制。
- 驗證時把提交的密碼拆成「前綴部分」與「日期尾碼」兩段，日期尾碼用字串比對（本身不是 secret），
  前綴部分用 `scrypt` + `timingSafeEqual` 比對雜湊值（見 `server/src/auth/adminPassword.js`）。

### 產生雜湊值

```powershell
cd server
node -e "import('./src/auth/adminPassword.js').then(m => console.log(m.hashAdminPassword(process.argv[1])))" 你的前綴
```

把輸出貼到 `server/.env` 的 `ADMIN_MODE_PASSWORD_HASH`。**只丟前綴，不要加日期**，也絕對不要把前綴明文
或完整每日密碼寫進任何會被 commit 的檔案。

## Admin Capability（Backend 驗證）

- `requireSystemAdminMode` middleware（`server/src/auth/middleware.js`）驗證 `cram_admin_session`
  cookie 的 JWT 是否有效、且 `sub`（userId）跟目前登入的使用者一致。
- 掛在所有 `/api/admin/*` 的敏感 endpoint（目前是 `GET /api/admin/logs`）。
- **不靠 frontend 的 `isAdminMode` 狀態決定能不能拿到資料**——就算有人繞過 UI 直接打 API，沒有合法
  admin session cookie 一律 403。

## Session Lifetime

- 預設 45 分鐘（`ADMIN_MODE_SESSION_MINUTES` 環境變數可調整），到期後 cookie 失效，
  `requireSystemAdminMode` 會拒絕請求。
- 一般使用者 `POST /auth/logout` 時，admin session cookie 也會一併清掉（見 `routes/auth.js`）。
- Frontend refresh 頁面後，`AdminModeContext` 會呼叫 `GET /api/admin/status` 恢復 UI 顯示狀態
  （這個端點只回報 true/false，不代表授權，真正的資料保護仍在各個敏感 endpoint 自己的 middleware）。

## Lock（離開管理者模式）

管理者頁面（`/admin`）上的「離開管理者模式」按鈕呼叫 `POST /api/admin/lock`，清掉 admin session cookie
並把 frontend 的 `isAdminMode` 狀態設回 `false`。離開後：Admin Page 從導覽列消失、各 Page 的
`PageLogViewer`（Logs 按鈕）也跟著消失。

## Brute-force Protection

`server/src/auth/adminPassword.js` 有一個最小的記憶體內 rate limiter：同一個使用者連續 5 次密碼錯誤後，
5 分鐘內即使密碼正確也會被拒絕（429）。

**限制**：這個狀態存在單一 process 的記憶體裡，多 instance 部署（例如水平擴充多台 backend）時每個
instance 會各自獨立計數，等於實質上放寬了限制次數。若未來真的要多 instance 部署，這裡需要升級成共用狀態
（例如一個外部 store），不在本 Wave 範圍內。

## Frontend State

`client/src/context/AdminModeContext.jsx` 提供 `isAdminMode`、`unlockAdminMode()`、`lockAdminMode()`。
這個 state **只控制 UI 要不要顯示**（Admin Page、各頁的 Logs 按鈕），完全不是真正的授權來源。

## 環境變數

見 `server/.env.example`：

```text
ADMIN_MODE_PASSWORD_HASH=       # 前綴的 scrypt 雜湊值，留空則整個功能無法使用
ADMIN_MODE_SESSION_MINUTES=45   # 解鎖後的有效時間
```
