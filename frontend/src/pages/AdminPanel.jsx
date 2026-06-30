import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAdminAuth } from '../hooks/useAuth';
import { api } from '../utils/api';

export default function AdminPanel() {
  const navigate = useNavigate();
  const { user, logout, isLoggedIn } = useAdminAuth();
  const [tab, setTab] = useState('salons');
  const [salons, setSalons] = useState([]);
  const [stats, setStats] = useState(null);
  const [selectedSalon, setSelectedSalon] = useState(null);
  const [barbers, setBarbers] = useState([]);
  const [newSalon, setNewSalon] = useState({ name: '', address: '', phone: '' });
  const [newBarber, setNewBarber] = useState({ name: '', username: '', password: '', role: 'barber' });
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    if (!isLoggedIn) navigate('/', { replace: true });
  }, [isLoggedIn, navigate]);

  useEffect(() => {
    if (!isLoggedIn) return;
    Promise.all([api.admin.getSalons(), api.admin.getStats()])
      .then(([s, st]) => { setSalons(s); setStats(st); })
      .finally(() => setLoading(false));
  }, [isLoggedIn]);

  function showToast(msg, type = 'ok') {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }

  async function createSalon(e) {
    e.preventDefault();
    const res = await api.admin.createSalon({ ...newSalon, baseUrl: window.location.origin });
    setSalons(s => [...s, res]);
    setNewSalon({ name: '', address: '', phone: '' });
    showToast('Salone creato con QR code!');
    const updated = await api.admin.getSalons();
    setSalons(updated);
  }

  async function deleteSalon(id) {
    if (!confirm('Eliminare questo salone e tutti i dati?')) return;
    await api.admin.deleteSalon(id);
    setSalons(s => s.filter(x => x.id !== id));
    if (selectedSalon?.id === id) setSelectedSalon(null);
  }

  async function loadBarbers(salon) {
    setSelectedSalon(salon);
    const b = await api.admin.getBarbers(salon.id);
    setBarbers(b);
    setTab('barbers');
  }

  async function addBarber(e) {
    e.preventDefault();
    await api.admin.addBarber(selectedSalon.id, newBarber);
    const b = await api.admin.getBarbers(selectedSalon.id);
    setBarbers(b);
    setNewBarber({ name: '', username: '', password: '', role: 'barber' });
    showToast('Barbiere aggiunto');
  }

  async function deleteBarber(id) {
    await api.admin.deleteBarber(id);
    setBarbers(b => b.filter(x => x.id !== id));
  }

  if (!isLoggedIn || loading) return <div className="spinner" />;

  return (
    <div>
      <div className="header">
        <div className="header-logo">TRIMIO Admin</div>
        <button className="btn btn-secondary btn-sm" onClick={() => { logout(); navigate('/'); }}>Esci</button>
      </div>

      <div className="page">
        {stats && tab !== 'barbers' && (
          <div className="stats-grid" style={{ marginBottom: 20 }}>
            <div className="stat-card"><div className="stat-value">{stats.totalSalons}</div><div className="stat-label">Saloni</div></div>
            <div className="stat-card"><div className="stat-value">{stats.totalBarbers}</div><div className="stat-label">Barbieri</div></div>
            <div className="stat-card"><div className="stat-value">{stats.todayBookings}</div><div className="stat-label">Oggi</div></div>
            <div className="stat-card"><div className="stat-value">{stats.totalBookings}</div><div className="stat-label">Tot. pren.</div></div>
          </div>
        )}

        {tab === 'salons' && (
          <>
            <p className="section-title">Crea nuovo salone</p>
            <form onSubmit={createSalon} className="card" style={{ marginBottom: 20 }}>
              <div className="form-group">
                <label>Nome salone *</label>
                <input placeholder="Barbershop Milano" value={newSalon.name} onChange={e => setNewSalon(s => ({ ...s, name: e.target.value }))} required />
              </div>
              <div className="form-group">
                <label>Indirizzo</label>
                <input placeholder="Via Roma 1, Milano" value={newSalon.address} onChange={e => setNewSalon(s => ({ ...s, address: e.target.value }))} />
              </div>
              <div className="form-group">
                <label>Telefono</label>
                <input placeholder="+39 000 0000000" value={newSalon.phone} onChange={e => setNewSalon(s => ({ ...s, phone: e.target.value }))} />
              </div>
              <button className="btn btn-primary" type="submit">Crea salone + QR</button>
            </form>

            <p className="section-title">Saloni attivi</p>
            {salons.map(s => (
              <div key={s.id} className="card" style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <strong>{s.name}</strong>
                    {s.address && <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>{s.address}</p>}
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn btn-secondary btn-sm" onClick={() => loadBarbers(s)}>Staff</button>
                    <button className="btn btn-danger btn-sm" onClick={() => deleteSalon(s.id)}>✕</button>
                  </div>
                </div>
                <div style={{ marginTop: 12, textAlign: 'center' }}>
                  {s.qr_code && (
                    <img src={s.qr_code} alt="QR" style={{ borderRadius: 12, maxWidth: 260, width: '100%' }} />
                  )}
                  <p style={{ color: 'var(--text-muted)', marginTop: 8, fontSize: '0.85rem', wordBreak: 'break-all' }}>
                    {window.location.origin}/s/{s.slug}
                  </p>
                  <button className="btn btn-secondary" style={{ marginTop: 8 }}
                    onClick={() => navigator.clipboard.writeText(`${window.location.origin}/s/${s.slug}`)}>
                    Copia link
                  </button>
                </div>
              </div>
            ))}
          </>
        )}

        {tab === 'barbers' && selectedSalon && (
          <>
            <button className="btn btn-secondary btn-sm" style={{ marginBottom: 16, width: 'auto' }} onClick={() => setTab('salons')}>
              ← {selectedSalon.name}
            </button>
            <p className="section-title">Aggiungi barbiere / owner</p>
            <form onSubmit={addBarber} className="card" style={{ marginBottom: 20 }}>
              <div className="form-group">
                <label>Nome *</label>
                <input placeholder="Marco Rossi" value={newBarber.name} onChange={e => setNewBarber(b => ({ ...b, name: e.target.value }))} required />
              </div>
              <div className="form-group">
                <label>Username *</label>
                <input placeholder="marco" value={newBarber.username} onChange={e => setNewBarber(b => ({ ...b, username: e.target.value }))} required />
              </div>
              <div className="form-group">
                <label>Password (default: username123)</label>
                <input placeholder="Lascia vuoto per default" value={newBarber.password} onChange={e => setNewBarber(b => ({ ...b, password: e.target.value }))} />
              </div>
              <div className="form-group">
                <label>Ruolo</label>
                <select value={newBarber.role} onChange={e => setNewBarber(b => ({ ...b, role: e.target.value }))}>
                  <option value="barber">Barbiere</option>
                  <option value="owner">Proprietario</option>
                </select>
              </div>
              <button className="btn btn-primary" type="submit">Aggiungi</button>
            </form>

            <p className="section-title">Staff ({barbers.length})</p>
            {barbers.map(b => (
              <div key={b.id} className="booking-item">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <strong>{b.name}</strong>
                    <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>{b.username} · {b.role}</p>
                  </div>
                  {b.role !== 'super_admin' && (
                    <button className="btn btn-danger btn-sm" onClick={() => deleteBarber(b.id)}>✕</button>
                  )}
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {toast && <div className={`toast${toast.type === 'error' ? ' error' : ''}`}>{toast.msg}</div>}

      <nav className="bottom-nav">
        <a className={tab === 'salons' ? 'active' : ''} onClick={() => setTab('salons')}><span>🏪</span>Saloni</a>
      </nav>
    </div>
  );
}
