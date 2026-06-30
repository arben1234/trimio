import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import AdminLogin from './pages/AdminLogin';
import AdminPanel from './pages/AdminPanel';
import SalonPage from './pages/SalonPage';
import StaffLogin from './pages/StaffLogin';
import OwnerDashboard from './pages/OwnerDashboard';
import BarberDashboard from './pages/BarberDashboard';

export default function App() {
  return (
    <Routes>
      {/* Super admin */}
      <Route path="/" element={<AdminLogin />} />
      <Route path="/admin" element={<AdminPanel />} />

      {/* Salone pubblico - cliente prenota */}
      <Route path="/s/:salonSlug" element={<SalonPage />} />

      {/* Staff login - sempre scoped al salone */}
      <Route path="/s/:salonSlug/login" element={<StaffLogin />} />

      {/* Dashboard staff - accessibili solo dopo login nel salone corretto */}
      <Route path="/s/:salonSlug/owner" element={<OwnerDashboard />} />
      <Route path="/s/:salonSlug/barber" element={<BarberDashboard />} />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
