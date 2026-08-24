import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api } from '../api';
import { subscribeForceReload, subscribeSchool } from '../socket';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [memberships, setMemberships] = useState([]);
  const [currentSchoolId, setCurrentSchoolId] = useState(
    () => localStorage.getItem('currentSchoolId') || null
  );
  const [loading, setLoading] = useState(true);
  // 「設定」子系統的值（一對多人數上限、時間選單優先範圍等），供全站共用（例如 TimeInput 的下拉排序）
  const [schoolSettings, setSchoolSettings] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get('/auth/me');
      setUser(data.user);
      setMemberships(data.memberships);
      if (!data.memberships.find((m) => m.school_id === currentSchoolId)) {
        const first = data.memberships[0];
        setCurrentSchoolId(first ? first.school_id : null);
      }
    } catch {
      setUser(null);
      setMemberships([]);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (currentSchoolId) localStorage.setItem('currentSchoolId', currentSchoolId);
  }, [currentSchoolId]);

  useEffect(() => {
    if (!user || !currentSchoolId) return;
    return subscribeForceReload(currentSchoolId, user.id, () => window.location.reload());
  }, [user, currentSchoolId]);

  const loadSchoolSettings = useCallback(async () => {
    if (!currentSchoolId) return;
    try {
      const school = await api.get(`/api/schools/${currentSchoolId}`);
      setSchoolSettings(school);
    } catch {
      setSchoolSettings(null);
    }
  }, [currentSchoolId]);

  useEffect(() => {
    loadSchoolSettings();
  }, [loadSchoolSettings]);

  useEffect(() => {
    if (!currentSchoolId) return;
    return subscribeSchool(currentSchoolId, (resource) => {
      if (resource === 'scheduling-settings') loadSchoolSettings();
    });
  }, [currentSchoolId, loadSchoolSettings]);

  const logout = async () => {
    await api.post('/auth/logout');
    setUser(null);
    setMemberships([]);
    setCurrentSchoolId(null);
  };

  const currentMembership = memberships.find((m) => m.school_id === currentSchoolId) || null;

  return (
    <AuthContext.Provider
      value={{
        user,
        memberships,
        loading,
        currentSchoolId,
        currentMembership,
        schoolSettings,
        setCurrentSchoolId,
        refresh,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
