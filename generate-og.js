/**
 * generate-og.js — génère share.png (vignette Open Graph) à partir de vignette-og.html
 * ─────────────────────────────────────────────────────────────────────────────
 * Capture la zone .card de la page vignette-og.html en headless Chromium et
 * sauvegarde en PNG 1200×630 à la racine du projet sous le nom share.png.
 *
 * Lancement :   node generate-og.js
 * ─────────────────────────────────────────────────────────────────────────────
 */

const puppeteer = require('puppeteer');
const path      = require('path');

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });

  const url = 'file://' + path.join(__dirname, 'vignette-og.html');
  console.log('🌐 →', url);
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });

  // Couleur de la voile : prise dans process.env.COLOR si fourni, sinon rouge par défaut.
  // Exemples : COLOR=#0F55CC node generate-og.js  (bleu)
  //           COLOR=#6AA84F node generate-og.js  (vert)
  const color = process.env.COLOR || '#CC0100';
  await page.evaluate((c) => {
    document.getElementById('sail').style.setProperty('--sail-color', c);
  }, color);
  console.log('🎨 Couleur voile :', color);

  // Attendre que les fonts Space Grotesk soient chargées (sinon polices fallback)
  try { await page.evaluate(() => document.fonts && document.fonts.ready); } catch(_) {}
  // Petite attente supplémentaire pour stabiliser le rendu
  await new Promise(r => setTimeout(r, 500));

  // Capture du nœud .card → exactement 1200×630 (taille explicite dans la CSS)
  const card = await page.$('.card');
  if (!card) {
    console.error('❌ .card introuvable dans vignette-og.html');
    await browser.close();
    process.exit(1);
  }

  const outPath = path.join(__dirname, 'share.png');
  await card.screenshot({ path: outPath, type: 'png', omitBackground: false });
  console.log('✅ Vignette OG sauvegardée :', outPath);

  await browser.close();
})();
