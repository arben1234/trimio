import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useSalonAuth } from '../hooks/useAuth';
import { useSSE } from '../hooks/useSSE';
import { usePushSubscription } from '../hooks/usePushSubscription';
import { Toast, useToast } from '../components/Toast';
import { api } from '../utils/api';

function useSalonId(salonSlug) {
  const [salonId, setSalonId] = useState(null);
  useEffect(() => {
    api.getSalon(salonSlug).then(d => setSalonId(d.salon.id)).catch(() => {});
  }, [salonSlug]);
  return salonId;
}

export default function BarberDashboard() {
  const { salonSlug } = useParams();
  const navigate = useNavigate();
  const salonId = useSalonId(salonSlug);
  const { user, logout, isLoggedIn, authReady } = useSalonAuth(salonSlug, salonId);
  const { toast, show: showToast } = useToast();

  const [tab, setTab] = useState('bookings');
  const [bookings, setBookings] = useState([]);
  const [stats, setStats] = useState(null);
  const [filterDate, setFilterDate] = useState(new Date().toISOString().slice(0, 10));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!salonId || !authReady) return;
    if (!isLoggedIn || user?.role !== 'barber') {
      navigate(`/s/${salonSlug}/login`, { replace: true });
    }
  }, [isLoggedIn, user, salonId, authReady, salonSlug, navigate]);

  useEffect(() => {
    if (!salonId || !isLoggedIn) return;
    setLoading(true);
    Promise.all([
      api.getBookings(salonSlug, { date: filterDate }, salonId),
      api.getStats(salonSlug, salonId)
    ]).then(([b, s]) => { setBookings(b); setStats(s); }).finally(() => setLoading(false));
  }, [salonSlug, salonId, isLoggedIn, filterDate]);

  // SSE: aggiornamento real-time — solo prenotazioni di questo barber
  const handleNewBooking = useCallback((booking) => {
    if (!user || booking.barber_id !== user.userId) return;
    // Aggiungi solo se la data coincide con il filtro attivo
    if (booking.date === filterDate) {
      setBookings(prev => {
        const exists = prev.some(b => b.id === booking.id);
        if (exists) return prev;
        return [booking, ...prev].sort((a, b) => a.time.localeCompare(b.time));
      });
    }
    const isToday = booking.date === new Date().toISOString().slice(0, 10);
    setStats(s => s ? { ...s, today: s.today + (isToday ? 1 : 0), total: s.total + 1 } : s);
    showToast(`📅 Nuova prenotazione: ${booking.client_name} alle ${booking.time}`);
  }, [user, filterDate, showToast]);

  useSSE(salonSlug, salonId, handleNewBooking);
  usePushSubscription(salonId);

  async function updateStatus(bookingId, status) {
    await api.updateBooking(salonSlug, bookingId, { status }, salonId);
    setBookings(b => b.map(bk => bk.id === bookingId ? { ...bk, status } : bk));
  }

  if (!user || !isLoggedIn) return <div className="spinner" />;

  return (
    <div>
      <Toast toast={toast} />

      <div className="header">
        <div>
          <div className="header-logo">TRIMIO</div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            ✂️ {user.name}
            <span style={{ marginLeft: 8, color: 'var(--success)', fontSize: '0.7rem' }}>● live</span>
          </div>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={() => { logout(); navigate(`/s/${salonSlug}/login`); }}>
          Esci
        </button>
      </div>

      <div className="page">
        {tab === 'bookings' && (
          <>
            <div className="form-group" style={{ marginBottom: 16 }}>
              <label>Data</label>
              <input type="date" value={filterDate} onChange={e => setFilterDate(e.target.value)} />
            </div>

            {loading
              ? <div className="spinner" />
              : bookings.length === 0
                ? <div style={{ textAlign: 'center', marginTop: 40, color: 'var(--text-muted)' }}>
                    <div style={{ fontSize: '2.5rem', marginBottom: 8 }}>📭</div>
                    <p>Nessuna prenotazione per questa data</p>
                  </div>
                : bookings.map(b => (
                  <div key={b.id} className="booking-item">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div>
                        <div className="booking-time">{b.time}</div>
                        <div className="booking-client">{b.client_name}</div>
                        <div className="booking-meta">
                          {b.service_name && `${b.service_name} · `}
                          {b.price && `€${b.price} · `}
                          {b.client_phone || ''}
                        </div>
                        {b.notes && <div className="booking-meta" style={{ fontStyle: 'italic' }}>"{b.notes}"</div>}
                      </div>
                      <span className={`badge badge-${b.status}`}>{b.status}</span>
                    </div>
                    {b.status === 'confirmed' && (
                      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                        <button className="btn btn-primary btn-sm" onClick={() => updateStatus(b.id, 'completed')}>
                          ✓ Completato
                        </button>
                        <button className="btn btn-danger btn-sm" onClick={() => updateStatus(b.id, 'cancelled')}>
                          Annulla
                        </button>
                      </div>
                    )}
                  </div>
                ))
            }
          </>
        )}

        {tab === 'stats' && stats && (
          <>
            <h2 style={{ marginBottom: 16 }}>Le mie statistiche</h2>
            <div className="stats-grid">
              <div className="stat-card">
                <div className="stat-value">{stats.today}</div>
                <div className="stat-label">Oggi</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{stats.total}</div>
                <div className="stat-label">Totale</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{stats.completed}</div>
                <div className="stat-label">Completati</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">€{stats.revenue}</div>
                <div className="stat-label">Guadagno</div>
              </div>
            </div>
          </>
        )}
      </div>

      <nav className="bottom-nav">
        <a className={tab === 'bookings' ? 'active' : ''} onClick={() => setTab('bookings')}>
          <span>📅</span>Prenotazioni
        </a>
        <a className={tab === 'stats' ? 'active' : ''} onClick={() => setTab('stats')}>
          <span>📊</span>Statistiche
        </a>
      </nav>
    </div>
  );
}
