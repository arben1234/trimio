import React, { useEffect } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import AdminLogin from './pages/AdminLogin';
import AdminPanel from './pages/AdminPanel';
import SalonPage from './pages/SalonPage';
import StaffLogin from './pages/StaffLogin';
import OwnerDashboard from './pages/OwnerDashboard';
import BarberDashboard from './pages/BarberDashboard';

// Kur hapet PWA nga home screen, ridrejton te sesioni i fundit i stafit
function SmartLanding() {
  const navigate = useNavigate();

  useEffect(() => {
    // Kërko sesionet e ruajtura të stafit
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith('trimio_user_')) continue;
      try {
        const user = JSON.parse(localStorage.getItem(key));
        const salonId = key.replace('trimio_user_', '');
        const token = localStorage.getItem(`trimio_token_${salonId}`);
        if (user && token && user.salonSlug) {
          const path = `/s/${user.salonSlug}/${user.role === 'owner' ? 'owner' : 'barber'}`;
          navigate(path, { replace: true });
          return;
        }
      } catch {}
    }
    // Asnjë sesion stafi — trego admin login
  }, [navigate]);

  return <AdminLogin />;
}

// Ruan route-n e fundit për PWA (jo per / dhe /admin)
function RouteTracker() {
  const location = useLocation();
  useEffect(() => {
    const p = location.pathname;
    if (p !== '/' && p !== '/admin' && !p.endsWith('/login')) {
      localStorage.setItem('trimio_last_path', p);
    }
  }, [location]);
  return null;
}

export default function App() {
  return (
    <>
      <RouteTracker />
      <Routes>
        <Route path="/" element={<SmartLanding />} />
        <Route path="/admin" element={<AdminPanel />} />
        <Route path="/s/:salonSlug" element={<SalonPage />} />
        <Route path="/s/:salonSlug/login" element={<StaffLogin />} />
        <Route path="/s/:salonSlug/owner" element={<OwnerDashboard />} />
        <Route path="/s/:salonSlug/barber" element={<BarberDashboard />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
