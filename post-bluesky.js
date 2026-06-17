/**
 * post-bluesky.js — Publie le tweet du jour sur Bluesky
 * ─────────────────────────────────────────────────────────────────────────────
 * Utilise les fichiers générés par daily-capture.js dans daily-tweet/.
 * Credentials Bluesky récupérés depuis les env vars (GitHub Secrets) :
 *   - BSKY_HANDLE        (ex. larochellevote.bsky.social)
 *   - BSKY_APP_PASSWORD  (App Password créé dans Settings → App Passwords)
 *
 * Étapes :
 *   1. createSession (login avec handle + app password) → accessJwt + did
 *   2. uploadBlob (upload de l'image) → blob ref
 *   3. createRecord (post du contenu + image embed + facets pour les URL)
 *
 * Node 18+ requis (utilise fetch natif).
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs   = require('fs');
const path = require('path');

const HANDLE   = process.env.BSKY_HANDLE;
const PASSWORD = process.env.BSKY_APP_PASSWORD;
const PDS      = 'https://bsky.social';

// GitHub Actions ↔ bsky.social peut occasionnellement timeout au connect (~10 s
// par défaut sous undici). On wrappe fetch dans un retry exponentiel + un timeout
// explicite plus généreux pour absorber ces hoquets réseau sans casser le tweet.
async function fetchWithRetry(url, options = {}, { retries = 4, timeoutMs = 30000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: ac.signal });
      clearTimeout(timer);
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      const isLast = attempt === retries;
      const wait = Math.min(2000 * Math.pow(2, attempt), 16000);  // 2s → 4s → 8s → 16s → 16s
      console.warn(`⚠️  fetch ${url} — tentative ${attempt + 1}/${retries + 1} échouée (${err.code || err.name || 'erreur'}).` + (isLast ? '' : ` Retry dans ${wait / 1000}s…`));
      if (isLast) throw lastErr;
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

if (!HANDLE || !PASSWORD) {
  console.error('❌ BSKY_HANDLE ou BSKY_APP_PASSWORD manquant dans les env vars');
  process.exit(1);
}

const TWEET_DIR      = path.join(__dirname, 'daily-tweet');
const TWEET_TXT_PATH = path.join(TWEET_DIR, 'tweet.txt');
const IMAGE_PATH     = path.join(TWEET_DIR, 'image.png');

if (!fs.existsSync(TWEET_TXT_PATH) || !fs.existsSync(IMAGE_PATH)) {
  console.error('❌ Fichiers manquants dans daily-tweet/. Le script daily-capture.js a-t-il tourné ?');
  process.exit(1);
}

let tweetText = fs.readFileSync(TWEET_TXT_PATH, 'utf8').trim();
const imageBytes = fs.readFileSync(IMAGE_PATH);

// Bluesky a une limite de 300 chars (sans raccourcissement d'URL contrairement à Twitter).
// Si le tweet contient un deep link long et dépasse 300 chars, on le remplace par l'URL
// du site simple (raccourci) pour rester dans les clous.
if (tweetText.length > 300) {
  console.log(`⚠️  Tweet trop long pour Bluesky (${tweetText.length} chars), remplacement du deep link par l'URL courte`);
  tweetText = tweetText.replace(/https:\/\/larochellevote\.fr\/LRVcarte\.html#\S+/g, 'https://larochellevote.fr');
}

console.log(`📄 Texte du tweet : ${tweetText.length} caractères`);
console.log(`🖼️  Image : ${(imageBytes.length / 1024).toFixed(0)} KB`);

(async () => {
  // ── 1. Login ───────────────────────────────────────────────────────────────
  console.log('🔑 Authentification Bluesky…');
  const sessionRes = await fetchWithRetry(`${PDS}/xrpc/com.atproto.server.createSession`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: HANDLE, password: PASSWORD }),
  });
  if (!sessionRes.ok) {
    console.error(`❌ Login échoué : ${sessionRes.status} ${sessionRes.statusText}`);
    console.error(await sessionRes.text());
    process.exit(1);
  }
  const session = await sessionRes.json();
  const { accessJwt, did } = session;
  console.log(`✅ Connecté en tant que ${session.handle} (DID : ${did})`);

  // ── 2. Upload de l'image ───────────────────────────────────────────────────
  console.log('📤 Upload de l\'image…');
  const uploadRes = await fetchWithRetry(`${PDS}/xrpc/com.atproto.repo.uploadBlob`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessJwt}`,
      'Content-Type': 'image/png',
    },
    body: imageBytes,
  });
  if (!uploadRes.ok) {
    console.error(`❌ Upload échoué : ${uploadRes.status} ${uploadRes.statusText}`);
    console.error(await uploadRes.text());
    process.exit(1);
  }
  const { blob } = await uploadRes.json();
  console.log(`✅ Blob uploadé : ${blob.size} bytes`);

  // ── 3. Construire les facets pour rendre les URL cliquables ────────────────
  // Bluesky ne fait pas d'auto-link → il faut spécifier les facets en bytes (UTF-8).
  const facets = [];
  const urlRegex = /https?:\/\/\S+/g;
  let match;
  while ((match = urlRegex.exec(tweetText)) !== null) {
    const url        = match[0];
    const charStart  = match.index;
    const byteStart  = Buffer.byteLength(tweetText.slice(0, charStart), 'utf8');
    const byteEnd    = byteStart + Buffer.byteLength(url, 'utf8');
    facets.push({
      index: { byteStart, byteEnd },
      features: [{ $type: 'app.bsky.richtext.facet#link', uri: url }],
    });
  }
  console.log(`🔗 ${facets.length} URL détectée(s), facets ajoutés`);

  // ── 4. Créer le post ───────────────────────────────────────────────────────
  console.log('📝 Création du post…');
  const record = {
    $type:     'app.bsky.feed.post',
    text:      tweetText,
    createdAt: new Date().toISOString(),
    embed: {
      $type:  'app.bsky.embed.images',
      images: [{
        alt:   'Visuel électoral — La Rochelle Vote',
        image: blob,
      }],
    },
  };
  if (facets.length) record.facets = facets;

  const createRes = await fetchWithRetry(`${PDS}/xrpc/com.atproto.repo.createRecord`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessJwt}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      repo:       did,
      collection: 'app.bsky.feed.post',
      record,
    }),
  });
  if (!createRes.ok) {
    console.error(`❌ Création du post échouée : ${createRes.status} ${createRes.statusText}`);
    console.error(await createRes.text());
    process.exit(1);
  }
  const result = await createRes.json();
  // Construire l'URL web humanisée
  const rkey   = result.uri.split('/').pop();
  const webUrl = `https://bsky.app/profile/${session.handle}/post/${rkey}`;
  console.log(`✅ Posté sur Bluesky : ${webUrl}`);
})();
