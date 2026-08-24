import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { subscribeSchool } from '../socket';

export default function Payslips() {
  const { currentSchoolId, currentMembership } = useAuth();
  const isAdmin = currentMembership?.role === 'admin';

  const [teachers, setTeachers] = useState([]);

  const load = useCallback(async () => {
    if (!currentSchoolId) return;
    setTeachers(await api.get(`/api/schools/${currentSchoolId}/teachers`));
  }, [currentSchoolId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!currentSchoolId) return;
    return subscribeSchool(currentSchoolId, (resource) => {
      if (resource === 'teachers') load();
    });
  }, [currentSchoolId, load]);

  if (!isAdmin) return <p>僅管理者可使用薪資系統</p>;

  return (
    <div>
      <h2>薪資系統</h2>

      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12 }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid var(--border-strong)' }}>
            <th>姓名</th>
            <th>科目</th>
          </tr>
        </thead>
        <tbody>
          {teachers.map((t) => (
            <tr key={t.id} style={{ borderBottom: '1px solid var(--border)' }}>
              <td><Link to={`/payslips/${t.id}`}>{t.name}</Link></td>
              <td>{(t.subjects || []).join('、')}</td>
            </tr>
          ))}
          {teachers.length === 0 && (
            <tr>
              <td colSpan={2} style={{ color: 'var(--text-muted)', padding: 12 }}>尚無教師資料</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
