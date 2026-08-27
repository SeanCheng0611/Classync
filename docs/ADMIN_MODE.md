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
  「宣稱今天是某一天」來繞過限制。Frontend 只會把使用者輸入的完整密碼原封不動送出，不會、也不能
  自己決定或提交日期。
- 時區明確指定為 `ADMIN_MODE_TIMEZONE`（預設 `Asia/Taipei`），不依賴 Docker host / OS 的預設時區——
  container 常常預設跑在 UTC，沒有這個明確指定的話，MMDD 在特定時段會跟台灣使用者認知的「今天」差一天。
- 驗證前先做格式檢查（`parseAdminPassword`）：長度要夠、最後 4 碼必須是數字，格式不對直接判定失敗，
  不會浪費資源做 `scrypt` 運算。
- 格式通過後，把提交的密碼拆成「前綴部分」與「日期尾碼」兩段，日期尾碼用字串比對（本身不是 secret），
  前綴部分用 `scrypt` + `timingSafeEqual` 比對雜湊值（見 `server/src/auth/adminPassword.js`）。

### Security Model 摘要

```text
10 次點擊       = 隱藏入口的發現方式，不是驗證
MMDD           = 每日變動因子，由 server 時鐘（Asia/Taipei）產生，不是主要 secret
固定前綴        = 真正的 secret，只以 scrypt 雜湊儲存
Admin JWT      = 通過驗證後發出的短效授權憑證，backend 每次請求都會驗證
```

真正的 security boundary = 固定前綴（雜湊儲存）+ server 產生的 MMDD + rate limiting + backend 驗證
+ 短效 Admin JWT，五者缺一不可。

### 跨午夜行為

Admin unlock 當下才會檢查 MMDD 是否等於「今天」；一旦成功發出 Admin JWT，這個 JWT 就依照自己的
`ADMIN_MODE_SESSION_MINUTES` 到期時間獨立運作，**不會因為跨過午夜、MMDD 換了一天就提前失效**。
例如 23:50 用當天的 MMDD 解鎖成功，JWT 會正常持續到 00:35（45 分鐘後）才過期，不會在 00:00 被踢出。
`requireSystemAdminMode` 只驗證 JWT 本身是否還在效期內，不會每次 request 都重新檢查 MMDD。

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
ADMIN_MODE_PASSWORD_HASH=            # 前綴的 scrypt 雜湊值，留空則整個功能無法使用
ADMIN_MODE_SESSION_MINUTES=45        # 解鎖後的有效時間
ADMIN_MODE_TIMEZONE=Asia/Taipei      # MMDD 用哪個時區算，不是 secret
```

## Secret 洩漏檢查（Wave 3A）

Wave 3A 開始前掃描過整個 repository（tracked 檔案 + 完整 git history），確認真實的固定前綴、完整每日
密碼都沒有出現在任何會被 commit 的地方（`git log --all -S "<真實前綴>"` 沒有任何結果）。文件與
`.env.example` 裡出現的前綴一律是示意用的假值（例如 `ABCDEFGH`），不是任何人實際在用的前綴。
不需要 rotate，也沒有對 git history 做任何改寫。
