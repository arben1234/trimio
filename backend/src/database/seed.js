const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const path = require('path');
const QRCode = require('qrcode');

const DB_PATH = path.join(__dirname, '../../trimio.sqlite');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON');

const hash = (pw) => bcrypt.hashSync(pw, 10);

const salons = [
  { name: 'Barbershop Milano Centro', slug: 'milano-centro', address: 'Via Roma 12, Milano', phone: '+39 02 1234567' },
  { name: 'Style & Cut Roma', slug: 'style-cut-roma', address: 'Viale Europa 45, Roma', phone: '+39 06 9876543' },
  { name: 'The Barber Napoli', slug: 'barber-napoli', address: 'Corso Umberto 8, Napoli', phone: '+39 081 5551234' },
  { name: 'Gentleman Torino', slug: 'gentleman-torino', address: 'Via Po 22, Torino', phone: '+39 011 4441122' },
  { name: 'Classic Cut Firenze', slug: 'classic-cut-firenze', address: 'Via dei Servi 3, Firenze', phone: '+39 055 2223344' },
  { name: 'Urban Barber Bologna', slug: 'urban-barber-bologna', address: 'Via Indipendenza 15, Bologna', phone: '+39 051 6667788' },
  { name: 'Fade Factory Venezia', slug: 'fade-factory-venezia', address: 'Strada Nova 67, Venezia', phone: '+39 041 9990011' },
  { name: 'Sharp Look Palermo', slug: 'sharp-look-palermo', address: 'Via Libertà 90, Palermo', phone: '+39 091 3334455' },
  { name: 'Kings Barber Bari', slug: 'kings-barber-bari', address: 'Via Sparano 33, Bari', phone: '+39 080 7778899' },
];

const barberNames = [
  ['Marco Rossi', 'Luca Bianchi', 'Davide Ferrari'],
  ['Antonio Esposito', 'Giuseppe Romano', 'Francesco Ricci'],
  ['Giovanni Russo', 'Salvatore Bruno', 'Carmelo Greco'],
  ['Alessandro Gallo', 'Matteo Conti', 'Simone Mancini'],
  ['Federico Martini', 'Nicola Lombardi', 'Andrea Moretti'],
  ['Stefano Costa', 'Daniele Barbieri', 'Emanuele Rizzo'],
  ['Roberto Colombo', 'Massimo Fontana', 'Claudio Marini'],
  ['Vito Messina', 'Enzo Catalano', 'Rosario Grasso'],
  ['Piero Santoro', 'Carmine Ferrara', 'Luigi Conte'],
];

const servicesBySlot = [
  { name: 'Taglio classico', duration_minutes: 30, price: 15 },
  { name: 'Taglio + barba', duration_minutes: 45, price: 22 },
  { name: 'Barba', duration_minutes: 20, price: 10 },
  { name: 'Trattamento capelli', duration_minutes: 60, price: 35 },
];

const clientNames = [
  'Mario Verdi', 'Luigi Neri', 'Carlo Blu', 'Toni Gialli', 'Pino Viola',
  'Sandro Arancio', 'Rino Rosa', 'Beppe Marrone', 'Gino Azzurro', 'Franco Grigio',
];

const times = ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30'];

const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

const BASE_URL = process.env.APP_URL || 'http://localhost:5173';

console.log('Seeding database...\n');

// Elimina dati esistenti (tranne super admin)
db.exec("DELETE FROM bookings");
db.exec("DELETE FROM services");
db.exec("DELETE FROM working_hours");
db.exec("DELETE FROM holidays");
db.exec("DELETE FROM ratings");
db.exec("DELETE FROM users WHERE role != 'super_admin'");
db.exec("DELETE FROM salons");

(async () => {
for (let i = 0; i < salons.length; i++) {
  const s = salons[i];

  const qr_code = await QRCode.toDataURL(`${BASE_URL}/s/${s.slug}`, { width: 300, margin: 2 });

  // Crea salone
  const salonResult = db.prepare(
    'INSERT INTO salons (name, slug, address, phone, qr_code) VALUES (?,?,?,?,?)'
  ).run(s.name, s.slug, s.address, s.phone, qr_code);
  const salonId = salonResult.lastInsertRowid;

  // Owner
  db.prepare('INSERT INTO users (salon_id, name, username, password_hash, role) VALUES (?,?,?,?,?)')
    .run(salonId, 'Proprietario', 'owner', hash('owner123'), 'owner');

  // Servizi
  const svcIds = [];
  for (const svc of servicesBySlot) {
    const r = db.prepare('INSERT INTO services (salon_id, name, duration_minutes, price) VALUES (?,?,?,?)')
      .run(salonId, svc.name, svc.duration_minutes, svc.price);
    svcIds.push(r.lastInsertRowid);
  }

  // Barbers
  const names = barberNames[i];
  for (let j = 0; j < names.length; j++) {
    const bName = names[j];
    const bUsername = bName.split(' ')[0].toLowerCase();
    const bResult = db.prepare('INSERT INTO users (salon_id, name, username, password_hash, role) VALUES (?,?,?,?,?)')
      .run(salonId, bName, bUsername, hash(`${bUsername}123`), 'barber');
    const barberId = bResult.lastInsertRowid;

    // Orari di lavoro (Lun-Sab, giorno libero Dom)
    for (let day = 0; day <= 6; day++) {
      db.prepare('INSERT INTO working_hours (barber_id, day_of_week, start_time, end_time, is_day_off) VALUES (?,?,?,?,?)')
        .run(barberId, day, '09:00', '18:00', day === 0 ? 1 : 0);
    }

    // Prenotazioni ieri, oggi, domani
    const dates = [yesterday, today, tomorrow];
    let timeIdx = j * 4;
    for (const date of dates) {
      for (let t = 0; t < 3; t++) {
        const time = times[(timeIdx + t) % times.length];
        const client = clientNames[(i + j + t) % clientNames.length];
        const svcId = svcIds[t % svcIds.length];
        const status = date === yesterday ? 'completed' : 'confirmed';
        db.prepare('INSERT INTO bookings (salon_id, barber_id, service_id, client_name, client_phone, date, time, status) VALUES (?,?,?,?,?,?,?,?)')
          .run(salonId, barberId, svcId, client, '+39 333 000000' + t, date, time, status);
      }
      timeIdx += 3;
    }
  }

  console.log(`✓ ${s.name} — 3 barbers, 4 servizi, 27 prenotazioni`);
}

// Stampa credenziali
console.log('\n=== CREDENZIALI ===');
console.log('Admin: admin / admin123');
console.log('Ogni salone: owner / owner123');
console.log('Barbers: [nomeproprio] / [nomeproprio]123  (es. marco / marco123)');
console.log('\nSaloni creati:');
salons.forEach(s => console.log(`  ${BASE_URL}/s/${s.slug}`));
console.log('\nSeed completato!');
})();
