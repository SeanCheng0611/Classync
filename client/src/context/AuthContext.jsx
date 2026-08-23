import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api } from '../api';
import { subscribeForceReload } from '../socket';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [memberships, setMemberships] = useState([]);
  const [currentSchoolId, setCurrentSchoolId] = useState(
    () => localStorage.getItem('currentSchoolId') || null
  );
  const [loading, setLoading] = useState(true);

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
