# 把 sqlite_data named volume 裡的 app.db 備份成一個帶時間戳記的檔案。
# 用法： .\scripts\backup-db.ps1
# 備份會落在 repo root 的 backups\ 目錄（已加進 .gitignore，不會被 commit）。
#
# 用 `docker compose run` 借用 backend service 既有的 sqlite_data 掛載，
# 不自己猜 named volume 的實際名稱（compose project name 會依目錄名正規化，猜容易猜錯）。
$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

New-Item -ItemType Directory -Force -Path "backups" | Out-Null
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"

docker compose run --rm --no-deps `
  -v "${repoRoot}\backups:/backup" `
  --entrypoint sh `
  backend `
  -c "cp /app/server/data/app.db /backup/app-$timestamp.db"

Write-Host "備份完成：backups\app-$timestamp.db"
