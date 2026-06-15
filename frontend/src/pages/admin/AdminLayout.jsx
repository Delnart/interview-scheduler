import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../../AuthContext.jsx';

const navClass = ({ isActive }) => `admin-navlink${isActive ? ' active' : ''}`;

export default function AdminLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  function handleLogout() {
    logout();
    navigate('/admin/login');
  }

  return (
    <div className="admin-layout">
      <aside className="admin-sidebar">
        <div className="admin-brand">Інтерв&#39;ю — адмін</div>
        <nav className="admin-nav">
          <NavLink to="/admin" end className={navClass}>Огляд</NavLink>
          <NavLink to="/admin/availability" className={navClass}>Мій вільний час</NavLink>
          <NavLink to="/admin/calendar" className={navClass}>Загальний календар</NavLink>
          {user?.isAdmin && (
            <>
              <div className="admin-nav-section muted">Адміністрування</div>
              <NavLink to="/admin/recruiters" className={navClass}>Рекрутери</NavLink>
              <NavLink to="/admin/teams" className={navClass}>Команди по ОП</NavLink>
            </>
          )}
          <NavLink to="/admin/profile" className={navClass}>Профіль</NavLink>
        </nav>
        <div className="admin-userbox">
          <div className="admin-userbox-info">
            <div style={{ fontSize: 13, fontWeight: 500 }}>{user?.fullName}</div>
            <div className="muted">{user?.email}</div>
          </div>
          <button className="btn btn-sm admin-logout" onClick={handleLogout}>Вийти</button>
        </div>
      </aside>
      <main className="admin-main">
        <Outlet />
      </main>
    </div>
  );
}
