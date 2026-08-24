import { useEffect, useState, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { subscribeSchool } from '../socket';

const ENTITY_LABEL = {
  note: '記事',
  teacher: '教師',
  student: '學生',
  session: '課堂',
  session_cancelled: '固定課單日',
  schedule_template: '固定課樣板',
  ledger_entry: '收支明細',
  payslip: '薪資條',
  invoice: '繳費單',
  tuition_record: '學費紀錄',
  membership: '成員',
  invite_code: '邀請碼',
};

// 刪除滿 14 天會被自動清除，這裡算出還剩幾天，讓使用者知道還有多少時間可以復原
function daysLeft(deletedAt) {
  const deletedTime = new Date(deletedAt.replace(' ', 'T') + 'Z').getTime();
  const remain = 14 - (Date.now() - deletedTime) / (24 * 60 * 60 * 1000);
  return Math.max(0, Math.ceil(remain));
}

// 每個子系統頁面（或某個學生/教師詳細頁）各自的回收桶，是獨立頁面而不是內嵌展開；
// scope="student"|"teacher" 時搭配路由的 :id 只顯示跟這個人有關的項目
export default function TrashPage({ title, entityTypes, scope }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const { currentSchoolId, currentMembership } = useAuth();
  const isAdmin = currentMembership?.role === 'admin';

  const [items, setItems] = useState([]);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);

  const typesKey = entityTypes.join(',');

  const load = useCallback(async () => {
    if (!currentSchoolId) return;
    try {
      const params = new URLSearchParams({ types: typesKey });
      if (scope === 'student' && id) params.set('student_id', id);
      if (scope === 'teacher' && id) params.set('teacher_id', id);
      setItems(await api.get(`/api/schools/${currentSchoolId}/trash?${params.toString()}`));
    } catch (err) {
      setError(err.message);
    }
  }, [currentSchoolId, typesKey, scope, id]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!currentSchoolId) return;
    return subscribeSchool(currentSchoolId, (resource) => {
      if (resource === 'trash') load();
    });
  }, [currentSchoolId, load]);

  if (!isAdmin) return <p>僅管理者可使用回收桶</p>;

  const restore = async (item) => {
    setError('');
    setBusyId(item.id);
    try {
      await api.post(`/api/schools/${currentSchoolId}/trash/${item.id}/restore`, {});
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const purge = async (item) => {
    if (!confirm(`確定要永久刪除「${item.label}」嗎？此動作無法復原。`)) return;
    setError('');
    setBusyId(item.id);
    try {
      await api.del(`/api/schools/${currentSchoolId}/trash/${item.id}`);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      <button onClick={() => navigate(-1)}>← 返回</button>

      <h2 style={{ marginTop: 12 }}>{title}</h2>
      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}

      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12 }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid var(--border-strong)' }}>
            {entityTypes.length > 1 && <th>類型</th>}
            <th>內容</th>
            <th>刪除時間</th>
            <th>刪除者</th>
            <th>剩餘天數</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id} style={{ borderBottom: '1px solid var(--border)' }}>
              {entityTypes.length > 1 && (
                <td><span className="pill">{ENTITY_LABEL[item.entity_type] || item.entity_type}</span></td>
              )}
              <td>{item.label}</td>
              <td style={{ whiteSpace: 'nowrap' }}>{item.deleted_at}</td>
              <td>{item.deleted_by_name || '未知'}</td>
              <td>{daysLeft(item.deleted_at)} 天</td>
              <td style={{ display: 'flex', gap: 8 }}>
                <button disabled={busyId === item.id} onClick={() => restore(item)}>復原</button>
                <button disabled={busyId === item.id} style={{ color: 'var(--danger)' }} onClick={() => purge(item)}>
                  永久刪除
                </button>
              </td>
            </tr>
          ))}
          {items.length === 0 && (
            <tr>
              <td colSpan={entityTypes.length > 1 ? 6 : 5} style={{ color: 'var(--text-muted)', padding: 12 }}>
                回收桶是空的
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
