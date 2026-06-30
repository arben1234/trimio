import React, { useState, useCallback } from 'react';

export function useToast() {
  const [toast, setToast] = useState(null);

  const show = useCallback((msg, type = 'success') => {
    setToast({ msg, type, key: Date.now() });
    setTimeout(() => setToast(null), 4000);
  }, []);

  return { toast, show };
}

export function Toast({ toast }) {
  if (!toast) return null;
  return (
    <div
      key={toast.key}
      style={{
        position: 'fixed',
        top: 80,
        left: '50%',
        transform: 'translateX(-50%)',
        background: toast.type === 'error' ? 'var(--danger)' : 'var(--success)',
        color: 'white',
        padding: '14px 24px',
        borderRadius: 'var(--radius)',
        fontWeight: 600,
        fontSize: '0.95rem',
        zIndex: 9999,
        boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
        whiteSpace: 'nowrap',
        animation: 'slideDown 0.3s ease',
        maxWidth: '90vw',
        textAlign: 'center'
      }}
    >
      {toast.msg}
    </div>
  );
}
