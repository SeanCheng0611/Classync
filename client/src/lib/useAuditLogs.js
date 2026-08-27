import { useState, useCallback, useEffect } from 'react';
import { adminApi } from '../api/admin';

const PAGE_SIZE = 50;

// 共用的分頁載入邏輯，PageLogViewer 與 AdminPage 都用這個，避免兩邊各自重寫一份 pagination。
// filters 傳 null/undefined 代表「先不要載入」（例如 Log 面板還沒打開），不會打 API——
// 對應 Admin Mode 關閉、或 Log UI 還沒開啟時不應該背景載入 Log 的要求。
export function useAuditLogs(filters) {
  const [logs, setLogs] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const enabled = !!filters;
  const filterKey = JSON.stringify(filters);

  const load = useCallback(
    async (offset) => {
      if (!enabled) return;
      setLoading(true);
      setError('');
      try {
        const result = await adminApi.logs({ ...filters, limit: PAGE_SIZE, offset });
        setLogs((prev) => (offset === 0 ? result.rows : [...prev, ...result.rows]));
        setHasMore(result.hasMore);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filterKey, enabled]
  );

  useEffect(() => {
    if (enabled) load(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, enabled]);

  const loadMore = () => load(logs.length);
  const refresh = () => load(0);

  return { logs, hasMore, loading, error, loadMore, refresh };
}
