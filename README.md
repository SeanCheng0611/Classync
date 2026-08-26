# 補習班營運系統

Node.js + Express + SQLite 後端、React (Vite) 前端，本機常駐伺服器架構，支援多間補習班（多租戶）。

## 啟動方式

```
cd server && npm install && npm run dev   # http://localhost:4000
cd client && npm install && npm run dev   # http://localhost:5173
```

`server/.env`（可複製 `server/.env.example`）：

- `DEV_LOGIN=true`：開啟開發用假登入 API（`POST /auth/dev/login`，登入頁 UI 已移除此表單，僅供開發時用 API 工具或測試腳本呼叫），免 LINE 帳號即可測試整套系統。正式上線前應設為 `false`。
- `LINE_CHANNEL_ID` / `LINE_CHANNEL_SECRET`：至 [LINE Developers Console](https://developers.line.biz/console/) 建立一個 **LINE Login** channel 取得。取得後需在該 channel 的「LINE Login」分頁設定 Callback URL 為 `http://localhost:4000/auth/line/callback`（LINE 允許 `localhost` 作為開發測試網址）。
- `JWT_SECRET`：任意隨機字串，用來簽發登入 session。

## 權限模型

- **平台最高權限者（owner）**：系統第一位登入者自動取得，可跨補習班刪除整間補習班。僅此身分擁有此權限。
- **管理者（admin）**：可管理所屬補習班的所有資料（學生、教師、課表、點名、座位、收支、成員），可移除成員，但不能刪除補習班本身。
- **教師（teacher）**：唯讀。只能看到自己任教的學生、課表、點名與出缺勤紀錄，看不到其他教師或未指派給自己的學生資料，也無法修改任何點名紀錄。教師點名已停用（見下方計費模式），教師僅能查看學生點名結果。

## 一次性邀請碼

成員加入補習班一律透過邀請碼，沒有可重複使用的通用邀請碼：

1. 管理者在「成員管理」頁先選擇對象身分（共同管理者，或從既有教師檔案中選一位教師），才能產生邀請碼。
2. 產生的碼僅能使用一次，兌換後立即失效；教師身分的碼兌換後會自動連結到對應的教師檔案。
3. 開發測試可用 `DEV_LOGIN` 的假登入表單快速建立多個帳號來模擬不同角色互動。

## 計費模式

### 學費（繳費單系統）

- 每堂課（固定課堂／調課／加課）可個別設定「單堂價錢」，記在該學生與該堂課的關聯上；學生檔案上的「次繳費金額」是沒有排課明細時的估算備援值（僅用於新增學生時的參考）。
- 學費收入的唯一權威來源是「繳費單」（`invoices` / `invoice_items` 資料表）：管理者在「繳費單」頁選擇學生，逐月挑選「已出席」的課堂（可跨月累積待開立清單），按「開立繳費單」建立一張繳費單。每堂課只能被開立一次，已開立過的課堂會標記「已開立」且無法重複勾選；刪除繳費單會釋放其中的課堂供重新開立。
- 收支統計頁的「產生本月學費」讀取「本月開立」的繳費單（依開立日期所在月份），每張繳費單對應一筆收支明細；重複點擊會同步更新既有明細金額（例如刪除繳費單項目後金額變動）。

### 薪資（教師端）

- 教師薪資不再依賴點名出缺勤，而是直接依「該教師名下的排課」計算：只要課堂存在（固定課堂展開、調課、加課皆算），就依時數 × 對應時薪計入，無論該堂課實際點名結果為何。
- 課堂依是否有學生分兩類：有學生的課堂依學生年級組成套用對應年級時薪（1-6 / 7-9 / 10-12）；沒有學生的課堂視為「行政時段」，套用行政時薪。
- 教師詳細頁可管理兩種行政時數：「固定行政時段」（每週固定，比照學生固定課堂的樣板機制）與「手動新增行政時數」（單次，比照學生加課）。
- 收支統計頁的「產生本月教師薪資」與教師詳細頁的「課堂與薪資明細」共用同一套計算邏輯。

### 收支明細

- 收支明細裡的金額欄位（無論是自動產生的學費/薪資，或手動輸入的項目）都可以事後點「編輯」修改。
- 學費與薪資分錄都可以「查看明細」展開逐堂課清單（薪資明細含學生姓名）。

## 即時同步

多裝置開啟同一補習班時，透過 Socket.io 即時同步資料異動（不需要背景常駐推播，僅網頁開啟時同步）。

## 區網存取（讓其他裝置也能用）

前端會自動依「目前網頁的網址」對應到同一台主機的後端（例如用 `http://192.168.x.x:5173` 開，就會自動打 `http://192.168.x.x:4000`），不需要另外設定。步驟：

1. `client/vite.config.js` 已加上 `server: { host: true }`，讓 Vite 監聽區網介面。
2. `server/.env` 的 `CLIENT_URL` 用逗號分隔列出所有允許的來源，例如 `http://localhost:5173,http://192.168.0.134:5173`。
3. 若要讓其他裝置也能用 LINE 登入，需在 LINE Developers Console 的 Callback URL 額外加一筆 `http://<區網IP>:4000/auth/line/callback`（原本 localhost 那筆保留），後端會依實際存取的網址自動選用對應的 callback，不需要另外設定環境變數。

**注意**：不要把 `client/.env.development` 的 `VITE_API_URL` 寫死成固定網址，因為 `localhost` 與 IP 位址在瀏覽器眼中是不同的 cookie「site」，寫死會導致其中一種存取方式的登入 cookie 被擋掉。保持自動偵測即可同時支援兩種存取方式。

## Docker（Infrastructure，選用）

目前主要部署方式仍是「本機常駐 + Git 自動部署」（見下方「自動部署」），Docker 是額外提供的
可移植跑法，換開發機或換伺服器時不用重新手動裝 Node 版本、建目錄。兩種跑法互不衝突，挑一種用即可。

```powershell
docker compose up -d --build   # 啟動（第一次或程式碼變動後）
docker compose logs -f         # 看 log
docker compose ps              # 看狀態
docker compose down            # 停止（不會刪資料，volume 保留）
```

Backend container 用 bind mount 把整個專案目錄掛進去，所以既有的自動部署 webhook
（`git pull` + 重新 build client，見 `docs/DEPLOY_AUTO_PULL.md`）在 container 裡跑法完全一樣，
不需要另外改部署流程。`server/.env` 要先準備好（複製 `server/.env.example`），docker-compose 會自動讀取。

**在正式在跑服務的機器上要切換成 Docker 時**：`git push` 只會透過既有的自動部署 webhook
觸發 `git pull`，**不會自動啟動 Docker**——這些 Docker 設定檔本身是無害的靜態檔案，pull 下來也
不影響原本 bare-metal 跑法一根汗毛，正式切換永遠是你自己在那台機器上手動執行 `docker compose up`
才會發生的事。建議每次要切換前：
1. 先用替代 port（例如 `$env:PORT=4002; docker compose up -d backend`）跑一次、照上面「Database」
   章節的步驟匯入資料、實際查過資料筆數確認無誤，完全不會動到正式在跑的 port（通常是 4000）。
2. 確認沒問題後，才停掉原本 bare-metal 的 process、把 Docker 改成監聽正式 port 重新啟動。
3. 若要退回 bare-metal，直接 `docker compose down`（不加 `-v`，volume 資料還在），重新
   `node --watch src/index.js` 即可，`server/data/app.db` 本身沒被動過。

## Database

- 資料庫是 SQLite（Node 內建 `node:sqlite`，非 better-sqlite3），檔案位置 `server/data/app.db`
  （WAL 模式，另有 `.db-wal` / `.db-shm`）。Schema 與 migration 邏輯見 `server/src/db/index.js`，
  開機時自動套用，不需要手動下 migration 指令。
- **用 Docker 跑之前，如果 `server/data/` 已經有既有資料**，named volume（`sqlite_data`）是空的，
  需要先把現有 `app.db` 匯入進去一次。

  ⚠️ **務必照下面的步驟做，不要用 `docker compose cp` / `docker compose exec` 對著「已經在跑（或有
  `restart: unless-stopped` 政策、隨時可能被自動拉起）」的 backend service 動資料庫檔案**——這樣做
  曾經在測試時造成資料被清空（container 自己開機時建立的空白資料庫殘留 WAL 側檔，被誤判為已匯入，
  重啟後舊的空白內容蓋掉了剛複製進去的正式資料）。正確做法是全程只用**一次性、不帶 restart 政策的
  `docker compose run --rm` container**，不牽涉任何常駐 process：

  ```powershell
  docker compose down   # 確保沒有任何 backend container 正在跑

  # 用一次性 container，把 host 的 server/data 唯讀掛進去，在 container 內部直接複製
  # （不要用 docker compose cp，那是透過 tar 傳輸，需要目標 container 存在/在跑，容易跟其他操作競速）
  docker compose run --rm --no-deps `
    -v "${PWD}\server\data:/host-data:ro" `
    --entrypoint sh backend `
    -c "rm -f /app/server/data/app.db /app/server/data/app.db-wal /app/server/data/app.db-shm; cp /host-data/app.db /app/server/data/app.db"

  docker compose up -d backend   # 這時才啟動常駐服務
  ```

  之後同一台機器上就會持續使用這個 volume，不用再重複這個步驟。建議匯入後先查一次實際資料筆數
  （不要只比對檔案大小——檔案大小相同不代表內容正確）：
  ```powershell
  docker compose exec backend node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/app/server/data/app.db');console.log(db.prepare('SELECT COUNT(*) c FROM students').get())"
  ```
- 備份：`.\scripts\backup-db.ps1`（或 Linux/Mac 用 `scripts/backup-db.sh`），會把目前的
  `app.db` 複製一份到 `backups/`（已 gitignore，不會進 git）。

## 已知限制 / 待辦

- 目前僅支援本機常駐部署，未提供雲端部署設定。
- 座位系統、課表系統的「新增固定課堂」若從學生詳細頁發起，一律建立僅含該學生的新樣板；若要多位學生共用同一堂課，請從「課表」頁的樣板表單一次選取多位學生。
- 教師薪資與學生學費的自動試算僅供參考，最終仍需管理者於收支頁確認或編輯金額。
