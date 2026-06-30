import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAdminAuth } from '../hooks/useAuth';

export default function AdminLogin() {
  const navigate = useNavigate();
  const { login, loading, error, isLoggedIn } = useAdminAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  useEffect(() => {
    if (isLoggedIn) navigate('/admin', { replace: true });
  }, [isLoggedIn, navigate]);

  async function handleLogin(e) {
    e.preventDefault();
    const u = await login(username, password);
    if (u) navigate('/admin', { replace: true });
  }

  return (
    <div className="login-page">
      <div className="login-logo">TRIMIO</div>
      <p className="login-subtitle">Pannello amministratore</p>
      <div className="login-box">
        <form onSubmit={handleLogin}>
          <div className="form-group">
            <label>Utente</label>
            <input placeholder="admin" value={username} onChange={e => setUsername(e.target.value)} required />
          </div>
          <div className="form-group">
            <label>Password</label>
            <input type="password" placeholder="••••••••" value={password} onChange={e => setPassword(e.target.value)} required />
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
