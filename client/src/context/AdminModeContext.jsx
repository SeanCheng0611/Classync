import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { adminApi } from '../api/admin';
import { useAuth } from './AuthContext';

// 獨立於 AuthContext：這是系統診斷/管理模式（system admin mode），不是補習班的 business role
// （owner/admin/teacher/front_desk），刻意分開避免命名與語意混淆，見 docs/ADMIN_MODE.md。
const AdminModeContext = createContext(null);

export function AdminModeProvider({ children }) {
  const { user } = useAuth();
  const [isAdminMode, setIsAdminMode] = useState(false);
  const [checked, setChecked] = useState(false);

  // Refresh 後用 /api/admin/status 恢復畫面上的 Admin Mode 顯示狀態；真正的資料存取權限
  // 一律由 backend 每個 /api/admin/* 敏感 endpoint 各自驗證，這裡只是控制 UI 要不要顯示相關元件
  const checkStatus = useCallback(async () => {
    if (!user) {
      setIsAdminMode(false);
      setChecked(true);
      return;
    }
    try {
      const { unlocked } = await adminApi.status();
      setIsAdminMode(!!unlocked);
    } catch {
      setIsAdminMode(false);
    } finally {
      setChecked(true);
    }
  }, [user]);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  // user 變成 null（登出）時，前端狀態也要跟著清掉；backend 的 admin cookie 由 /auth/logout 一併清除
  useEffect(() => {
    if (!user) setIsAdminMode(false);
  }, [user]);

  const unlockAdminMode = async (password) => {
    const result = await adminApi.unlock(password); // 密碼錯誤/lockout 時會 throw，UI 自己 catch 顯示錯誤訊息
    setIsAdminMode(true);
    return result;
  };

  const lockAdminMode = async () => {
    try {
      await adminApi.lock();
    } finally {
      setIsAdminMode(false);
    }
  };

  return (
    <AdminModeContext.Provider value={{ isAdminMode, adminStatusChecked: checked, unlockAdminMode, lockAdminMode }}>
      {children}
    </AdminModeContext.Provider>
  );
}

export function useAdminMode() {
  return useContext(AdminModeContext);
}
