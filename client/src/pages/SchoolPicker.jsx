import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';

export default function SchoolPicker() {
  const { user, memberships, refresh, setCurrentSchoolId } = useAuth();
  const navigate = useNavigate();
  const [newName, setNewName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const selectSchool = (schoolId) => {
    setCurrentSchoolId(schoolId);
    navigate('/students');
  };

  const deleteSchool = async (m) => {
    if (!confirm(`確定要刪除整間補習班「${m.school_name}」嗎？此操作無法復原，將刪除其下所有學生、教師、課表等資料。`)) return;
    setError('');
    try {
      await api.del(`/api/schools/${m.school_id}`);
      setCurrentSchoolId(null);
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  };

  const createSchool = async (e) => {
    e.preventDefault();
    if (!newName.trim()) return;
    setBusy(true);
    setError('');
    try {
      const school = await api.post('/api/schools', { name: newName.trim() });
      await refresh();
      selectSchool(school.id);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const joinSchool = async (e) => {
    e.preventDefault();
    if (!inviteCode.trim()) return;
    setBusy(true);
    setError('');
    try {
      const school = await api.post('/api/invite-codes/redeem', { code: inviteCode.trim() });
      await refresh();
      selectSchool(school.id);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ maxWidth: 480, margin: '60px auto', display: 'grid', gap: 16 }}>
      <h2>選擇補習班</h2>

      {memberships.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
          {memberships.map((m) => (
            <li key={m.school_id} style={{ display: 'flex', gap: 8 }}>
              <button
                className="card"
                style={{ flex: 1, textAlign: 'left', fontWeight: 500 }}
                onClick={() => selectSchool(m.school_id)}
              >
                {m.school_name}
                <span className="pill" style={{ marginLeft: 8 }}>{m.role === 'admin' ? '管理者' : '教師'}</span>
              </button>
              {user?.is_owner && (
                <button onClick={() => deleteSchool(m)} className="text-danger">
                  刪除補習班
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {error && <p className="text-danger">{error}</p>}

      {user?.is_owner && (
        <form onSubmit={createSchool} className="card">
          <h3 style={{ marginTop: 0 }}>建立新補習班</h3>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="補習班名稱"
            style={{ width: '100%' }}
          />
          <button type="submit" disabled={busy} style={{ marginTop: 8 }}>
            建立
          </button>
        </form>
      )}

      <form onSubmit={joinSchool} className="card">
        <h3 style={{ marginTop: 0 }}>輸入一次性邀請碼</h3>
        <input
          value={inviteCode}
          onChange={(e) => setInviteCode(e.target.value)}
          placeholder="邀請碼"
          style={{ width: '100%' }}
        />
        <button type="submit" disabled={busy} style={{ marginTop: 8 }}>
          兌換
        </button>
      </form>
    </div>
  );
}
