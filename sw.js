self.addEventListener('push', function(event) {
  console.log('[Service Worker] Push Received.');
  let data = { title: 'Trimio', body: 'Hai un nuovo aggiornamento!' };
  try {
    if (event.data) {
      data = event.data.json();
    }
  } catch (e) {
    // Fallback if data is not JSON
    if (event.data) {
      data.body = event.data.text();
    }
  }

  const options = {
    body: data.body,
    icon: '/logo.svg',
    badge: '/logo.svg',
    vibrate: [100, 50, 100],
    data: {
      url: data.url || '/'
    },
    actions: [
      { action: 'open', title: 'Apri Trimio' }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(windowClients) {
      for (let i = 0; i < windowClients.length; i++) {
        if ('focus' in windowClients[i]) {
          return windowClients[i].focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow('/');
      }
    })
  );
});
