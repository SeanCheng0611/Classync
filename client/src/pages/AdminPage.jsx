import { useState } from 'react';
import { useAdminMode } from '../context/AdminModeContext';
import { useAuditLogs } from '../lib/useAuditLogs';
import LogFilters from '../components/admin/LogFilters';
import LogTable from '../components/admin/LogTable';

export default function AdminPage() {
  const { lockAdminMode } = useAdminMode();
  const [logType, setLogType] = useState('audit');
  const [filters, setFilters] = useState({});

  const { logs, hasMore, loading, error, loadMore, refresh } = useAuditLogs({ ...filters, log_type: logType });

  const switchLogType = (type) => {
    setLogType(type);
    setFilters((f) => ({ ...f, category: undefined })); // 分類清單依 log_type 不同，切換時清掉避免帶著不相干的分類
  };

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>管理者</h2>
        <button type="button" onClick={lockAdminMode}>離開管理者模式</button>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button type="button" disabled={logType === 'audit'} onClick={() => switchLogType('audit')}>Audit Log</button>
        <button type="button" disabled={logType === 'diagnostic'} onClick={() => switchLogType('diagnostic')}>Diagnostic Log</button>
      </div>
      <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 4 }}>
        {logType === 'audit' ? '誰在什麼時間改了什麼——正式營運的稽核紀錄' : '錯誤、自動化、API/整合狀態——工程維運用'}
      </p>

      <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <LogFilters logType={logType} filters={filters} onChange={setFilters} />
        <button type="button" onClick={refresh}>重新整理</button>
      </div>

      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}

      <div style={{ marginTop: 12 }}>
        <LogTable logs={logs} loading={loading} hasMore={hasMore} onLoadMore={loadMore} />
      </div>
    </div>
  );
}
