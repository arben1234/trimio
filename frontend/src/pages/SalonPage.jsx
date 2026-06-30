import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../utils/api';
import { setToken, setUser } from '../utils/storage';

export default function SalonPage() {
  const { salonSlug } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [step, setStep] = useState('barbers');
  const [selected, setSelected] = useState({ barber: null, service: null, slot: null, date: '' });
  const [slots, setSlots] = useState([]);
  const [form, setForm] = useState({ name: '', phone: '', notes: '' });
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [bookingId, setBookingId] = useState(null);

  // Staff login modal
  const [showLogin, setShowLogin] = useState(false);
  const [loginForm, setLoginForm] = useState({ username: '', password: '' });
  const [loginError, setLoginError] = useState(null);
  const [loginLoading, setLoginLoading] = useState(false);

  useEffect(() => {
    api.getSalon(salonSlug)
      .then(setData)
      .catch((e) => setError(e.message || 'Errore di rete'))
      .finally(() => setLoading(false));
  }, [salonSlug]);

  async function loadSlots(barberId, date, serviceId) {
    if (!date) return;
    const res = await api.getAvailability(salonSlug, barberId, date, serviceId);
    setSlots(res.slots || []);
  }

  async function handleSubmit() {
    setSubmitting(true);
    try {
      const res = await api.createBooking(salonSlug, {
        barberId: selected.barber.id,
        serviceId: selected.service?.id || null,
        clientName: form.name,
        clientPhone: form.phone,
        date: selected.date,
        time: selected.slot,
        notes: form.notes
      });
      setBookingId(res.id);
      setStep('done');
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleStaffLogin(e) {
    e.preventDefault();
    setLoginLoading(true);
    setLoginError(null);
    try {
      const res = await api.salonLogin(salonSlug, loginForm);
      setToken(res.user.salonId, res.token);
      setUser(res.user.salonId, res.user);
      navigate(`/s/${salonSlug}/${res.user.role === 'owner' ? 'owner' : 'barber'}`);
    } catch (e) {
      setLoginError(e.message);
    } finally {
      setLoginLoading(false);
    }
  }

  if (loading) return <div className="spinner" />;
  if (error) return <div className="page"><p className="error-msg">{error}</p></div>;

  const { salon, barbers, services } = data;

  return (
    <div>
      {/* Modal login staff */}
      {showLogin && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
          zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20
        }} onClick={() => { setShowLogin(false); setLoginError(null); setLoginForm({ username: '', password: '' }); }}>
          <div style={{
            background: 'var(--card)', borderRadius: 16, padding: 24, width: '100%', maxWidth: 360
          }} onClick={e => e.stopPropagation()}>
            <h3 style={{ marginBottom: 4, textAlign: 'center' }}>Accesso Staff</h3>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', textAlign: 'center', marginBottom: 20 }}>
              {salon.name}
            </p>
            <form onSubmit={handleStaffLogin}>
              <div className="form-group">
                <label>Nome utente</label>
                <input autoComplete="username" placeholder="owner / nome.barbiere"
                  value={loginForm.username}
                  onChange={e => setLoginForm(f => ({ ...f, username: e.target.value }))} required />
              </div>
              <div className="form-group">
                <label>Password</label>
                <input type="password" autoComplete="current-password" placeholder="••••••••"
                  value={loginForm.password}
                  onChange={e => setLoginForm(f => ({ ...f, password: e.target.value }))} required />
              </div>
              {loginError && <p className="error-msg">{loginError}</p>}
              <button className="btn btn-primary" type="submit" disabled={loginLoading}>
                {loginLoading ? 'Accesso...' : 'Entra'}
              </button>
              <button type="button" className="btn btn-secondary" style={{ marginTop: 8 }}
                onClick={() => { setShowLogin(false); setLoginError(null); }}>
                Annulla
              </button>
            </form>
          </div>
        </div>
      )}

      <div className="header">
        <span className="header-logo">TRIMIO</span>
        <button className="btn btn-secondary btn-sm" style={{ width: 'auto' }}
          onClick={() => setShowLogin(true)}>
          Staff
        </button>
      </div>

      <div className="page">
        <h2 style={{ marginBottom: 4 }}>{salon.name}</h2>
        {salon.address && <p style={{ color: 'var(--text-muted)', marginBottom: 20, fontSize: '0.9rem' }}>{salon.address}</p>}

        {/* Step 1: Scegli barbiere */}
        {step === 'barbers' && (
          <>
            <p className="section-title">Scegli il tuo barbiere</p>
            <div className="barber-grid">
              {barbers.map(b => (
                <div key={b.id} className="barber-card" onClick={() => { setSelected(s => ({ ...s, barber: b })); setStep('service'); }}>
                  {b.photo_url
                    ? <img src={b.photo_url} alt={b.name} style={{ width: 72, height: 72, borderRadius: '50%', objectFit: 'cover', marginBottom: 8, border: '2px solid var(--gold)' }} />
                    : <div className="barber-avatar">✂️</div>
                  }
                  <strong>{b.name}</strong>
                  {b.bio && <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.3 }}>{b.bio}</p>}
                </div>
              ))}
            </div>
          </>
        )}

        {/* Step 2: Scegli servizio */}
        {step === 'service' && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              {selected.barber.photo_url
                ? <img src={selected.barber.photo_url} alt={selected.barber.name} style={{ width: 48, height: 48, borderRadius: '50%', objectFit: 'cover', border: '2px solid var(--gold)' }} />
                : <div style={{ fontSize: '1.5rem' }}>✂️</div>
              }
              <p className="section-title" style={{ margin: 0 }}>Servizio con {selected.barber.name}</p>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {services.length === 0 && (
                <div className="card" onClick={() => setStep('slot')} style={{ cursor: 'pointer' }}>
                  <strong>Taglio standard</strong>
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>30 min</p>
                </div>
              )}
              {services.map(s => (
                <div key={s.id} className="card" style={{ cursor: 'pointer' }}
                  onClick={() => { setSelected(sel => ({ ...sel, service: s })); setStep('slot'); }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <strong>{s.name}</strong>
                      <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>{s.duration_minutes} min</p>
                    </div>
                    <span style={{ color: 'var(--gold)', fontWeight: 700 }}>€{s.price}</span>
                  </div>
                </div>
              ))}
            </div>
            <button className="btn btn-secondary" style={{ marginTop: 12 }} onClick={() => setStep('barbers')}>← Indietro</button>
          </>
        )}

        {/* Step 3: Data e slot */}
        {step === 'slot' && (
          <>
            <p className="section-title">Quando vuoi venire?</p>
            <div className="form-group">
              <label>Data</label>
              <input type="date" min={new Date().toISOString().slice(0, 10)}
                value={selected.date}
                onChange={e => {
                  const d = e.target.value;
                  setSelected(s => ({ ...s, date: d, slot: null }));
                  loadSlots(selected.barber.id, d, selected.service?.id);
                }} />
            </div>
            {selected.date && (
              slots.length === 0
                ? <p style={{ color: 'var(--text-muted)' }}>Nessuno slot disponibile per questa data.</p>
                : <>
                  <p className="section-title">Orario disponibile</p>
                  <div className="slot-grid">
                    {slots.map(s => (
                      <div key={s} className={`slot${selected.slot === s ? ' selected' : ''}`}
                        onClick={() => setSelected(sel => ({ ...sel, slot: s }))}>
                        {s}
                      </div>
                    ))}
                  </div>
                </>
            )}
            {selected.slot && (
              <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => setStep('form')}>
                Continua →
              </button>
            )}
            <button className="btn btn-secondary" style={{ marginTop: 8 }} onClick={() => setStep('service')}>← Indietro</button>
          </>
        )}

        {/* Step 4: Dati cliente */}
        {step === 'form' && (
          <>
            <p className="section-title">I tuoi dati</p>
            <p className="card" style={{ marginBottom: 16, fontSize: '0.9rem' }}>
              {selected.barber.name} · {selected.service?.name || 'Taglio'} · {selected.date} alle {selected.slot}
            </p>
            <div className="form-group">
              <label>Nome *</label>
              <input placeholder="Il tuo nome" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
            </div>
            <div className="form-group">
              <label>Telefono</label>
              <input type="tel" placeholder="+39 000 0000000" value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} />
            </div>
            <div className="form-group">
              <label>Note (opzionale)</label>
              <input placeholder="Es. taglio corto ai lati" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
            </div>
            {error && <p className="error-msg">{error}</p>}
            <button className="btn btn-primary" disabled={!form.name || submitting} onClick={handleSubmit}>
              {submitting ? 'Invio...' : 'Conferma prenotazione'}
            </button>
            <button className="btn btn-secondary" style={{ marginTop: 8 }} onClick={() => setStep('slot')}>← Indietro</button>
          </>
        )}

        {/* Step 5: Conferma */}
        {step === 'done' && (
          <div style={{ textAlign: 'center', paddingTop: 24 }}>
            <div style={{ fontSize: '4rem', marginBottom: 12 }}>✅</div>
            <h2 style={{ color: 'var(--success)', marginBottom: 8 }}>Prenotazione confermata!</h2>
            <div className="card" style={{ textAlign: 'left', margin: '20px 0', lineHeight: 2 }}>
              <p>👤 <strong>{form.name}</strong></p>
              <p>✂️ {selected.barber.name}</p>
              {selected.service && <p>💈 {selected.service.name} · €{selected.service.price}</p>}
              <p>📅 {selected.date} alle <strong>{selected.slot}</strong></p>
              {form.phone && <p>📞 {form.phone}</p>}
              {form.notes && <p>📝 {form.notes}</p>}
            </div>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginBottom: 24 }}>
              Il barbiere è stato notificato. Ti aspettiamo!
            </p>
            <button className="btn btn-primary" onClick={() => {
              setStep('barbers');
              setSelected({ barber: null, service: null, slot: null, date: '' });
              setForm({ name: '', phone: '', notes: '' });
              setError(null);
            }}>
              Nuova prenotazione
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
