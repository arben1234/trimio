import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useSalonAuth } from '../hooks/useAuth';
import { api } from '../utils/api';

export default function StaffLogin() {
  const { salonSlug } = useParams();
  const navigate = useNavigate();
  const [salon, setSalon] = useState(null);
  const [salonId, setSalonId] = useState(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const { login, loading, error, isLoggedIn, user } = useSalonAuth(salonSlug, salonId);

  useEffect(() => {
    api.getSalon(salonSlug).then(d => {
      setSalon(d.salon);
      setSalonId(d.salon.id);
    });
  }, [salonSlug]);

  // Se già loggato nel salone corretto, redirect diretto
  useEffect(() => {
    if (isLoggedIn && user) {
      navigate(user.role === 'owner' ? `/s/${salonSlug}/owner` : `/s/${salonSlug}/barber`, { replace: true });
    }
  }, [isLoggedIn, user, salonSlug, navigate]);

  async function handleLogin(e) {
    e.preventDefault();
    const u = await login(username, password);
    if (u) {
      navigate(u.role === 'owner' ? `/s/${salonSlug}/owner` : `/s/${salonSlug}/barber`, { replace: true });
    }
  }

  return (
    <div className="login-page">
      <div className="login-logo">TRIMIO</div>
      <p className="login-subtitle">{salon?.name || 'Caricamento...'}</p>
      <div className="login-box">
        <h3 style={{ marginBottom: 20, textAlign: 'center' }}>Accesso Staff</h3>
        <form onSubmit={handleLogin}>
          <div className="form-group">
            <label>Nome utente</label>
            <input autoComplete="username" placeholder="owner / nome.barbiere"
              value={username} onChange={e => setUsername(e.target.value)} required />
          </div>
          <div className="form-group">
            <label>Password</label>
            <input type="password" autoComplete="current-password" placeholder="••••••••"
              value={password} onChange={e => setPassword(e.target.value)} required />
          </div>
          {error && <p className="error-msg">{error}</p>}
          <button className="btn btn-primary" type="submit" disabled={loading}>
            {loading ? 'Accesso...' : 'Entra'}
          </button>
        </form>
      </div>
    </div>
  );
}
