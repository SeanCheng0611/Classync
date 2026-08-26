# Build context 必須是 repository root（因為用 npm workspaces，見 docker-compose.yml 的 `context: ..`）。
#
# 這個 image 同時要能跑 backend，也要能執行既有的自動部署 webhook
# （server/src/routes/deploy.js：git pull + npm run build client），
# 所以裝的是 git 與完整 workspace 依賴（含 client 的 devDependencies，例如 vite），
# 不是單純 production-only 的 backend image。這是配合現有部署機制的取捨，不是疏忽。
#
# node:sqlite（server/src/db/index.js）是 Node 內建模組，需要 Node >= 22.5，這裡用 24 對齊開發機版本。
FROM node:24-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先只複製 package manifest 以利用 Docker layer cache，依賴沒變時不用重跑 npm ci
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY client/package.json client/package.json
RUN npm ci

COPY . .

EXPOSE 4000

# 用 --watch 對齊現有 bare-metal 部署行為：git pull 落地新檔案後自動重啟，
# 不需要額外的 restart/rebuild 步驟。
CMD ["npm", "run", "dev", "--workspace", "server"]
