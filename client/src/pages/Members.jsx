import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { subscribeSchool } from '../socket';

const ROLE_LABEL = { admin: '管理者', teacher: '教師', front_desk: '櫃台' };

export default function Members() {
  const { currentSchoolId, currentMembership, user } = useAuth();
  const [members, setMembers] = useState([]);
  const [teachers, setTeachers] = useState([]);
  const [codes, setCodes] = useState([]);
  const [targetRole, setTargetRole] = useState('admin'); // 'admin' | 'teacher' | 'front_desk'
  const [targetTeacherId, setTargetTeacherId] = useState('');
  const [justCreated, setJustCreated] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!currentSchoolId) return;
    try {
      const [m, t, c] = await Promise.all([
        api.get(`/api/schools/${currentSchoolId}/members`),
        api.get(`/api/schools/${currentSchoolId}/teachers`),
        api.get(`/api/schools/${currentSchoolId}/invite-codes`),
      ]);
      setMembers(m);
      setTeachers(t);
      setCodes(c);
    } catch (err) {
      setError(err.message);
    }
  }, [currentSchoolId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!currentSchoolId) return;
    return subscribeSchool(currentSchoolId, (resource) => {
      if (resource === 'members') load();
    });
  }, [currentSchoolId, load]);

  if (currentMembership?.role !== 'admin') {
    return <p>僅管理者可查看成員管理</p>;
  }

  const remove = async (member) => {
    if (!confirm(`確定要將「${member.display_name}」移出補習班嗎？`)) return;
    setError('');
    try {
      await api.del(`/api/schools/${currentSchoolId}/members/${member.id}`);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const linkTeacher = async (member, teacherId) => {
    setError('');
    try {
      await api.put(`/api/schools/${currentSchoolId}/members/${member.id}`, { teacher_id: teacherId || null });
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const changeRole = async (member, role) => {
    setError('');
    try {
      await api.put(`/api/schools/${currentSchoolId}/members/${member.id}`, { role });
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const generateCode = async (e) => {
    e.preventDefault();
    setError('');
    setJustCreated(null);
    if (targetRole === 'teacher' && !targetTeacherId) {
      setError('請先選擇教師');
      return;
    }
    try {
      const code = await api.post(`/api/schools/${currentSchoolId}/invite-codes`, {
        role: targetRole,
        teacher_id: targetRole === 'teacher' ? targetTeacherId : null,
      });
      setJustCreated(code);
      setTargetTeacherId('');
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const revokeCode = async (code) => {
    if (!confirm('確定要撤銷這組尚未使用的邀請碼嗎？')) return;
    setError('');
    try {
      await api.del(`/api/schools/${currentSchoolId}/invite-codes/${code.id}`);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>成員管理</h2>
        <Link to="/members/trash"><button type="button">回收桶</button></Link>
      </div>
      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}

      <h3>產生一次性邀請碼</h3>
      <form onSubmit={generateCode} style={{ display: 'grid', gap: 8, maxWidth: 360 }}>
        <label>
          對象身分
          <select value={targetRole} onChange={(e) => setTargetRole(e.target.value)}>
            <option value="admin">共同管理者</option>
            <option value="teacher">教師</option>
            <option value="front_desk">櫃台</option>
          </select>
        </label>
        {targetRole === 'teacher' && (
          <label>
            教師姓名
            <select value={targetTeacherId} onChange={(e) => setTargetTeacherId(e.target.value)}>
              <option value="">請選擇</option>
              {teachers.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </label>
        )}
        <div>
          <button type="submit">產生邀請碼</button>
        </div>
      </form>

      {justCreated && (
        <p style={{ background: 'var(--success-soft)', padding: 8, marginTop: 8 }}>
          邀請碼已產生：<strong style={{ fontSize: 18 }}>{justCreated.code}</strong>
          （{justCreated.role === 'admin' ? '共同管理者' : justCreated.role === 'front_desk' ? '櫃台' : `教師：${justCreated.teacher_name}`}，僅能使用一次）
        </p>
      )}

      <h3 style={{ marginTop: 24 }}>已產生的邀請碼</h3>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid var(--border-strong)' }}>
            <th>邀請碼</th>
            <th>對象</th>
            <th>狀態</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {codes.map((c) => (
            <tr key={c.id} style={{ borderBottom: '1px solid var(--border)' }}>
              <td>{c.code}</td>
              <td>{c.role === 'admin' ? '共同管理者' : c.role === 'front_desk' ? '櫃台' : `教師：${c.teacher_name || '?'}`}</td>
              <td>{c.used_at ? '已使用' : '未使用'}</td>
              <td>{!c.used_at && <button onClick={() => revokeCode(c)}>撤銷</button>}</td>
            </tr>
          ))}
          {codes.length === 0 && (
            <tr>
              <td colSpan={4} style={{ color: 'var(--text-muted)', padding: 12 }}>尚無邀請碼</td>
            </tr>
          )}
        </tbody>
      </table>

      <h3 style={{ marginTop: 24 }}>成員列表</h3>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12 }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid var(--border-strong)' }}>
            <th>姓名</th>
            <th>角色</th>
            <th>連結教師檔案</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {[...members]
            .sort((a, b) => (a.user_id === user.id ? -1 : b.user_id === user.id ? 1 : 0))
            .map((m) => (
              <tr key={m.id} style={{ borderBottom: '1px solid var(--border)' }}>
                <td>{m.display_name}</td>
                <td>
                  {!m.is_owner && m.user_id !== user.id && (user.is_owner || m.role !== 'admin') ? (
                    <select value={m.role} onChange={(e) => changeRole(m, e.target.value)}>
                      <option value="admin">管理者</option>
                      <option value="teacher">教師</option>
                      <option value="front_desk">櫃台</option>
                    </select>
                  ) : (
                    ROLE_LABEL[m.role] || m.role
                  )}
                </td>
                <td>
                  {m.role === 'teacher' && (
                    <select value={m.teacher_id || ''} onChange={(e) => linkTeacher(m, e.target.value)}>
                      <option value="">未連結</option>
                      {teachers.map((t) => (
                        <option key={t.id} value={t.id}>{t.name}</option>
                      ))}
                    </select>
                  )}
                </td>
                <td>
                  {!m.is_owner && m.user_id !== user.id && <button onClick={() => remove(m)}>移出</button>}
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}
