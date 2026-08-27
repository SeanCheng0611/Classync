import { useState } from 'react';

const LEVEL_COLOR = { INFO: 'var(--text-muted)', WARN: 'var(--warning, #b8860b)', ERROR: 'var(--danger)' };

function LogRow({ log }) {
  const [expanded, setExpanded] = useState(false);
  let metadata = null;
  if (log.metadata_json) {
    try {
      metadata = JSON.parse(log.metadata_json);
    } catch {
      metadata = null;
    }
  }

  return (
    <div style={{ borderBottom: '1px solid var(--border)', padding: '8px 4px', fontSize: 13 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{log.created_at}</span>
        <span style={{ color: LEVEL_COLOR[log.level] || 'inherit', fontWeight: 600 }}>{log.level}</span>
        <span style={{ color: 'var(--text-muted)' }}>{log.category}</span>
        {log.page_key && <span style={{ color: 'var(--text-muted)' }}>[{log.page_key}]</span>}
        <span style={{ fontWeight: 600 }}>{log.action}</span>
      </div>
      <div style={{ marginTop: 2 }}>{log.message}</div>
      <div style={{ marginTop: 2, color: 'var(--text-muted)', fontSize: 12 }}>
        {log.user_id && <span>user: {log.user_id} </span>}
        {log.entity_type && <span>entity: {log.entity_type}{log.entity_id ? `#${log.entity_id}` : ''} </span>}
        {metadata && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            style={{ fontSize: 12, padding: '1px 6px', marginLeft: 4 }}
          >
            {expanded ? '收合詳細資料' : '展開詳細資料'}
          </button>
        )}
      </div>
      {expanded && metadata && (
        <pre
          style={{
            marginTop: 4, background: 'var(--surface-muted)', padding: 8, borderRadius: 4,
            fontSize: 12, overflowX: 'auto', maxWidth: '100%',
          }}
        >
          {JSON.stringify(metadata, null, 2)}
        </pre>
      )}
    </div>
  );
}

export default function LogTable({ logs, loading, hasMore, onLoadMore }) {
  if (loading && logs.length === 0) return <p style={{ color: 'var(--text-muted)' }}>載入中...</p>;
  if (logs.length === 0) return <p style={{ color: 'var(--text-muted)' }}>沒有符合條件的紀錄</p>;

  return (
    <div style={{ overflowX: 'auto' }}>
      <div>{logs.map((log) => <LogRow key={log.id} log={log} />)}</div>
      {hasMore && (
        <div style={{ marginTop: 8 }}>
          <button type="button" onClick={onLoadMore} disabled={loading}>
            {loading ? '載入中...' : '載入更多'}
          </button>
        </div>
      )}
    </div>
  );
}
