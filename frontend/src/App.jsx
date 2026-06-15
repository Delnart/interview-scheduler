import { Navigate, Route, Routes } from 'react-router-dom';
import BookingPage from './pages/BookingPage.jsx';
import LoginPage from './pages/LoginPage.jsx';
import AdminLayout from './pages/admin/AdminLayout.jsx';
import Dashboard from './pages/admin/Dashboard.jsx';
import RecruitersPage from './pages/admin/RecruitersPage.jsx';
import TeamsPage from './pages/admin/TeamsPage.jsx';
import AvailabilityPage from './pages/admin/AvailabilityPage.jsx';
import GeneralCalendarPage from './pages/admin/GeneralCalendarPage.jsx';
import RecruiterCalendarPage from './pages/admin/RecruiterCalendarPage.jsx';
import ProfilePage from './pages/admin/ProfilePage.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<BookingPage />} />
      <Route path="/admin/login" element={<LoginPage />} />
      <Route
        path="/admin"
        element={
          <ProtectedRoute>
            <AdminLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="availability" element={<AvailabilityPage />} />
        <Route path="calendar" element={<GeneralCalendarPage />} />
        <Route path="calendar/:id" element={<RecruiterCalendarPage />} />
        <Route path="recruiters" element={<RecruitersPage />} />
        <Route path="teams" element={<TeamsPage />} />
        <Route path="profile" element={<ProfilePage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
