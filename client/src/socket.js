import { io } from 'socket.io-client';
import { API_URL } from './api';

// API_URL 為空字串代表走同源（透過 Vite proxy 轉發），io() 不帶網址即會連到目前頁面所在的 origin
export const socket = io(API_URL || undefined, { autoConnect: true, withCredentials: true });

export function subscribeSchool(schoolId, onChange) {
  socket.emit('join-school', schoolId);
  const handler = ({ resource }) => onChange(resource);
  socket.on('data:changed', handler);

  return () => {
    socket.emit('leave-school', schoolId);
    socket.off('data:changed', handler);
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
