import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useScrollMemory } from '../lib/useScrollMemory';

const navLinkClass = ({ isActive }) => `nav-link${isActive ? ' nav-link-active' : ''}`;

export default function Layout() {
  const { user, memberships, currentSchoolId, currentMembership, setCurrentSchoolId, logout } = useAuth();
  useScrollMemory();

  return (
    <div>
      <header className="app-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {memberships.length > 1 ? (
            <select
              value={currentSchoolId || ''}
              onChange={(e) => setCurrentSchoolId(e.target.value)}
            >
              {memberships.map((m) => (
                <option key={m.school_id} value={m.school_id}>
                  {m.school_name}
                </option>
              ))}
            </select>
          ) : (
            <strong>{currentMembership?.school_name}</strong>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{user?.display_name}</span>
          <button onClick={logout}>登出</button>
        </div>
      </header>

      <nav className="app-nav">
        <NavLink to="/students" className={navLinkClass}>學生檔案</NavLink>
        <NavLink to="/teachers" className={navLinkClass}>教師檔案</NavLink>
        <NavLink to="/schedule" className={navLinkClass}>課表</NavLink>
        <NavLink to="/attendance" className={navLinkClass}>點名</NavLink>
        <NavLink to="/seats" className={navLinkClass}>座位</NavLink>
        {currentMembership?.role === 'admin' && (
          <>
            <NavLink to="/invoices" className={navLinkClass}>繳費單</NavLink>
            <NavLink to="/payslips" className={navLinkClass}>薪資開立</NavLink>
            <NavLink to="/finance" className={navLinkClass}>收支統計</NavLink>
            <NavLink to="/notes" className={navLinkClass}>記事本</NavLink>
            <NavLink to="/members" className={navLinkClass}>成員管理</NavLink>
            <NavLink to="/settings" className={navLinkClass}>設定</NavLink>
          </>
        )}
        <NavLink to="/schools" className={navLinkClass}>切換補習班</NavLink>
      </nav>

      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
