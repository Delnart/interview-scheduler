import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../AuthContext.jsx';

export default function ProtectedRoute({ children, adminOnly = false }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <div style={{ padding: 40, textAlign: 'center' }}>Завантаження...</div>;
  if (!user) return <Navigate to="/admin/login" state={{ from: location }} replace />;
  if (adminOnly && !user.isAdmin) return <Navigate to="/admin" replace />;

  return children;
}
