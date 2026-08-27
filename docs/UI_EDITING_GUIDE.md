# 介面文字／按鈕／寬度修改指南

給不是每天寫程式的人參考：想改畫面上的某段文字、某顆按鈕、某個區塊的寬度，該去哪個檔案改、改完怎麼讓正式網站看到新版本。

## 專案結構速覽

- 前端畫面（你看到的所有頁面）都在 `client/src/pages/`，一個檔案對應一個頁籤/頁面。
- 有些元件被多個頁面共用，放在 `client/src/components/`（改一個地方，所有用到它的頁面都會一起變）。
- 左側導覽列（學生檔案／教師檔案／課表…那排選單）在 `client/src/components/Layout.jsx`。
- 全站共用的顏色、按鈕預設樣式在 `client/src/index.css`。

## 快速對照表：畫面上的頁籤 → 檔案

| 畫面上看到的名稱 | 檔案位置 |
|---|---|
| 學生檔案 | `client/src/pages/Students.jsx` |
| 學生詳細頁 | `client/src/pages/StudentDetail.jsx` |
| 教師檔案 | `client/src/pages/Teachers.jsx` |
| 教師詳細頁 | `client/src/pages/TeacherDetail.jsx` |
| 課表（排課／請假／調課） | `client/src/pages/Schedule.jsx` |
| 點名 | `client/src/pages/Attendance.jsx` |
| 座位 | `client/src/pages/Seats.jsx` |
| 繳費單 | `client/src/pages/Invoices.jsx`、`InvoiceDetail.jsx` |
| 薪資開立 | `client/src/pages/Payslips.jsx`、`PayslipDetail.jsx` |
| 收支統計 | `client/src/pages/Finance.jsx` |
| 記事本 | `client/src/pages/Notes.jsx` |
| 成員管理 | `client/src/pages/Members.jsx` |
| 設定 | `client/src/pages/Settings.jsx` |
| 回收桶 | `client/src/pages/TrashPage.jsx` |
| 補習班選擇/建立 | `client/src/pages/SchoolPicker.jsx` |
| 登入頁 | `client/src/pages/Login.jsx` |
| 左側導覽選單 | `client/src/components/Layout.jsx` |

常用共用元件（多個頁面都會用到，改這裡會全站套用）：

| 元件 | 用在哪些地方 | 檔案 |
|---|---|---|
| 姓名搜尋下拉選單 | 選學生/教師時用的搜尋框 | `client/src/components/SearchSelect.jsx` |
| 時間輸入框 | 所有「時間」欄位 | `client/src/components/TimeInput.jsx` |
| 科目下拉選單 | 排課、學生/教師科目欄位 | `client/src/components/SubjectSelect.jsx`、`SubjectMultiSelect.jsx` |
| 一對多班級選擇 | 排課時選學生+單堂價錢 | `client/src/components/GroupStudentSelect.jsx` |
| 重複姓名確認彈窗 | 新增/匯入學生教師時 | `client/src/components/DuplicateConfirmModal.jsx` |

## 常見修改情境

### 1. 改文字（標題、按鈕文字、提示訊息）

打開對應頁面的 `.jsx` 檔案，直接搜尋畫面上看到的那段中文字（例如想改「+ 排課」，就在 `Schedule.jsx` 裡搜尋「排課」），會找到類似這樣的程式碼：

```jsx
<button>{showAddClass ? '取消排課' : '+ 排課'}</button>
```

把引號 `'...'` 裡的文字改掉存檔就好，不用動其他部分。有些文字是用變數組出來的（例如 `` `${count} 位學生` ``），改文字時保留 `${...}` 那段變數、只改前後的中文字即可。

### 2. 改按鈕（文字、顏色、要不要顯示）

按鈕在程式碼裡長這樣：

```jsx
<button onClick={someFunction}>按鈕文字</button>
```

- 改文字：改 `>按鈕文字<` 中間那段就好。
- 改顏色/大小：按鈕通常會有 `style={{ ... }}`，例如 `style={{ fontSize: 13, padding: '6px 4px' }}`，改裡面的數值。全站按鈕的預設樣式（沒特別加 style 的按鈕長怎樣）統一定義在 `client/src/index.css` 的 `button { ... }` 那段。
- 要不要顯示某顆按鈕：通常會包一層條件，例如 `{isAdmin && <button>...</button>}`，代表只有管理者看得到；把整段 `{條件 && (...)}` 刪掉就是永遠不顯示，把 `isAdmin` 拿掉、只留 `<button>...</button>` 就是永遠顯示。

### 3. 改寬度

寬度幾乎都是用 `style={{ width: ... }}` 或 `maxWidth: ...` 直接寫在程式碼裡（單位是像素 px，數字越大越寬），例如：

```jsx
<div style={{ maxWidth: 1100, margin: '0 auto' }}>   {/* 整個頁面的最大寬度 */}
<input style={{ maxWidth: 240 }} />                    {/* 單一輸入框的寬度 */}
```

多欄並排的區塊常用 `flex`／`grid`，例如 `display: 'flex', gap: 8`（欄位間距）；如果是「平均分配寬度」的欄位，會看到 `flex: 1`（想讓某一欄變寬，把它的 `flex: 1` 改成 `flex: 2` 之類的比例即可）。

### 4. 改顏色 / 全站主題色

全站的顏色都定義在 `client/src/index.css` 最上面的 `:root { --accent: ...; --danger: ...; }` 這幾行（CSS 變數）。程式碼裡看到的 `var(--accent)`、`var(--danger)` 這種寫法都是引用這裡定義的顏色，改這裡的色碼就能一次改變全站同一種用途的顏色（不用一個個頁面找）。

課堂類型的顏色（固定課/加課/調課標籤顏色）不是寫死在程式碼裡，而是可以直接在網站的「設定」頁面調整，不需要改程式碼。

## 改完之後怎麼上線

目前系統跑在 **Docker**（`docker-compose.yml` 定義的 `backend` container），整個專案資料夾是直接掛進 container 裡的（bind mount），所以改完檔案不需要重新 `docker compose build`，但**前端跟後端的套用方式不一樣**，這點很容易搞混：

### 只改了畫面（`client/` 底下的 `.jsx` / `.css` 檔案）

必須重新打包，不然畫面不會更新：

```powershell
cd client
npm run build
```

打包完，`client/dist` 資料夾會更新，Docker 裡的後端會直接讀到新的檔案，**不需要重開 container**，重新整理瀏覽器（建議 Ctrl+F5 強制重新整理，避免瀏覽器快取舊版）就會看到新畫面。

### 改了後端（`server/` 底下的檔案，例如資料庫欄位、API 路由）

改完除了存檔，還要**手動重啟 container**：

```powershell
docker compose restart backend
```

⚠️ 這台機器上實測過，Docker 在 Windows 用 bind mount 跑的時候，後端本來設計成「檔案一改就自動重啟」的機制（`node --watch`）不一定會真的觸發，即使 log 看起來完全正常、沒有任何錯誤，資料庫新欄位或新的 API 路由還是有可能沒套用。所以改完後端程式碼，**務必手動跑一次 `docker compose restart backend`**，不要只憑感覺覺得應該有生效。

### 確認真的上線了

```powershell
docker compose logs backend --tail 20   # 確認沒有錯誤訊息、有看到 "server listening on http://localhost:4000"
curl http://localhost:4000/             # 本機應該回應正常（或直接開瀏覽器看）
```

外網網址（cloudflared 那個 `https://xxx.trycloudflare.com`）如果還在跑，重新整理瀏覽器確認一下畫面也更新了。

### 想要留存修改記錄、或同步到其他電腦

這台機器改完之後，如果想讓 GitHub 上的原始碼也跟著更新（例如要在其他電腦上也套用這次修改），要另外做 git 的 commit + push：

```powershell
git add -A
git commit -m "說明這次改了什麼"
git push
```

這一步**不是必須的**——不 push 也完全不影響這台機器現在跑的網站，push 只是為了讓 GitHub 上的紀錄跟這台機器同步。

## 之前踩過的坑（改設定/程式碼時注意）

- **`CLIENT_URL`（`server/.env`）沒列到目前的存取網址，LINE 登入完會被導到錯的網址**：如果之後又新增了新的對外網址（例如 cloudflared 網址換了），記得同步更新 `server/.env` 的 `CLIENT_URL`，並照上面「改了後端」的步驟重啟 container。
- **cloudflared 免費網址每次重啟都會換**：換了之後要記得更新 GitHub Webhook、LINE Callback URL、`CLIENT_URL` 這三個地方，詳見 `README.md`「遠端／對外上線」那節。

更完整的系統功能說明、部署細節，見專案根目錄的 `README.md` 跟 `docs/DEPLOY_AUTO_PULL.md`。
