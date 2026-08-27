import { useState } from 'react';
import { useAuditLogs } from '../../lib/useAuditLogs';
import LogTable from './LogTable';

// 可重用元件：<PageLogViewer pageKey="students" /> 掛在任何主要 Page，不要為每個 Page 各寫一個
// StudentsLogViewer/TeachersLogViewer——這是為了未來 Generic Platform 刻意保持的設計。
// 只在 Admin Mode 開啟時由呼叫端決定要不要 render 這個元件本身；這裡不重複檢查 Admin Mode，
// 真正的資料保護在 backend 的 requireSystemAdminMode。
export default function PageLogViewer({ pageKey }) {
  const [open, setOpen] = useState(false);
  const [logType, setLogType] = useState('audit');
  const { logs, hasMore, loading, error, loadMore, refresh } = useAuditLogs(open ? { page_key: pageKey, log_type: logType } : null);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} style={{ fontSize: 13 }}>
        Logs
      </button>
    );
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 150, background: 'rgba(0,0,0,0.35)',
        display: 'flex', justifyContent: 'flex-end',
      }}
      onClick={() => setOpen(false)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--surface)', width: 480, maxWidth: '100%', height: '100%',
          padding: 16, overflowY: 'auto', boxShadow: 'var(--shadow)', display: 'grid', gap: 8, alignContent: 'start',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>{pageKey} 的 Log</h3>
          <button type="button" onClick={() => setOpen(false)}>關閉</button>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" disabled={logType === 'audit'} onClick={() => setLogType('audit')}>Audit Log</button>
          <button type="button" disabled={logType === 'diagnostic'} onClick={() => setLogType('diagnostic')}>Diagnostic Log</button>
          <button type="button" onClick={refresh}>重新整理</button>
        </div>
        {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
        <LogTable logs={logs} loading={loading} hasMore={hasMore} onLoadMore={loadMore} />
      </div>
    </div>
  );
}
