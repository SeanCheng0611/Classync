import { io } from 'socket.io-client';
import { API_URL } from './api';

// API_URL 為空字串代表走同源（透過 Vite proxy 轉發），io() 不帶網址即會連到目前頁面所在的 origin
export const socket = io(API_URL || undefined, { autoConnect: true, withCredentials: true });

// 同一個 socket 是全站共用的單例，可能同時有多個元件（例如 AuthContext 全域訂閱 + 當下頁面各自訂閱）
// 訂閱同一間補習班；用 refcount 記錄還有幾個訂閱者在用該房間，避免其中一個先解除訂閱時
// 把 leave-school 送出去，害同一個 socket 上其他還在用的訂閱者也收不到即時通知
const roomRefCounts = new Map();

export function subscribeSchool(schoolId, onChange) {
  roomRefCounts.set(schoolId, (roomRefCounts.get(schoolId) || 0) + 1);
  socket.emit('join-school', schoolId);
  const handler = ({ resource }) => onChange(resource);
  socket.on('data:changed', handler);

  return () => {
    socket.off('data:changed', handler);
    const remaining = (roomRefCounts.get(schoolId) || 1) - 1;
    if (remaining <= 0) {
      roomRefCounts.delete(schoolId);
      socket.emit('leave-school', schoolId);
    } else {
      roomRefCounts.set(schoolId, remaining);
    }
  };
}

// 自己的成員權限被變更時，強制重新整理頁面以取得最新權限
export function subscribeForceReload(schoolId, userId, onForceReload) {
  socket.emit('join-school', schoolId);
  const handler = ({ user_id }) => {
    if (user_id === userId) onForceReload();
  };
  socket.on('force-reload', handler);

  return () => {
    socket.off('force-reload', handler);
  };
}
