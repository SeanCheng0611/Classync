// 新增學生/教師（單筆或 Excel 匯入）遇到同名時，跳出視窗讓使用者一筆一筆確認是否仍要新增；
// 匯入多筆時另外提供「全部新增」「全部略過」，套用到後續所有同名項目，不用每一筆都點
export default function DuplicateConfirmModal({ title, newFields, existingFields, showBulkActions, onDecide, onDecideAll }) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
      }}
    >
      <div
        className="card"
        style={{ background: 'var(--surface)', padding: 20, borderRadius: 'var(--radius)', width: 420, maxWidth: '90%' }}
      >
        <h3 style={{ marginTop: 0 }}>{title}</h3>
        <div style={{ display: 'flex', gap: 16 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>新資料</div>
            {newFields.map((f) => (
              <div key={f.label} style={{ fontSize: 14 }}>
                <span style={{ color: 'var(--text-muted)' }}>{f.label}：</span>{f.value}
              </div>
            ))}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>既有資料</div>
            {existingFields.map((f) => (
              <div key={f.label} style={{ fontSize: 14 }}>
                <span style={{ color: 'var(--text-muted)' }}>{f.label}：</span>{f.value}
              </div>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 20, flexWrap: 'wrap' }}>
          <button type="button" onClick={() => onDecide(true)}>新增</button>
          <button type="button" onClick={() => onDecide(false)}>略過</button>
          {showBulkActions && (
            <>
              <button type="button" onClick={() => onDecideAll(true)}>全部新增</button>
              <button type="button" onClick={() => onDecideAll(false)}>全部略過</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
