import { PAGE_KEYS } from '../../constants/pageKeys';

const AUDIT_CATEGORIES = ['USER_ACTION', 'DATA_CHANGE', 'AUTH', 'SECURITY'];
const DIAGNOSTIC_CATEGORIES = ['SYSTEM', 'ERROR', 'AUTOMATION', 'INTEGRATION'];

export default function LogFilters({ logType, filters, onChange }) {
  const categories = logType === 'audit' ? AUDIT_CATEGORIES : DIAGNOSTIC_CATEGORIES;
  const set = (key, value) => onChange({ ...filters, [key]: value || undefined });

  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      <select value={filters.page_key || ''} onChange={(e) => set('page_key', e.target.value)}>
        <option value="">全部 Page</option>
        {Object.values(PAGE_KEYS).map((k) => (
          <option key={k} value={k}>{k}</option>
        ))}
      </select>
      <select value={filters.level || ''} onChange={(e) => set('level', e.target.value)}>
        <option value="">全部等級</option>
        <option value="INFO">INFO</option>
        <option value="WARN">WARN</option>
        <option value="ERROR">ERROR</option>
      </select>
      <select value={filters.category || ''} onChange={(e) => set('category', e.target.value)}>
        <option value="">全部分類</option>
        {categories.map((c) => (
          <option key={c} value={c}>{c}</option>
        ))}
      </select>
      <input
        placeholder="關鍵字"
        value={filters.keyword || ''}
        onChange={(e) => set('keyword', e.target.value)}
        style={{ width: 140 }}
      />
      <input
        type="date"
        value={filters.start_time || ''}
        onChange={(e) => set('start_time', e.target.value)}
        title="起始日期"
      />
      <input
        type="date"
        value={filters.end_time || ''}
        onChange={(e) => set('end_time', e.target.value)}
        title="結束日期"
      />
    </div>
  );
}
