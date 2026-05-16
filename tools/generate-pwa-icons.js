/**
 * generate-pwa-icons.js — La Rochelle Vote
 * ─────────────────────────────────────────────────────────────────────────────
 * Génère les icônes PNG nécessaires à la PWA à partir de favicon.svg.
 *
 * Sorties (dans /icons/) :
 *   icon-192.png        → manifest.json (Android Chrome standard)
 *   icon-512.png        → manifest.json (Android Chrome haute résolution + splash)
 *   apple-touch-icon.png → 180×180, iOS Safari "Sur l'écran d'accueil"
 *
 * Méthode : Puppeteer rend le SVG dans un canvas HTML à la bonne taille,
 * avec un padding et un fond pour respecter les conventions iOS/Android
 * (logo qui occupe ~80 % de l'icône, fond de couleur de marque).
 *
 * Usage : node tools/generate-pwa-icons.js
 * ─────────────────────────────────────────────────────────────────────────────
 */

const puppeteer = require('puppeteer');
const fs        = require('fs');
const path      = require('path');

const ROOT = path.resolve(__dirname, '..');
// On utilise icons/logo-pwa.svg : version dense (barres 4 px, gaps 1 px) plus
// adaptée aux grands formats que le favicon.svg standard (barres 3 px, gaps 2 px).
// Le favicon original reste utilisé pour l'onglet navigateur (taille 16-32 px).
const SVG_PATH = path.join(ROOT, 'icons', 'logo-pwa.svg');
const OUT_DIR  = path.join(ROOT, 'icons');

// Fond de l'icône : dégradé diagonal autour de la teinte chrome (F7F3EE).
// Du clair en haut-gauche vers un beige plus chaud et plus profond en bas-droite.
// Suffisamment marqué pour donner du relief sans écraser la voile rouge.
const BG_GRADIENT = 'linear-gradient(45deg, #FDFAF4 0%, #F6EFE0 50%, #ECE0C7 100%)';

// Tailles à produire
const SIZES = [
  { name: 'icon-192.png',         size: 192 },
  { name: 'icon-512.png',         size: 512 },
  { name: 'apple-touch-icon.png', size: 180 },  // iOS standard
];

(async () => {
  if (!fs.existsSync(SVG_PATH)) {
    console.error('❌ favicon.svg introuvable à', SVG_PATH);
    process.exit(1);
  }
  const svgContent = fs.readFileSync(SVG_PATH, 'utf8');

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();

  for (const { name, size } of SIZES) {
    // On charge un HTML minimal qui place le SVG dans un carré coloré,
    // avec un padding pour que le logo respire (≈ 14 % de marge).
    const pad = Math.round(size * 0.14);
    const svgSize = size - pad * 2;
    const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; }
  .frame {
    width: ${size}px; height: ${size}px;
    background: ${BG_GRADIENT};
    display: flex; align-items: center; justify-content: center;
  }
  .frame > svg { width: ${svgSize}px; height: ${svgSize}px; }
</style></head>
<body><div class="frame">${svgContent}</div></body></html>`;

    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    const el  = await page.$('.frame');
    const buf = await el.screenshot({ type: 'png', omitBackground: false });
    const out = path.join(OUT_DIR, name);
    fs.writeFileSync(out, buf);
    console.log(`✅ ${name}  (${size}×${size}, ${(buf.length / 1024).toFixed(1)} KB)`);
  }

  await browser.close();
  console.log(`\n🎉 Icônes générées dans ${OUT_DIR}`);
})().catch(err => {
  console.error('❌ Erreur :', err);
  process.exit(1);
});
