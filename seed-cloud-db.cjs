const fs = require('fs');
const path = require('path');

// Mock browser environment
global.window = {
  addEventListener: () => {},
  scrollTo: () => {},
  storage: null,
  location: { hash: '' }
};
global.document = {
  addEventListener: () => {},
  querySelectorAll: () => [],
  querySelector: () => null,
  getElementById: () => null
};
global.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {}
};
global.L = {
  latLngBounds: () => ({ fitBounds: () => {} }),
  map: () => ({ fitBounds: () => {} })
};
global.navigator = { geolocation: {} };
global.location = { hash: '' };

// Read app.js content
const appJsPath = path.join(__dirname, 'js', 'app.js');
let appJsContent = fs.readFileSync(appJsPath, 'utf8');

// Strip out the call to boot() at the end to prevent automatic execution
appJsContent = appJsContent.replace('boot();', '');
appJsContent = appJsContent.replace('let STATE', 'global.STATE');

// Evaluate app.js in global context
try {
  eval(appJsContent);
} catch (e) {
  // Ignored if some DOM APIs throw
}

// Check if STATE.salons is populated
if (!global.STATE || !global.STATE.salons) {
  console.error('Failed to extract STATE.salons from app.js');
  process.exit(1);
}

// Normalize credentials
const salons = global.STATE.salons;
salons.forEach(s => {
  if (s.ownerPassword === 'owner123' && s.ownerUsername !== 'owner') {
    s.ownerUsername = 'owner';
  }
  if (s.workers) {
    const nameCounts = {};
    s.workers.forEach(w => {
      const firstName = w.name.split(' ')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
      nameCounts[firstName] = (nameCounts[firstName] || 0) + 1;
      const suffix = nameCounts[firstName] > 1 ? (nameCounts[firstName] - 1) : '';
      
      w.username = firstName + suffix;
      w.password = firstName + '123';
    });
  }
});

// Load environment variables from .env.local (which we pulled earlier)
const envPath = path.join(__dirname, '.env.local');
// Oh wait, we deleted .env.local! Let's pull it again in the script or run CLI.
// Actually, we can just write to a local JSON and POST it to the Vercel Function!
// Yes, we can just POST to https://trimio-two.vercel.app/api/sync directly!
// Let's do that! It's much easier.

async function seed() {
  try {
    console.log(`Seeding database to Vercel KV with ${salons.length} salons...`);
    const resp = await fetch('https://trimio-two.vercel.app/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bookings: [],
        salons: salons
      })
    });
    const res = await resp.json();
    console.log('Seeding response:', res);
  } catch (err) {
    console.error('Seeding error:', err);
  }
}

seed();
