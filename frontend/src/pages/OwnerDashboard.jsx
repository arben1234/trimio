import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useSalonAuth } from '../hooks/useAuth';
import { useSSE } from '../hooks/useSSE';
import { usePushSubscription } from '../hooks/usePushSubscription';
import { Toast, useToast } from '../components/Toast';
import { api } from '../utils/api';

function useSalonData(salonSlug) {
  const [salon, setSalon] = useState(null);
  const [barbers, setBarbers] = useState([]);
  useEffect(() => {
    api.getSalon(salonSlug).then(d => { setSalon(d.salon); setBarbers(d.barbers); });
  }, [salonSlug]);
  return { salon, barbers };
}

export default function OwnerDashboard() {
  const { salonSlug } = useParams();
  const navigate = useNavigate();
  const { salon, barbers } = useSalonData(salonSlug);
  const { user, logout, isLoggedIn } = useSalonAuth(salonSlug, salon?.id);
  const { toast, show: showToast } = useToast();

  const [tab, setTab] = useState('bookings');
  const [bookings, setBookings] = useState([]);
  const [stats, setStats] = useState(null);
  const [services, setServices] = useState([]);
  const [filterDate, setFilterDate] = useState(new Date().toISOString().slice(0, 10));
  const [loading, setLoading] = useState(true);
  const [newService, setNewService] = useState({ name: '', duration_minutes: 30, price: '' });

  useEffect(() => {
    if (!salon) return;
    if (!isLoggedIn || user?.role !== 'owner') {
      navigate(`/s/${salonSlug}/login`, { replace: true });
    }
  }, [isLoggedIn, user, salon, salonSlug, navigate]);

  useEffect(() => {
    if (!salon || !isLoggedIn) return;
    setLoading(true);
    Promise.all([
      api.getBookings(salonSlug, { date: filterDate }, salon.id),
      api.getStats(salonSlug, salon.id),
      api.getServices(salonSlug, salon.id)
    ]).then(([b, s, sv]) => { setBookings(b); setStats(s); setServices(sv); }).finally(() => setLoading(false));
  }, [salonSlug, salon, isLoggedIn, filterDate]);

  // SSE: owner riceve TUTTE le prenotazioni del salone
  const handleNewBooking = useCallback((booking) => {
    if (booking.date === filterDate) {
      setBookings(prev => {
        const exists = prev.some(b => b.id === booking.id);
        if (exists) return prev;
        return [booking, ...prev].sort((a, b) => a.time.localeCompare(b.time));
      });
    }
    const isToday = booking.date === new Date().toISOString().slice(0, 10);
    setStats(s => s ? { ...s, today: s.today + (isToday ? 1 : 0), total: s.total + 1 } : s);
    showToast(`📅 ${booking.barber_name || 'Barbiere'}: ${booking.client_name} alle ${booking.time}`);
  }, [filterDate, showToast]);

  useSSE(salonSlug, salon?.id, handleNewBooking);
  usePushSubscription(salon?.id);

  async function updateStatus(bookingId, status) {
    await api.updateBooking(salonSlug, bookingId, { status }, salon.id);
    setBookings(b => b.map(bk => bk.id === bookingId ? { ...bk, status } : bk));
  }

  async function addService(e) {
    e.preventDefault();
    await api.createService(salonSlug, newService, salon.id);
    const sv = await api.getServices(salonSlug, salon.id);
    setServices(sv);
    setNewService({ name: '', duration_minutes: 30, price: '' });
    showToast('Servizio aggiunto');
  }

  async function deleteService(id) {
    await api.deleteService(salonSlug, id, salon.id);
    setServices(s => s.filter(x => x.id !== id));
  }

  if (!user || !salon) return <div className="spinner" />;

  return (
    <div>
      <Toast toast={toast} />

      <div className="header">
        <div>
          <div className="header-logo">TRIMIO</div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            {salon.name}
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
                        <div className="booking-time">{b.time} · <span style={{ color: 'var(--text-muted)' }}>{b.barber_name}</span></div>
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
                        <button className="btn btn-primary btn-sm" onClick={() => updateStatus(b.id, 'completed')}>✓ Completato</button>
                        <button className="btn btn-danger btn-sm" onClick={() => updateStatus(b.id, 'cancelled')}>Annulla</button>
                      </div>
                    )}
                  </div>
                ))
            }
          </>
        )}

        {tab === 'stats' && stats && (
          <>
            <h2 style={{ marginBottom: 16 }}>Statistiche salone</h2>
            <div className="stats-grid">
              <div className="stat-card"><div className="stat-value">{stats.today}</div><div className="stat-label">Oggi</div></div>
              <div className="stat-card"><div className="stat-value">{stats.total}</div><div className="stat-label">Totale</div></div>
              <div className="stat-card"><div className="stat-value">{stats.completed}</div><div className="stat-label">Completati</div></div>
              <div className="stat-card"><div className="stat-value">€{stats.revenue}</div><div className="stat-label">Fatturato</div></div>
            </div>
            <div className="divider" />
            <p className="section-title">Barbieri ({barbers.length})</p>
            {barbers.map(b => (
              <div key={b.id} className="card" style={{ marginBottom: 8 }}>
                <strong>✂️ {b.name}</strong>
              </div>
            ))}
          </>
        )}

        {tab === 'services' && (
          <>
            <form onSubmit={addService} className="card" style={{ marginBottom: 16 }}>
              <p className="section-title" style={{ marginBottom: 12 }}>Aggiungi servizio</p>
              <div className="form-group">
                <label>Nome *</label>
                <input placeholder="Es. Taglio classico" value={newService.name}
                  onChange={e => setNewService(s => ({ ...s, name: e.target.value }))} required />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div className="form-group">
                  <label>Durata (min)</label>
                  <input type="number" min="10" step="5" value={newService.duration_minutes}
                    onChange={e => setNewService(s => ({ ...s, duration_minutes: +e.target.value }))} />
                </div>
                <div className="form-group">
                  <label>Prezzo (€)</label>
                  <input type="number" min="0" step="0.5" placeholder="0" value={newService.price}
                    onChange={e => setNewService(s => ({ ...s, price: +e.target.value }))} required />
                </div>
              </div>
              <button className="btn btn-primary" type="submit">Aggiungi</button>
            </form>

            <p className="section-title">Servizi attivi ({services.length})</p>
            {services.map(s => (
              <div key={s.id} className="booking-item" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <strong>{s.name}</strong>
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>{s.duration_minutes} min</p>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ color: 'var(--gold)', fontWeight: 700 }}>€{s.price}</span>
                  <button className="btn btn-danger btn-sm" onClick={() => deleteService(s.id)}>✕</button>
                </div>
              </div>
            ))}
          </>
        )}

        {tab === 'qr' && (
          <div style={{ textAlign: 'center' }}>
            <h2 style={{ marginBottom: 16 }}>QR Code salone</h2>
            {salon.qr_code
              ? <img src={salon.qr_code} alt="QR" style={{ borderRadius: 12, maxWidth: 260, width: '100%' }} />
              : <div className="card" style={{ padding: 24 }}>
                  <p style={{ color: 'var(--text-muted)' }}>QR non disponibile — generato dall'admin al momento della creazione</p>
                </div>
            }
            <p style={{ color: 'var(--text-muted)', marginTop: 16, fontSize: '0.85rem', wordBreak: 'break-all' }}>
              {window.location.origin}/s/{salon.slug}
            </p>
            <button className="btn btn-secondary" style={{ marginTop: 12 }}
              onClick={() => navigator.clipboard.writeText(`${window.location.origin}/s/${salon.slug}`)}>
              Copia link
            </button>
          </div>
        )}
      </div>

      <nav className="bottom-nav">
        <a className={tab === 'bookings' ? 'active' : ''} onClick={() => setTab('bookings')}><span>📅</span>Prenotazioni</a>
        <a className={tab === 'stats' ? 'active' : ''} onClick={() => setTab('stats')}><span>📊</span>Statistiche</a>
        <a className={tab === 'services' ? 'active' : ''} onClick={() => setTab('services')}><span>✂️</span>Servizi</a>
        <a className={tab === 'qr' ? 'active' : ''} onClick={() => setTab('qr')}><span>📲</span>QR Code</a>
      </nav>
    </div>
  );
}
