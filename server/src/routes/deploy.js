import { Router } from 'express';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// server/src/routes -> server/src -> server -> 專案根目錄（git repo 所在位置）
const projectRoot = path.resolve(__dirname, '../../../');

export const deployRouter = Router();

// GitHub push 後打這個 webhook 觸發 git pull，讓伺服器自動拉取最新程式碼，不需要手動登入操作。
// 後端本身是用 `node --watch` 啟動，pull 下來的檔案變動會讓 Node 自動重啟套用新程式碼，這裡不用額外重啟。
// 用共用密鑰（DEPLOY_WEBHOOK_SECRET）驗證，避免任何人都能觸發；密鑰請放在 query string 或 x-deploy-secret 標頭。
deployRouter.post('/', (req, res) => {
  const secret = req.query.secret || req.headers['x-deploy-secret'];
  const expected = process.env.DEPLOY_WEBHOOK_SECRET;
  if (!expected || secret !== expected) {
    return res.status(403).json({ error: 'forbidden' });
  }

  execFile('git', ['pull'], { cwd: projectRoot }, (err, stdout, stderr) => {
    if (err) {
      console.error('[deploy] git pull 失敗:', stderr || err.message);
      return res.status(500).json({ error: 'git pull failed', detail: stderr || err.message });
    }
    console.log('[deploy] git pull 完成:', stdout.trim());
    res.json({ ok: true, output: stdout });
  });
});
