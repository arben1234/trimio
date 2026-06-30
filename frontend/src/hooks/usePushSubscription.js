import { useEffect } from 'react';
import { api } from '../utils/api';

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - base64.length % 4) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

// Richiede il permesso push e salva la subscription sul server.
// Silenzioso se il browser non supporta push o se VAPID non è configurato.
export function usePushSubscription(salonId) {
  useEffect(() => {
    if (!salonId) return;
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;

    async function subscribe() {
      try {
        const { key } = await api.getVapidKey();
        if (!key) return;

        const permission = await Notification.requestPermission();
        if (permission !== 'granted') return;

        const reg = await navigator.serviceWorker.ready;

        // Se già iscritto invia la subscription esistente (aggiorna il DB)
        const existing = await reg.pushManager.getSubscription();
        if (existing) {
          await api.savePushSub(existing, salonId);
          return;
        }

        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(key)
        });
        await api.savePushSub(sub, salonId);
      } catch {}
    }

    subscribe();
  }, [salonId]);
}
