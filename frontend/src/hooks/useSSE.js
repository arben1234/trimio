import { useEffect, useRef } from 'react';
import { getToken } from '../utils/storage';

// Zë njoftimi me Web Audio API — pa skedar audio të jashtëm
function playNotificationSound() {
  try {
    const ctx = new AudioContext();
    const times = [0, 0.15, 0.3];
    const freqs = [880, 1100, 1320];
    times.forEach((t, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = freqs[i];
      gain.gain.setValueAtTime(0.25, ctx.currentTime + t);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.2);
      osc.start(ctx.currentTime + t);
      osc.stop(ctx.currentTime + t + 0.2);
    });
  } catch {}
}

export function useSSE(salonSlug, salonId, onNewBooking) {
  const esRef = useRef(null);
  const callbackRef = useRef(onNewBooking);

  // Keep callbackRef current so the SSE listener always calls the latest version
  // without needing to re-establish the connection on every filterDate change
  useEffect(() => {
    callbackRef.current = onNewBooking;
  }, [onNewBooking]);

  useEffect(() => {
    if (!salonSlug || !salonId) return;
    const token = getToken(salonId);
    if (!token) return;

    let retryTimer = null;

    function connect() {
      const url = `/api/salons/${salonSlug}/events?token=${encodeURIComponent(getToken(salonId))}`;
      const es = new EventSource(url);
      esRef.current = es;

      es.addEventListener('new-booking', (e) => {
        const booking = JSON.parse(e.data);
        playNotificationSound();
        callbackRef.current(booking);
      });

      es.onerror = () => {
        es.close();
        esRef.current = null;
        retryTimer = setTimeout(connect, 3000);
      };
    }

    connect();

    return () => {
      clearTimeout(retryTimer);
      esRef.current?.close();
      esRef.current = null;
    };
  }, [salonSlug, salonId]);
}
