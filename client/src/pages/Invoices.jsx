import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { subscribeSchool } from '../socket';

export default function Invoices() {
  const { currentSchoolId, currentMembership } = useAuth();
  const isAdmin = currentMembership?.role === 'admin';

  const [students, setStudents] = useState([]);

  const load = useCallback(async () => {
    if (!currentSchoolId) return;
    setStudents(await api.get(`/api/schools/${currentSchoolId}/students`));
  }, [currentSchoolId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!currentSchoolId) return;
    return subscribeSchool(currentSchoolId, (resource) => {
      if (resource === 'students') load();
    });
  }, [currentSchoolId, load]);

  if (!isAdmin) return <p>僅管理者可使用繳費單系統</p>;

  return (
    <div>
      <h2>繳費單系統</h2>

      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12 }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid var(--border-strong)' }}>
            <th>姓名</th>
            <th>年級</th>
            <th>學校</th>
            <th>狀態</th>
          </tr>
        </thead>
        <tbody>
          {students.map((s) => (
            <tr key={s.id} style={{ borderBottom: '1px solid var(--border)' }}>
              <td><Link to={`/invoices/${s.id}`}>{s.name}</Link></td>
              <td>{s.grade}</td>
              <td>{s.school_name}</td>
              <td>{s.status === 'active' ? '在學' : '停用'}</td>
            </tr>
          ))}
          {students.length === 0 && (
            <tr>
              <td colSpan={4} style={{ color: 'var(--text-muted)', padding: 12 }}>尚無學生資料</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
