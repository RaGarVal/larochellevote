/**
 * generate-scrutin-og-images.js — La Rochelle Vote
 * ─────────────────────────────────────────────────────────────────────────────
 * Génère une image Open Graph (PNG) par scrutin dans /scrutins/share/ en
 * réutilisant le système d'export natif de LRVcarte (window.compose() /
 * window.composeFiche()). Même rendu visuel que les images générées par
 * le bouton "Exporter en image" du site.
 *
 * Stratégie identique à daily-capture.js :
 *   1. Lance Chromium headless via Puppeteer
 *   2. Intercepte les tuiles OSM/Carto (réponse PNG blanc) pour ne pas
 *      bloquer Leaflet en attente du chargement de la carte
 *   3. Navigue vers LRVcarte.html#election=X[&canton=Y][&tab=global]
 *   4. Attend que compose/composeFiche soient exposées + ELECTIONS chargé
 *   5. Appelle composeFiche(getFicheContext()) si une fiche est ouverte,
 *      sinon compose() pour la carte seule
 *   6. Récupère le PNG (canvas.toDataURL) et l'écrit dans /scrutins/share/
 *
 * Usage :
 *   1. Serveur HTTP local : `python3 -m http.server 8765` à la racine
 *   2. `node tools/generate-scrutin-og-images.js`
 *
 * Options :
 *   --only <slug>   Régénère une seule image (debug)
 *   DEBUG=1         Affiche les logs du browser
 *   BASE_URL=...    Surcharge l'URL du serveur (défaut http://localhost:8765)
 */

const puppeteer = require('puppeteer');
const fs        = require('fs');
const path      = require('path');
const vm        = require('vm');

const ROOT      = path.resolve(__dirname, '..');
const SCRUTINS  = path.join(ROOT, 'scrutins');
const OUT_DIR   = path.join(SCRUTINS, 'share');
const BASE_URL  = process.env.BASE_URL || 'http://localhost:8765';
const VIEWPORT  = { width: 1280, height: 800, deviceScaleFactor: 2 };

// PNG transparent 1×1 pour répondre aux requêtes de tuiles OSM/Carto
const BLANK_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ' +
  'AAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

// ─── Liste des slugs à générer (depuis ELECTIONS) ───────────────────────────
function loadElections() {
  const src = fs.readFileSync(path.join(ROOT, 'donnees.js'), 'utf8');
  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext(src + ';Object.assign(globalThis,{ELECTIONS});', sandbox);
  return sandbox.ELECTIONS;
}
function slugifyElection(label) {
  return label.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function buildJobs(ELECTIONS) {
  const jobs = [];
  Object.entries(ELECTIONS).forEach(([label, el]) => {
    // Skip les élections marquées draft (cohérent avec build-scrutins.js et check-scrutins.js)
    if (el && el.draft === true) return;
    if (el.par_canton) {
      Object.keys(el.par_canton).sort().forEach(cid => {
        jobs.push({ slug: slugifyElection(label) + '-canton-' + cid, label, canton: cid });
      });
    } else {
      jobs.push({ slug: slugifyElection(label), label, canton: null });
    }
  });
  return jobs;
}

// ─── Capture d'un scrutin ────────────────────────────────────────────────────
async function captureScrutin(page, job) {
  // hash params : on ouvre la fiche globale (tab=global) ou canton selon le cas.
  // PAS de mode=export → on appellera directement compose/composeFiche.
  const params = new URLSearchParams();
  params.set('election', job.label);
  if (job.canton) params.set('canton', job.canton);
  else params.set('tab', 'global');
  const url = `${BASE_URL}/LRVcarte.html#${params.toString()}`;

  await page.goto('about:blank');
  try {
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
  } catch (_) { /* timeout toléré, Leaflet a parfois du networkidle qui ne se résout pas */ }

  // Attendre que compose/composeFiche soient exposés + ELECTIONS chargé
  await page.waitForFunction(
    () => typeof window.compose === 'function'
       && typeof window.composeFiche === 'function'
       && typeof window.getFicheContext === 'function'
       && typeof ELECTIONS !== 'undefined'
       && Object.keys(ELECTIONS).length > 0,
    { timeout: 30000 }
  );

  // Attente du rendu effectif (en remplacement d'un sleep forfaitaire 3s × 62 = 186s) :
  //  - cas canton : on attend que window.getFicheContext() retourne un contexte non-null
  //    (= selectCantonFromList est résolu et a peuplé la fiche)
  //  - cas tab=global : on attend qu'au moins un <path.leaflet-interactive> soit présent
  //    (= la choroplèthe Leaflet a été bindée). Polling 100ms, fallback silencieux à 2.5s.
  await page.waitForFunction(
    () => {
      try {
        if (typeof window.getFicheContext === 'function' && window.getFicheContext()) return true;
      } catch (_) {}
      return document.querySelectorAll('path.leaflet-interactive').length > 0;
    },
    { timeout: 2500, polling: 100 }
  ).catch(() => { /* fallback : on tente quand même le compose ci-dessous */ });

  // Appel direct du compositeur natif (skip fonts.ready via _exportMode)
  const dataUrl = await page.evaluate(async () => {
    window._exportMode = true;
    const fctx = window.getFicheContext();
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('compose timeout 60s')), 60000));
    const composer = fctx ? window.composeFiche(fctx) : window.compose();
    const canvas = await Promise.race([composer, timeout]);
    if (!canvas) throw new Error('canvas null');
    return canvas.toDataURL('image/png');
  });
  if (!dataUrl || !dataUrl.startsWith('data:image/png;base64,')) {
    throw new Error('dataUrl manquant ou format invalide');
  }
  return Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
}

// ─── Main ────────────────────────────────────────────────────────────────────
(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const ELECTIONS = loadElections();
  const jobs = buildJobs(ELECTIONS);

  const onlyArg = process.argv.indexOf('--only');
  const only = onlyArg >= 0 ? process.argv[onlyArg + 1] : null;
  const list = only ? jobs.filter(j => j.slug === only) : jobs;

  console.log(`📸 ${list.length} captures à faire vers ${OUT_DIR}/`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);

  // Intercepter les tuiles OSM/Carto : on répond avec un PNG blanc instantané
  // pour que Leaflet n'attende pas indéfiniment leur chargement.
  await page.setRequestInterception(true);
  page.on('request', req => {
    if (/cartocdn\.com|openstreetmap\.org|cloudflareinsights/i.test(req.url())) {
      req.respond({ status: 200, contentType: 'image/png', body: BLANK_PNG });
    } else {
      req.continue();
    }
  });

  if (process.env.DEBUG) {
    page.on('console', m => console.log('[B]', m.type(), m.text()));
    page.on('pageerror', e => console.log('[ERR]', e.message));
  }

  let ok = 0, fail = 0;
  for (const job of list) {
    const out = path.join(OUT_DIR, `${job.slug}.png`);
    try {
      const buf = await captureScrutin(page, job);
      fs.writeFileSync(out, buf);
      ok++;
      if (ok % 5 === 0 || ok === list.length) console.log(`  ${ok}/${list.length}  (${job.slug})`);
    } catch (err) {
      console.error(`  ✗ ${job.slug} — ${err.message}`);
      fail++;
    }
  }

  await browser.close();
  console.log(`\n✅ ${ok} captures réussies, ❌ ${fail} échecs`);
  if (fail > 0) process.exit(1);
})();
