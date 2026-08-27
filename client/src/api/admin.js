// 集中管理 Admin Mode / Audit Log 相關 API 呼叫，不要讓每個用到的元件各自寫 fetch('/api/admin/...')。
import { api } from '../api';

export const adminApi = {
  status: () => api.get('/api/admin/status'),
  unlock: (password) => api.post('/api/admin/unlock', { password }),
  lock: () => api.post('/api/admin/lock'),
  logs: (filters = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== null && value !== '') params.set(key, value);
    }
    const qs = params.toString();
    return api.get(`/api/admin/logs${qs ? `?${qs}` : ''}`);
  },
};
