import { API_URL } from '../api';

export default function Login() {
  return (
    <div style={{ display: 'flex', minHeight: '100svh', alignItems: 'center', justifyContent: 'center' }}>
      <div className="card" style={{ maxWidth: 480, width: '100%', textAlign: 'center', padding: 48 }}>
        <h1 style={{ fontSize: 34, marginBottom: 32 }}>補習班營運系統</h1>

        <a
          href={`${API_URL}/auth/line/login`}
          style={{
            display: 'block',
            background: 'var(--accent-soft)',
            color: 'var(--accent-hover)',
            padding: '20px',
            borderRadius: 'var(--radius)',
            textDecoration: 'none',
            fontWeight: 600,
            fontSize: 18,
          }}
        >
          使用 LINE 登入
        </a>
      </div>
    </div>
  );
}
