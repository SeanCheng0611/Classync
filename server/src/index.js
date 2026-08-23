import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { createServer } from 'node:http';
import './db/index.js';
import { authRouter } from './routes/auth.js';
import { schoolsRouter } from './routes/schools.js';
import { studentsRouter } from './routes/students.js';
import { teachersRouter } from './routes/teachers.js';
import { scheduleTemplatesRouter } from './routes/scheduleTemplates.js';
import { sessionsRouter } from './routes/sessions.js';
import { attendanceRouter } from './routes/attendance.js';
import { inviteCodesRouter, redeemRouter } from './routes/inviteCodes.js';
import { seatsRouter } from './routes/seats.js';
import { financeRouter } from './routes/finance.js';
import { invoicesRouter } from './routes/invoices.js';
import { payslipsRouter } from './routes/payslips.js';
import { notesRouter } from './routes/notes.js';
import { devRouter } from './routes/dev.js';
import { requireAuth } from './auth/middleware.js';
import { initRealtime } from './realtime/index.js';

const app = express();
// 讓 req.protocol / req.get('host') 採信來自 Vite dev server proxy（或通道服務）轉發的 X-Forwarded-* 標頭，
// 這樣 LINE Login 的 redirect_uri 才能正確組出外部實際存取的網址（而不是內部 proxy 轉發時的 localhost）
app.set('trust proxy', true);
// CLIENT_URL 可用逗號分隔多個來源（例如同時允許 localhost 與區網 IP 存取）
const allowedOrigins = (process.env.CLIENT_URL || 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json());
app.use(cookieParser());

app.use('/auth', authRouter);
app.use('/api/schools', schoolsRouter);
app.use('/api/schools/:schoolId/students', requireAuth, studentsRouter);
app.use('/api/schools/:schoolId/teachers', requireAuth, teachersRouter);
app.use('/api/schools/:schoolId/schedule-templates', requireAuth, scheduleTemplatesRouter);
app.use('/api/schools/:schoolId/sessions', requireAuth, sessionsRouter);
app.use('/api/schools/:schoolId/attendance', requireAuth, attendanceRouter);
app.use('/api/schools/:schoolId/invite-codes', requireAuth, inviteCodesRouter);
app.use('/api/invite-codes', redeemRouter);
app.use('/api/schools/:schoolId/seats', requireAuth, seatsRouter);
app.use('/api/schools/:schoolId/finance', requireAuth, financeRouter);
app.use('/api/schools/:schoolId/invoices', requireAuth, invoicesRouter);
app.use('/api/schools/:schoolId/payslips', requireAuth, payslipsRouter);
app.use('/api/schools/:schoolId/notes', requireAuth, notesRouter);
app.use('/api/dev', devRouter);

app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/', (req, res) =>
  res.type('text/plain').send('補習班營運系統 API 伺服器運作中。這裡沒有網頁畫面，請開啟前端網址（預設 http://localhost:5173）。')
);

const httpServer = createServer(app);
initRealtime(httpServer, allowedOrigins);

const port = process.env.PORT || 4000;
httpServer.listen(port, () => {
  console.log(`server listening on http://localhost:${port}`);
});
