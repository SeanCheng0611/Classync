# 自動部署設定（GitHub push → 伺服器自動 git pull）

這份文件只需要在**實際跑正式伺服器的那台裝置**上操作一次。設定完成後，之後只要在任何一台電腦
`git push` 到 GitHub，伺服器就會自動 `git pull` 套用最新程式碼，不需要再手動登入伺服器操作。

## 運作原理

- 新增了 `POST /api/deploy-webhook` 端點（見 `server/src/routes/deploy.js`），收到請求後會在專案根目錄執行 `git pull`。
- 後端本來就是用 `node --watch src/index.js` 啟動，`git pull` 拉下來的檔案變動會讓 Node 自動重啟套用新程式碼，
  資料庫 migration 也會在重啟時一併套用，**不需要手動重啟任何東西**。
- 用共用密鑰驗證這個端點，避免任何人隨便打就觸發部署。
- GitHub 那邊設定 Webhook，只要有人 push 到這個 repo，GitHub 就會自動打這個端點一次。

## 設定步驟（在伺服器那台裝置上執行）

### 1. 拉取這次的更新（把 deploy-webhook 端點本身抓下來）

```powershell
cd "cram school"
git pull
```

這是**最後一次需要手動 pull**——因為要先有這支端點，後面才能自動化。

### 2. 產生一組隨機密鑰，加進 `server/.env`

用底下指令產生一組隨機字串（或自己想一組夠長、夠亂的字串也可以）：

```powershell
-join ((48..57)+(65..90)+(97..122) | Get-Random -Count 32 | ForEach-Object {[char]$_})
```

把產生出來的字串貼到 `server/.env` 最後面：

```
DEPLOY_WEBHOOK_SECRET=剛剛產生的那串亂碼
```

存檔後，因為後端是 `--watch` 模式，會自動重啟套用這個新的環境變數
（如果沒有自動生效，手動重開一次 `node --watch src/index.js` 即可）。

### 3. 到 GitHub 設定 Webhook

1. 打開 repo：`https://github.com/SeanCheng0611/Classync`
2. **Settings → Webhooks → Add webhook**
3. **Payload URL** 填：
   ```
   https://<目前的 cloudflared 網址>/api/deploy-webhook?secret=<步驟2 那組密鑰>
   ```
   例如：`https://frame-reporter-webcast-writer.trycloudflare.com/api/deploy-webhook?secret=xxxx`
4. **Content type** 選 `application/json`
5. **Which events** 選預設的「Just the push event」
6. 按 **Add webhook**

GitHub 會馬上打一次測試請求，可以在 Webhook 頁面下方的「Recent Deliveries」看到是不是回傳 200。

## 之後的日常流程

任何一台電腦（包含這台）改完程式碼後：

```powershell
git add .
git commit -m "說明這次改了什麼"
git push
```

push 上去幾秒內，伺服器就會自動 `git pull` 並套用，全程不需要手動登入伺服器操作。

## ⚠️ 重要提醒：cloudflared 快速通道網址會變

`trycloudflare.com` 這種免費快速通道（`cloudflared tunnel --url ...`）的網址，**只要那個 cloudflared
process 被重啟（重開機、斷線重連等），網址就會換一個新的**。網址一換，GitHub Webhook 裡填的 Payload URL
就會失效，需要回到 GitHub Webhook 設定頁面手動更新成新網址。

如果不想每次網址變動都要手動改，長期建議：
- 申請一個網域，搭配 Cloudflare 帳號設定「具名 Tunnel」（不是快速通道），網址就會固定不變；或
- 用 DDNS（動態網域）+ 自己的網域名稱代替 trycloudflare.com。

這兩者都需要額外申請網域/設定 Cloudflare 帳號，不在這份文件範圍內，之後有需要再另外處理。

<!-- webhook 驗證測試標記：2026-08-25，設定完成後用這行 commit 驗證自動 pull 是否生效 -->
