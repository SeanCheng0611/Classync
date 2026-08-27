import { useState } from 'react';
import { useAdminMode } from '../../context/AdminModeContext';

// 10 次點擊只是「發現入口」的方式，不是驗證——真正的密碼驗證在 backend（POST /api/admin/unlock）
export default function AdminUnlockDialog({ onClose }) {
  const { unlockAdminMode } = useAdminMode();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await unlockAdminMode(password);
      onClose();
    } catch (err) {
      setError(err.message || '解鎖失敗');
    } finally {
      setSubmitting(false);
      setPassword('');
    }
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.35)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--surface)', border: '1px solid var(--border-strong)', borderRadius: 8,
          boxShadow: 'var(--shadow)', padding: 20, width: 320, maxWidth: '100%', display: 'grid', gap: 10,
        }}
      >
        <h3 style={{ margin: 0 }}>管理者模式</h3>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="管理者密碼"
          style={{ width: '100%', boxSizing: 'border-box' }}
        />
        {error && <p style={{ color: 'var(--danger)', margin: 0, fontSize: 13 }}>{error}</p>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="submit" disabled={submitting || !password}>解鎖</button>
          <button type="button" onClick={onClose}>取消</button>
        </div>
      </form>
    </div>
  );
}
