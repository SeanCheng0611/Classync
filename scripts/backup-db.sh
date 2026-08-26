#!/usr/bin/env bash
# 把 sqlite_data named volume 裡的 app.db 備份成一個帶時間戳記的檔案。
# 用法： ./scripts/backup-db.sh
# 備份會落在 repo root 的 backups/ 目錄（已加進 .gitignore，不會被 commit）。
#
# 用 `docker compose run` 借用 backend service 既有的 sqlite_data 掛載，
# 不自己猜 named volume 的實際名稱（compose project name 會依目錄名正規化，猜容易猜錯）。
set -euo pipefail

cd "$(dirname "$0")/.."

mkdir -p backups
timestamp=$(date +%Y%m%d-%H%M%S)

docker compose run --rm --no-deps \
  -v "$(pwd)/backups:/backup" \
  --entrypoint sh \
  backend \
  -c "cp /app/server/data/app.db /backup/app-${timestamp}.db"

echo "備份完成：backups/app-${timestamp}.db"
