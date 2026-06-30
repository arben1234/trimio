const QRCode = require('qrcode');

async function generateQR(url) {
  return QRCode.toDataURL(url, { width: 300, margin: 2 });
}

function buildSalonUrl(slug, baseUrl) {
  const base = baseUrl || process.env.APP_URL || 'http://localhost:5173';
  return `${base}/s/${slug}`;
}

module.exports = { generateQR, buildSalonUrl };
