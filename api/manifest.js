// Dynamic PWA manifest. iOS/Android capture start_url at "Add to Home
// Screen" time; a static start_url ("/#") made every installed app open on
// the root admin login instead of the salon page the user actually saved.
// The client (js/app.js updateManifestLink) points the <link rel=manifest>
// here with the CURRENT path+hash, so the installed app reopens exactly the
// page it was installed from (e.g. /#BARBER_ART).
export default function handler(req, res) {
  let start = typeof req.query.start === 'string' ? req.query.start : '/';
  // Same-origin absolute paths only — reject anything protocol-relative or
  // not rooted at /, falling back to the homepage.
  if (!start.startsWith('/') || start.startsWith('//')) start = '/';

  res.setHeader('Content-Type', 'application/manifest+json');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    name: 'TRIMIO Barber Booking',
    short_name: 'TRIMIO',
    description: 'Sistema di prenotazione per barbieri',
    start_url: start,
    display: 'standalone',
    background_color: '#000000',
    theme_color: '#000000',
    orientation: 'portrait',
    icons: [
      { src: '/logo.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
    ]
  });
}
