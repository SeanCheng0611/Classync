import { Server } from 'socket.io';

let io;

export function initRealtime(httpServer, clientUrl) {
  io = new Server(httpServer, {
    cors: { origin: clientUrl, credentials: true },
  });

  io.on('connection', (socket) => {
    socket.on('join-school', (schoolId) => {
      socket.join(`school:${schoolId}`);
    });
    socket.on('leave-school', (schoolId) => {
      socket.leave(`school:${schoolId}`);
    });
  });

  return io;
}

// 任一模組寫入資料後呼叫，通知同一補習班內的其他裝置重新拉取該資源
export function broadcastChange(schoolId, resource) {
  if (!io) return;
  io.to(`school:${schoolId}`).emit('data:changed', { resource });
}

// 成員權限被變更時呼叫，通知該使用者的裝置強制重新整理頁面（重新登入/取得最新權限）
export function broadcastForceReload(schoolId, userId) {
  if (!io) return;
  io.to(`school:${schoolId}`).emit('force-reload', { user_id: userId });
}
