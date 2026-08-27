# 補習班營運系統

Node.js + Express + SQLite 後端、React (Vite) 前端，本機常駐伺服器架構，支援多間補習班（多租戶）。

想改畫面上的文字/按鈕/寬度、不確定該去哪個檔案改、改完要怎麼讓正式網站套用，見 `docs/UI_EDITING_GUIDE.md`。

## 啟動方式

```
cd server && npm install && npm run dev   # http://localhost:4000
cd client && npm install && npm run dev   # http://localhost:5173
```

`server/.env`（可複製 `server/.env.example`）：

- `DEV_LOGIN=true`：開啟開發用假登入 API（`POST /auth/dev/login`，登入頁 UI 已移除此表單，僅供開發時用 API 工具或測試腳本呼叫），免 LINE 帳號即可測試整套系統。正式上線前應設為 `false`。
- `LINE_CHANNEL_ID` / `LINE_CHANNEL_SECRET`：至 [LINE Developers Console](https://developers.line.biz/console/) 建立一個 **LINE Login** channel 取得。取得後需在該 channel 的「LINE Login」分頁設定 Callback URL 為 `http://localhost:4000/auth/line/callback`（LINE 允許 `localhost` 作為開發測試網址）；若還會用區網 IP 或對外網址（見下方「區網存取」「遠端／對外上線」）存取，記得把每一種實際會用到的網址都加進 Callback URL 清單，不然登入到一半 LINE 會直接擋下來。
- `JWT_SECRET`：任意隨機字串，用來簽發登入 session。
- `CLIENT_URL`：用逗號分隔列出所有「會用來存取這個網站」的完整網址（含 port），詳見下方「區網存取」——這個清單沒列到的網址，登入完成後會被導到清單第一筆，不是導回你原本在用的那個網址，很容易誤以為系統壞掉。

## 權限模型

- **平台最高權限者（owner）**：系統第一位登入者自動取得，可跨補習班刪除整間補習班。僅此身分擁有此權限。
- **管理者（admin）**：可管理所屬補習班的所有資料（學生、教師、課表、點名、座位、收支、成員），可移除成員，但不能刪除補習班本身。
- **櫃台（front_desk）**：對學生檔案、教師檔案、課表、點名、座位系統這五項子系統有完整操作權限（跟 admin 相同），但看不到、也不能動財務資料（收支、繳費單、薪資條）與成員管理（邀請碼）。
- **教師（teacher）**：唯讀。只能看到自己任教的學生、課表、點名與出缺勤紀錄，看不到其他教師或未指派給自己的學生資料，也無法修改任何點名紀錄。教師點名已停用（見下方計費模式），教師僅能查看學生點名結果。

## 一次性邀請碼

成員加入補習班一律透過邀請碼，沒有可重複使用的通用邀請碼：

1. 管理者在「成員管理」頁先選擇對象身分（共同管理者，或從既有教師檔案中選一位教師），才能產生邀請碼。
2. 產生的碼僅能使用一次，兌換後立即失效；教師身分的碼兌換後會自動連結到對應的教師檔案。
3. 開發測試可用 `DEV_LOGIN` 的假登入表單快速建立多個帳號來模擬不同角色互動。

## 課表與請假調課

- 週檢視課表，可新增：單次排課、固定課堂樣板（每週固定時段，可一次選多位學生共用同一堂課）。排課表單是彈窗（跟調課一樣置中顯示），單堂模式選完學生／科目／教師會自動依序跳到下一個欄位，日期/時間留給使用者自己填。若從學生詳細頁發起新增固定課堂，一律建立僅含該學生的新樣板；多位學生共用同一堂課要從「課表」頁的樣板表單一次選取。
- 展開課堂卡片後，每位學生會同時顯示「出席」「請假」「調課」三個按鈕（同一橫排、不會換行）：出席／請假可直接在課表頁標記，不用切去點名頁；調課可改時間、改教師，會連動搬移座位資料（見下方「座位系統」）。
- 請假：釋出該學生原本的座位，不影響同堂課其他學生。
- 課堂類型（固定課／調課／加課／請假）各有顏色與排序，可在「設定」頁自訂。

## 點名

- 記錄每堂課每位學生的出缺勤狀態，可直接在點名頁發起請假／調課。
- 教師薪資不依賴點名結果計算（見下方「計費模式」），點名主要用於學費對帳與出缺勤紀錄留存。
- 可匯出簽到表（Excel）。

## 座位系統

- 依日期＋時段管理座位版面，桌數可自訂新增（「+」）/刪除（「-」），透過拖曳調整整體排版。
- 支援拖曳排課：把「上課資訊」列表裡的課堂直接拖進座位；也可以在兩張桌子之間拖曳互換課堂資料。
- 拖曳搬移「桌子本身在版面上的位置」只有兩桌都是**完全空桌**（所有時段都沒排課）時才會生效——兩桌都空才會真的對調桌號版面位置；只要任一桌有排課，拖曳只會跟目標桌互換課堂資訊，不會動到版面位置，避免手滑把已經排好的桌子版面弄亂。
- 「上課資訊」清單固定依開始時間／結束時間／教師名／學生名排序；同一位教師若同時有兩堂課，會強制排在相鄰兩列，方便對照同一位教師的兩個時段。
- 「清空全部座位」可一鍵清空當天所有桌子、所有時段已排的課堂資料（會先跳確認視窗），方便打掉重練後用「自動排座位」重新排一次。
- 可匯出座位表（Excel）。

## 記事本

- 多分類待辦／備註，分類可自訂新增；可勾選完成、可連結到特定學生或教師（連結後會在該學生／教師詳細頁雙向顯示）。
- 可匯出（Excel）。

## 回收桶

- 刪除學生、教師、課堂、記事、繳費單等資料時是軟刪除，先進回收桶，可還原或直接永久刪除。
- 回收桶內的項目 **14 天後由背景程序自動永久清除**，逾期無法還原。

## Excel 匯入／匯出

- 學生、教師頁支援 Excel 批次匯入：遇到同名資料會逐筆或批次（全部新增／全部略過）確認；遇到匯入資料裡的科目文字不在目前科目選單中，會跳出對應/新增/略過的選擇彈窗。
- 點名、座位、記事本、收支等頁面支援匯出成自訂樣式（自訂字型、框線）的 Excel 檔，共用邏輯在 `client/src/lib/excelExport.js`。

## 其他介面細節

- 學生檔案、教師檔案的搜尋姓名欄位，進入頁面時會自動 focus（桌面環境直接打字就能搜尋）；觸控裝置（手機/平板）不會自動 focus，避免一進頁面就跳出虛擬鍵盤。
- 繳費單、薪資開立的學生/教師列表，點整列（不限姓名那個連結）都能進入該學生/教師的開立頁面。

## 設定

- 管理者可自訂：科目選單、課堂類型顏色、課表/點名的排序方式、時間選單範圍、學費級距預設值、固定課堂預設展開月數、一對多班級人數上限等，皆存在該補習班的設定資料裡，不需要改程式碼。
- 「設定」頁面本身的各個區塊也可以拖曳調整順序（每個區塊前面有 ⠿ 把手），分成「排課設定」「收費與科目」兩個分類，只能在同一分類內拖曳，不會跨分類混在一起；預設順序是依區塊標題的字數由少到多排列，拖曳調整後會立即儲存。

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
2. `server/.env` 的 `CLIENT_URL` 用逗號分隔列出所有允許的來源，例如 `http://localhost:5173,http://192.168.0.134:5173`。用 Docker 跑（前後端同一個 port）的話就列 `:4000` 版本，例如 `http://localhost:4000,http://192.168.0.134:4000`；兩種跑法同時保留也沒關係，多列幾筆不衝突。
3. 若要讓其他裝置也能用 LINE 登入，需在 LINE Developers Console 的 Callback URL 額外加一筆 `http://<區網IP>:4000/auth/line/callback`（原本 localhost 那筆保留），後端會依實際存取的網址自動選用對應的 callback，不需要另外設定環境變數。

**注意**：不要把 `client/.env.development` 的 `VITE_API_URL` 寫死成固定網址，因為 `localhost` 與 IP 位址在瀏覽器眼中是不同的 cookie「site」，寫死會導致其中一種存取方式的登入 cookie 被擋掉。保持自動偵測即可同時支援兩種存取方式。

⚠️ **`CLIENT_URL` 沒列到的網址會靜默 fallback，不會報錯**：LINE 登入完成後，後端會把目前這次登入的來源網址拿去比對 `CLIENT_URL` 清單，比對不到就直接導回清單「第一筆」——不是你剛剛在用的那個網址。實際發生過的狀況：從 Docker（`:4000`）切換上線後，`CLIENT_URL` 忘記更新、還停留在只有 `:5173`（開發用的 Vite dev server）的舊清單，登入完成後就被導去一個根本沒有服務在跑的 `localhost:5173`，畫面顯示「拒絕連線」，看起來像整個系統壞掉，其實只是這個清單沒更新。改完 `CLIENT_URL` 記得要讓後端重新讀取環境變數才會生效（bare-metal 直接重開 `node` process；Docker 是 `docker compose up -d --force-recreate backend`，光改檔案、不重建 container 不會生效）。

## 遠端／對外上線（讓補習班以外的人也能連）

目前用的是 [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) 的**免費快速通道**（`cloudflared tunnel --url http://localhost:4000`），不需要申請網域、不需要在路由器開 port，跑起來就會給一個 `https://<隨機字串>.trycloudflare.com` 的公開網址，直接把流量轉給本機 4000 port。

```powershell
cloudflared tunnel --url http://localhost:4000
```

⚠️ **這組免費網址每次 cloudflared 重啟（重開機、斷線重連、手動重跑）都會換一組新的**，網址一換，下面兩個地方都要記得手動更新，不然對外的功能會看起來「壞了」但其實只是網址舊了：

1. **GitHub Webhook**：自動部署用的 Payload URL，設定與細節見 `docs/DEPLOY_AUTO_PULL.md`。
2. **LINE Developers Console 的 Callback URL**：要有 `https://<目前的 cloudflared 網址>/auth/line/callback` 這一筆，不然用外部網址登入 LINE 會直接被擋（跟區網存取那節的道理一樣，只是這次是對外網址）；同時 `server/.env` 的 `CLIENT_URL` 也要包含這個網址（見上方「⚠️ CLIENT_URL 沒列到的網址會靜默 fallback」）。

長期若不想每次網址變動都要手動改三個地方，可以申請網域＋設定 Cloudflare 帳號的「具名 Tunnel」（不是快速通道），網址就會固定不變；這不在目前的設定範圍內，之後有需要再處理。

### 開機自動啟動（Windows）

Docker Desktop 跟 cloudflared 都是一般應用程式，不會因為設了 `restart: unless-stopped` 就自動在開機時啟動——那個政策只保證「Docker Desktop 本身已經在跑」時 container 會自動恢復，Docker Desktop 這個應用程式要嘛手動開，要嘛額外設定開機啟動。用工作排程器（Task Scheduler）幫兩者各建一個「登入時啟動」的工作：

```powershell
# 這兩段都要在「系統管理員」PowerShell 裡執行
$dockerExe = "$env:LOCALAPPDATA\Programs\DockerDesktop\Docker Desktop.exe"
Register-ScheduledTask -TaskName "CramSchool - Docker Desktop AutoStart" -Force `
  -Action (New-ScheduledTaskAction -Execute $dockerExe) `
  -Trigger (New-ScheduledTaskTrigger -AtLogOn) `
  -Settings (New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable)

$trigger = New-ScheduledTaskTrigger -AtLogOn
$trigger.Delay = "PT30S"   # 延遲 30 秒，等 Docker Desktop 先起來
Register-ScheduledTask -TaskName "CramSchool - Cloudflared AutoStart" -Force `
  -Action (New-ScheduledTaskAction -Execute "cmd.exe" -Argument '/c "C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:4000') `
  -Trigger $trigger `
  -Settings (New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable)
```

Container 本身不用另外設定——`docker-compose.yml` 已有 `restart: unless-stopped`，Docker Desktop 一起來，之前在跑的 container 就會自動跟著恢復。重開機後記得回來確認新的 cloudflared 網址，並更新上面提到的 GitHub Webhook / LINE Callback URL / `CLIENT_URL` 三個地方。

## Docker（Infrastructure，選用）

Bare-metal（本機常駐 `node --watch`）跟 Docker 兩種跑法都完整測試過、互不衝突，挑一種用即可；換開發機或換伺服器時用 Docker 不用重新手動裝 Node 版本、建目錄。上面「遠端／對外上線」那節示範的正式環境就是跑在 Docker 上。

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

- 沒有真正的雲端/IaaS 部署設定：無論 bare-metal 或 Docker，跑的都還是自己這台機器，對外只靠「遠端／對外上線」那節講的 Cloudflare 免費通道打洞出去，不是把服務架到雲端主機上。
- ⚠️ **手動 `git pull` 不會自動重新 build 前端**：只有 GitHub 打自動部署 webhook（`server/src/routes/deploy.js`）才會在 `git pull` 之後接著 `npm run build` 前端。如果是自己手動在機器上 `git pull`（例如維護、debug 時），`client/dist` 不會跟著更新，畫面會停留在舊版本，即使原始碼已經是新的——這種情況下要記得自己手動跑一次 `cd client && npm run build`（Docker 跑法下不需要進 container，因為整個專案目錄是 bind mount，在 host 上 build 出的 `client/dist` container 也看得到）。
- ⚠️ **Docker（Windows）下 `node --watch` 不一定會自動偵測到後端程式碼變動**：實測過在 Windows 用 bind mount 跑 Docker Desktop 時，改了 `server/src/**` 底下的檔案（例如新增 migration、路由），container 裡的 `node --watch` 沒有觸發重啟，導致資料庫 migration 沒套用、新路由 404，即使 log 看起來沒有任何錯誤。bare-metal（`node --watch src/index.js` 直接在 host 上跑）目前沒觀察到這個問題，只有 Docker 這個組合才需要注意。改完後端程式碼、且透過 Docker 跑的話，保險做法是直接 `docker compose restart backend` 確認真的重啟過，不要只憑「檔案存起來了」就假設 container 已經套用。
- 教師薪資與學生學費的自動試算僅供參考，最終仍需管理者於收支頁確認或編輯金額。
