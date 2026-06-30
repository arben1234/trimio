import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../utils/api';

export default function SalonPage() {
  const { salonSlug } = useParams();
  const [data, setData] = useState(null);
  const [step, setStep] = useState('barbers'); // barbers → service → slot → form → done
  const [selected, setSelected] = useState({ barber: null, service: null, slot: null, date: '' });
  const [slots, setSlots] = useState([]);
  const [form, setForm] = useState({ name: '', phone: '', notes: '' });
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [bookingId, setBookingId] = useState(null);

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

  if (loading) return <div className="spinner" />;
  if (error) return <div className="page"><p className="error-msg">{error}</p></div>;

  const { salon, barbers, services } = data;

  return (
    <div>
      <div className="header">
        <span className="header-logo">TRIMIO</span>
        <Link to={`/s/${salonSlug}/login`} className="btn btn-secondary btn-sm" style={{ width: 'auto' }}>
          Staff
        </Link>
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
                  <div className="barber-avatar">✂️</div>
                  <strong>{b.name}</strong>
                </div>
              ))}
            </div>
          </>
        )}

        {/* Step 2: Scegli servizio */}
        {step === 'service' && (
          <>
            <p className="section-title">Servizio con {selected.barber.name}</p>
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

        {/* Step 3: Scegli data e slot */}
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

        {/* Step 5: Conferma cliente */}
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
