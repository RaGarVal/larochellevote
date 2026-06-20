/**
 * daily-capture.js — LaRochelleVote
 * ─────────────────────────────────────────────────────────────────────────────
 * Chaque matin GitHub Actions exécute ce script qui :
 *   1. Vérifie si aujourd'hui est un rendez-vous fixé dans schedule.json.
 *      Sinon, auto-détecte un anniversaire en croisant la date du jour avec
 *      la table DATES (52 dates calendaires distinctes ; en cas de collision,
 *      tirage aléatoire uniforme parmi les scrutins du même jour).
 *   2. Sinon, choisit aléatoirement un type de contenu et une élection
 *   3. Ouvre le site, extrait les données réelles
 *   4. Génère le texte du tweet (12 canevas + cascade si > 280 chars).
 *      Si rdv (explicite OU auto-détecté) : on bascule sur la variante
 *      anniversaire (« 🎂 Il y a N ans aujourd'hui, pour la {election}, X
 *      obtenait/arrivait en tête… »).
 *   5. Capture l'image et sauvegarde le tout dans daily-tweet/
 *
 * Cascade de repli automatique si le texte dépasse 280 caractères, à 2 étages :
 *
 *   Étage 1 — Troncatures progressives à chaque niveau :
 *     Étape 1 → texte complet
 *     Étape 2 → CTA raccourcie ("Détails sur {url}")
 *     Étape 3 → suffixe " à {quartier}" retiré (bureau + carte uniquement)
 *     Étape 4 → prénom → initiale (Marielle → M., Marie-Hélène → MH.)
 *
 *   Étage 2 — Si l'étape 4 dépasse encore 280, repli vers le niveau plus large :
 *     carte    → global (même image)
 *     bureau   → quartier → global (même image)
 *     quartier → global   (même image)
 *     canton   → global   (même image)
 *     global   → toujours dans les limites
 * ─────────────────────────────────────────────────────────────────────────────
 */

const puppeteer = require('puppeteer');
const fs        = require('fs');
const path      = require('path');

// ══ CONFIGURATION ════════════════════════════════════════════════════════════

// BASE_URL : où charger le site pour la capture.
// - En PROD (GitHub Actions), on utilise le domaine custom larochellevote.fr.
// - En LOCAL (test sur ton Mac), on utilise file:// pour tester ta version locale.
//   Pour basculer en mode local : LOCAL=1 node daily-capture.js
const BASE_URL = process.env.LOCAL === '1'
  ? 'file://' + __dirname + '/'
  : 'https://larochellevote.fr/';
const SITE_URL = 'https://larochellevote.fr'; // URL publique citée dans les tweets (compté 23 chars par Twitter)
const CHAPEAU  = '📊 La Rochelle Vote — La donnée du jour';

// Probabilités cibles du tirage (doivent sommer à 1).
// Ce sont les proportions visées sur la fenêtre de COOLDOWN_DAYS — les vraies
// probabilités utilisées à chaque tirage sont ajustées dynamiquement par
// rebalanceProba() pour corriger les déséquilibres récents.
const PROBA = {
  carte:    0.40,
  bureau:   0.40,
  quartier: 0.10,
  canton:   0.05,
  global:   0.05,
};

// Sous-tirage au sein du niveau "carte" :
//   gagnants → carte mosaïque classique, sujet = gagnant ville
//   candidat → carte heatmap d'un seul candidat (tiré pondéré par son score ville)
const SUB_CARTE = {
  gagnants: 0.25,
  candidat: 0.75,
};

// ── Cibles MANUELLES par scrutin ──────────────────────────────────────────────
// Override de la pondération dynamique (qui suivrait sinon le nombre de tours x élections).
// Rationnel : on sous-représente volontairement les cantonales/départementales (5 %) car
// elles sont infra-communales et moins lisibles, et on rééquilibre les autres scrutins
// pour donner aux européennes et municipales une place plus juste qu'au prorata des tours.
//
// ⚠ À AJUSTER quand un nouveau type de scrutin est ajouté, ou quand des élections
// supplémentaires sont saisies — la somme doit rester à 100 %.
const SCRUTIN_TARGETS = {
  legislatives:    0.25,
  presidentielle:  0.18,
  europeennes:     0.17,
  municipales:     0.16,
  regionales:      0.15,
  departementales: 0.05,  // inclut Cantonales (electionScrutin() les groupe)
  referendum:      0.04,
};

// Cooldown anti-doublons (en jours) : une combinaison niveau/élection/tour/bureau/quartier
// déjà publiée dans cette fenêtre est exclue du tirage aléatoire.
// La même fenêtre sert au rééquilibrage auto-correctif des proba (axes niveau, scrutin, sub-carte).
// L'historique est stocké dans daily-tweet/history.json (versionné).
const COOLDOWN_DAYS = 90;

// ══ LES 12 CANEVAS ═══════════════════════════════════════════════════════════

const C = {

  // ── CARTE ──────────────────────────────────────────────────────────────────
  // Vue carte complète. Texte : gagnant ville + meilleur bureau.

  carte_presidentielle:
`${CHAPEAU}

{emoji} Le {date_election}, pour la {election} {tour}, {prenom_nom} ({parti}) a obtenu {score} % à La Rochelle. 📍 Meilleur score dans le bureau n°{bureau_num} · {denomination} à {quartier}.

Les résultats de ce scrutin, bureau par bureau, sur {site_url}`,

  carte_referendum:
`${CHAPEAU}

{emoji} Le {date_election}, pour le {election}, le {reponse} a obtenu {score} % à La Rochelle. 📍 Meilleur score dans le bureau n°{bureau_num} · {denomination} à {quartier}.

Les résultats de ce scrutin, bureau par bureau, sur {site_url}`,

  carte_autres:
`${CHAPEAU}

{emoji} Le {date_election}, pour les {election} {tour}, {prenom_nom} ({parti}) a obtenu {score} % à La Rochelle. 📍 Meilleur score dans le bureau n°{bureau_num} · {denomination} à {quartier}.

Les résultats de ce scrutin, bureau par bureau, sur {site_url}`,

  // ── FICHE BUREAU ───────────────────────────────────────────────────────────
  // Vue panneau d'un bureau. Texte : gagnant dans ce bureau.

  bureau_presidentielle:
`${CHAPEAU}

{emoji} Le {date_election}, pour la {election} {tour}, {prenom_nom} ({parti}) arrive en tête avec {score} % dans le bureau n°{bureau_num} · {denomination} à {quartier}.

Les résultats de ce bureau, et tous les autres, sur {site_url}`,

  bureau_referendum:
`${CHAPEAU}

{emoji} Le {date_election}, pour le {election}, le {reponse} est arrivé en tête avec {score} % dans le bureau n°{bureau_num} · {denomination} à {quartier}.

Les résultats de ce bureau, et tous les autres, sur {site_url}`,

  bureau_autres:
`${CHAPEAU}

{emoji} Le {date_election}, pour les {election} {tour}, {prenom_nom} ({parti}) arrive en tête avec {score} % dans le bureau n°{bureau_num} · {denomination} à {quartier}.

Les résultats de ce bureau, et tous les autres, sur {site_url}`,

  // ── FICHE QUARTIER ─────────────────────────────────────────────────────────
  // Vue panneau d'un quartier. Texte : gagnant dans ce quartier.

  quartier_presidentielle:
`${CHAPEAU}

{emoji} Le {date_election}, pour la {election} {tour}, {prenom_nom} ({parti}) arrive en tête avec {score} % dans le quartier de {quartier}.

Les résultats de ce quartier, et tous les autres, sur {site_url}`,

  quartier_referendum:
`${CHAPEAU}

{emoji} Le {date_election}, pour le {election}, le {reponse} est arrivé en tête avec {score} % dans le quartier de {quartier}.

Les résultats de ce quartier, et tous les autres, sur {site_url}`,

  quartier_autres:
`${CHAPEAU}

{emoji} Le {date_election}, pour les {election} {tour}, {prenom_nom} ({parti}) arrive en tête avec {score} % dans le quartier de {quartier}.

Les résultats de ce quartier, et tous les autres, sur {site_url}`,

  // ── FICHE CANTON ───────────────────────────────────────────────────────────
  // Vue panneau d'un canton moderne (2015→). Texte : gagnant dans ce canton.

  canton_presidentielle:
`${CHAPEAU}

{emoji} Le {date_election}, pour la {election} {tour}, {prenom_nom} ({parti}) arrive en tête avec {score} % dans le canton de {canton_nom}.

Les résultats de ce canton, et tous les autres, sur {site_url}`,

  canton_referendum:
`${CHAPEAU}

{emoji} Le {date_election}, pour le {election}, le {reponse} est arrivé en tête avec {score} % dans le canton de {canton_nom}.

Les résultats de ce canton, et tous les autres, sur {site_url}`,

  canton_autres:
`${CHAPEAU}

{emoji} Le {date_election}, pour les {election} {tour}, {prenom_nom} ({parti}) arrive en tête avec {score} % dans le canton de {canton_nom}.

Les résultats de ce canton, et tous les autres, sur {site_url}`,

  // ── FICHE GLOBAL ───────────────────────────────────────────────────────────
  // Vue résultats ville entière. Texte : gagnant à La Rochelle.

  global_presidentielle:
`${CHAPEAU}

{emoji} Le {date_election}, pour la {election} {tour}, {prenom_nom} ({parti}) arrive en tête avec {score} % à La Rochelle.

Les résultats de ce scrutin, et tous les autres, sur {site_url}`,

  global_referendum:
`${CHAPEAU}

{emoji} Le {date_election}, pour le {election}, le {reponse} est arrivé en tête avec {score} % à La Rochelle.

Les résultats de ce scrutin, et tous les autres, sur {site_url}`,

  global_autres:
`${CHAPEAU}

{emoji} Le {date_election}, pour les {election} {tour}, {prenom_nom} ({parti}) arrive en tête avec {score} % à La Rochelle.

Les résultats de ce scrutin, et tous les autres, sur {site_url}`,
};

// Ordre de repli si > 280 chars (du plus spécifique au plus court)
const FALLBACK = {
  carte:    ['carte', 'global'],
  bureau:   ['bureau', 'quartier', 'global'],
  quartier: ['quartier', 'global'],
  canton:   ['canton', 'global'],
  global:   ['global'],
};

// ══ TABLE DES DATES D'ÉLECTIONS ══════════════════════════════════════════════
// Importée depuis dates.js (single source of truth, partagée avec build-scrutins).
// Audit medium #22 : avant cet extract, 2 copies divergentes (2 pages scrutin
// se retrouvaient sans date côté build-scrutins).
const { DATES } = require('./dates.js');


// ══ UTILITAIRES ══════════════════════════════════════════════════════════════

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickWeighted(proba) {
  const r = Math.random();
  let sum = 0;
  for (const [key, p] of Object.entries(proba)) {
    sum += p;
    if (r < sum) return key;
  }
  return Object.keys(proba).pop();
}

// Tirage pondéré dans un tableau d'objets {key, weight}. Renvoie la key.
function pickWeightedFromList(items) {
  const total = items.reduce((s, it) => s + Math.max(0, it.weight || 0), 0);
  if (total <= 0) return items[Math.floor(Math.random() * items.length)]?.key;
  let r = Math.random() * total;
  for (const it of items) {
    r -= Math.max(0, it.weight || 0);
    if (r <= 0) return it.key;
  }
  return items[items.length - 1].key;
}

// ── Rééquilibrage auto-correctif ────────────────────────────────────────────
// Formule : poids[k] = max(epsilon, 2 × cible[k] − proportion_actuelle[k])
// Effets :
//   • si proportion_actuelle == cible → poids = cible (tirage cible)
//   • si proportion_actuelle == 0     → poids = 2 × cible (chances doublées)
//   • si proportion_actuelle ≥ 2×cible → poids ≈ epsilon (gel quasi-total)
// On retourne un objet probabilités normalisées (somme = 1).
// Cold start : si totalCount < minCount, on renvoie la cible brute sans correction.
function rebalanceProba(target, counts, opts = {}) {
  const minCount = opts.minCount ?? 10;
  const epsilon  = opts.epsilon  ?? 0.01;
  const totalCount = Object.values(counts).reduce((s, v) => s + (v || 0), 0);
  if (totalCount < minCount) {
    // Renvoyer la cible normalisée telle quelle (au cas où elle ne somme pas exactement à 1)
    const s = Object.values(target).reduce((a, b) => a + b, 0) || 1;
    const out = {};
    Object.keys(target).forEach(k => out[k] = target[k] / s);
    return out;
  }
  const weights = {};
  Object.keys(target).forEach(k => {
    const actualProp = (counts[k] || 0) / totalCount;
    weights[k] = Math.max(epsilon, 2 * target[k] - actualProp);
  });
  const sum = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
  Object.keys(weights).forEach(k => weights[k] /= sum);
  return weights;
}

// Compte les entrées d'history dans la fenêtre [today − days, today] selon une fonction de clé.
function countByKey(history, today, days, keyFn) {
  const cutoffMs = new Date(today + 'T00:00:00Z').getTime() - days * 86400 * 1000;
  const counts = {};
  (history || []).forEach(e => {
    if (!e?.date) return;
    if (new Date(e.date + 'T00:00:00Z').getTime() < cutoffMs) return;
    const k = keyFn(e);
    if (k) counts[k] = (counts[k] || 0) + 1;
  });
  return counts;
}

// Détermine le sous-type carte d'une entrée d'historique (gagnants/candidat).
// La signature carte_candidat contient "|cand:" — gagnants ne l'a pas.
function subtypeOfHistoryEntry(e) {
  if (e?.niveau !== 'carte') return null;
  if (e?.subtype) return e.subtype;
  return (e?.signature || '').includes('|cand:') ? 'candidat' : 'gagnants';
}

function fillCaneva(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] !== undefined ? vars[k] : '');
}

function formatPct(val) {
  return (Math.round(Number(val) * 10) / 10).toFixed(1).replace('.', ',');
}

// Twitter compte les URLs https:// comme 23 chars (t.co)
function twitterLen(text) {
  return text.replace(/https?:\/\/\S+/g, '_'.repeat(23)).length;
}

// "Présidentielle 2022" → "présidentielle"
function formatElectionLabel(label) {
  return label.replace(/\s+\d{4}$/, '').replace(/^./, c => c.toLowerCase());
}

function electionSuffix(label) {
  if (/présidentielle/i.test(label)) return 'presidentielle';
  if (/référendum/i.test(label))     return 'referendum';
  return 'autres';
}

// Type de scrutin canonique (axe utilisé par le rééquilibrage auto-correctif).
// 7 catégories distinctes, indépendamment de l'année.
function electionScrutin(label) {
  if (/présidentielle/i.test(label))             return 'presidentielle';
  if (/référendum/i.test(label))                 return 'referendum';
  if (/législative/i.test(label))                return 'legislatives';
  if (/municipale/i.test(label))                 return 'municipales';
  // "Départementales" / "Cantonales" (+ singulier pour les partielles) :
  // avant "regionales" pour ne pas que le match "régionale" remonte sur
  // "départementales régionale" par accident.
  if (/^(d[ée]partementale[s]?|cantonale[s]?)/i.test(label)) return 'departementales';
  if (/régionale/i.test(label))                  return 'regionales';
  if (/européenne/i.test(label))                 return 'europeennes';
  return 'autres';
}

function electionEmoji(label) {
  if (/présidentielle/i.test(label))                   return '👤';
  if (/référendum/i.test(label))                       return '🗳️';
  if (/législative/i.test(label))                      return '🏛️';
  if (/^(d[ée]partementale[s]?|cantonale[s]?)/i.test(label)) return '🧩';
  if (/municipale|régionale/i.test(label))             return '🏙️';
  if (/européenne/i.test(label))                       return '🇪🇺';
  return '🗳️';
}

function tourLabel(tour) {
  if (!tour || tour === 'TU') return '';
  if (tour === 'T1') return '(1er tour)';
  if (tour === 'T2') return '(2e tour)';
  return `(${tour})`;
}

// Cascade de troncature interne (étapes 1→4) appliquée AVANT de cascader vers
// un niveau plus large (FALLBACK). Initialise le prénom à l'étape 4.
//   Marielle      → M.
//   Marie-Hélène  → MH.
//   Jean-Luc      → JL.
//   ''            → '' (no-op pour binômes ou identités vides)
function initializePrenom(p) {
  if (!p) return '';
  if (p.includes('-')) return p.split('-').map(s => s.charAt(0)).join('') + '.';
  return p.charAt(0) + '.';
}

// ── Anniversaires (rdv schedule.json) ───────────────────────────────────────
// Quand le jour correspond à un rdv dans schedule.json, on transforme le
// template "Le {date_election}, pour la {election}" en "Il y a N ans
// aujourd'hui, pour la {election_anniv}" (avec verbes à l'imparfait).
// Style validé par le user : sobre, descriptif, factuel.

// "Présidentielle 2022" → "présidentielle 2022" (vs formatElectionLabel qui
// retire l'année — pour les anniv on la garde car la date n'est plus dans le texte).
function formatElectionLabelFull(label) {
  return label.replace(/^./, c => c.toLowerCase());
}

// Nombre d'années entre aujourd'hui et l'élection. Calcul simple année - année
// (les rdv tombent par construction le bon mois/jour, donc pas de subtilité).
function anniversaryYears(electionLabel, todayStr) {
  const m = electionLabel.match(/\b(\d{4})\b/);
  if (!m) return null;
  return parseInt(todayStr.slice(0, 4)) - parseInt(m[1]);
}

// "il y a un an" (N=1) ou "il y a 4 ans" (N≥2). N=0 et N<0 sont impossibles
// par construction des rdv (on ne commémore pas le futur ni l'année courante).
function anniversaryPhrase(n) {
  return n === 1 ? 'un an' : `${n} ans`;
}

// Transforme un template "normal" en variante anniversaire :
//   - En-tête : "{emoji} Le {date_election}, pour la/le/les {election}" devient
//     "🎂 Il y a {anniv_phrase} aujourd'hui, pour la/le/les {election_anniv}"
//     (le tour optionnel après {election} est préservé : "(1er tour)" reste).
//   - Verbes : présent / passé composé → imparfait (cohérent avec la posture
//     commémorative "il y a N ans, X obtenait/arrivait en tête").
function applyAnniversaryTemplate(tpl) {
  return tpl
    .replace(/\{emoji\} Le \{date_election\}, pour (la|le|les) \{election\}( \{tour\})?/,
             "🎂 Il y a {anniv_phrase} aujourd'hui, pour $1 {election_anniv}$2")
    // Ordre : "est arrivé" avant "arrive" pour ne pas casser les référendums bureau.
    .replace(/est arrivé en tête/g, 'arrivait en tête')
    .replace(/arrive en tête/g, 'arrivait en tête')
    .replace(/a obtenu/g, 'obtenait');
}

function getDate(electionLabel, tour) {
  const entry = DATES[electionLabel];
  if (!entry) return null;
  return entry[tour] || entry.TU || entry.T1 || Object.values(entry)[0];
}

// ── Historique anti-doublons ────────────────────────────────────────────────
// Construit la signature unique d'un tweet selon sa combinaison niveau/élection/tour/...
// Les valeurs nulles sont normalisées pour que la signature reste comparable
// d'un run à l'autre (par ex. tour='TU' pour les scrutins à tour unique).
// Pour le niveau 'carte', subCarte ∈ {'gagnants', 'candidat'} permet de distinguer
// la carte mosaïque classique de la carte heatmap d'un candidat précis (suffixé "|cand:<nom>").
function computeSignature(niveau, election, tour, bureau, quartier, subCarte, candidatName, canton) {
  // Note historique : un `.split(' ')[0]` était posé ici pour gérer un suffixe
  // "(forcé)" qui n'est plus appliqué côté caller. Retiré en audit low #9.
  const niv = String(niveau || 'global');
  if (niv === 'bureau'   && bureau)   return `bureau|${election}|${tour}|${bureau}`;
  if (niv === 'quartier' && quartier) return `quartier|${election}|${tour}|${quartier}`;
  if (niv === 'canton'   && canton)   return `canton|${election}|${tour}|${canton}`;
  if (niv === 'carte') {
    if (subCarte === 'candidat' && candidatName) return `carte|${election}|${tour}|cand:${candidatName}`;
    return `carte|${election}|${tour}`;
  }
  return `global|${election}|${tour}`;
}

// Charge history.json et retourne l'ensemble des signatures publiées dans la
// fenêtre de cooldown. Le fichier peut ne pas exister (premier run), auquel
// cas on retourne un Set vide.
function loadBannedSignatures(todayStr) {
  const histPath = path.join(__dirname, 'daily-tweet', 'history.json');
  if (!fs.existsSync(histPath)) return { banned: new Set(), history: [] };
  let history;
  try { history = JSON.parse(fs.readFileSync(histPath, 'utf8')); }
  catch { return { banned: new Set(), history: [] }; }
  if (!Array.isArray(history)) return { banned: new Set(), history: [] };

  const today    = new Date(todayStr + 'T00:00:00Z');
  const cutoffMs = today.getTime() - COOLDOWN_DAYS * 86400 * 1000;
  const banned   = new Set();
  history.forEach(e => {
    if (!e.date || !e.signature) return;
    const d = new Date(e.date + 'T00:00:00Z');
    if (d.getTime() >= cutoffMs) banned.add(e.signature);
  });
  return { banned, history };
}

// ══ PROGRAMME ÉDITORIAL ══════════════════════════════════════════════════════

const today = (process.env.TWEET_DATE || new Date().toISOString().split('T')[0]).trim();
console.log(`\n📅 Date : ${today}`);

const schedulePath = path.join(__dirname, 'schedule.json');
const schedule     = fs.existsSync(schedulePath)
  ? JSON.parse(fs.readFileSync(schedulePath, 'utf8')).filter(e => e.date)
  : [];

// 1. RDV explicite dans schedule.json → priorité absolue (curation manuelle)
// 2. Sinon : auto-détection d'anniversaire en croisant today (JJ mois) avec
//    la table DATES. Si plusieurs scrutins même jour calendaire, tirage uniforme.
//    Les anniversaires de l'ANNÉE COURANTE sont exclus (pas de "il y a 0 an").
const MOIS_FR = ['janvier','février','mars','avril','mai','juin','juillet',
                 'août','septembre','octobre','novembre','décembre'];
function findAnniversaryFromDates(todayStr) {
  const [yearStr, monthStr, dayStr] = todayStr.split('-');
  const todayMD = `${parseInt(dayStr)} ${MOIS_FR[parseInt(monthStr) - 1]}`;
  const todayYear = parseInt(yearStr);
  const matches = [];
  for (const [label, tours] of Object.entries(DATES)) {
    for (const [tour, dateStr] of Object.entries(tours)) {
      // Regex tolérante au "1er" (ex. "1er mai 2023") : normalise sur "1 mai 2023".
      // Sans ça, les anniversaires des dates en 1er étaient silencieusement ignorés
      // (audit medium #17).
      const m = dateStr.match(/^(\d{1,2})(?:er)?\s+(\S+)\s+(\d{4})$/);
      if (!m) continue;
      const md = `${parseInt(m[1])} ${m[2]}`;
      if (md === todayMD && parseInt(m[3]) < todayYear) {
        matches.push({ election: label, tour });
      }
    }
  }
  if (!matches.length) return null;
  return matches[Math.floor(Math.random() * matches.length)];
}

let rdv = schedule.find(e => e.date === today) || null;
if (!rdv) {
  const autoAnniv = findAnniversaryFromDates(today);
  if (autoAnniv) {
    // RDV synthétique : pas de `type` ni `bureau/quartier/canton` → niveau et
    // unité géo restent tirés aléatoirement. Seuls `election` et `tour` sont forcés.
    rdv = { ...autoAnniv, auto: true };
  }
}
console.log(rdv
  ? (rdv.auto
       ? `🎂 Anniversaire auto-détecté : ${rdv.election} ${rdv.tour}`
       : `📌 Rendez-vous : ${rdv.note || rdv.election}`)
  : '🎲 Sélection aléatoire');

// ══ LANCEMENT ════════════════════════════════════════════════════════════════

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--lang=fr-FR'],
  });
  // try/finally garantit la fermeture du browser même en cas d'exception, sinon
  // process Chromium zombie en CI. browser.close() est idempotent (les 4 close
  // explicites internes peuvent rester) — le finally agit en filet de sécurité.
  try {

  const page = await browser.newPage();

  // Supprimer la visite guidée avant le chargement de la page
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('lrvote_tour_carte_v2_seen', '1');
  });

  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });

  // ── Interception des tuiles CARTO/OSM AVANT le 1er goto ────────────────────
  // La 1re navigation (LRVcarte.html, networkidle0) attendait jusqu'à 40s en
  // CI tant que les tuiles n'étaient pas chargées — on n'en a aucun besoin pour
  // l'extraction des données JS. On répond immédiatement avec un PNG transparent
  // 1×1 pour que networkidle0 résolve instantanément. L'interception reste
  // active pour le rendu d'export plus tard (même page).
  const BLANK_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ' +
    'AAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  await page.setRequestInterception(true);
  page.on('request', req => {
    if (/cartocdn\.com|openstreetmap\.org/i.test(req.url())) {
      req.respond({ status: 200, contentType: 'image/png', body: BLANK_PNG });
    } else {
      req.continue();
    }
  });

  // ── 1. Charger le site pour accéder aux données JS ────────────────────────
  console.log('⏳ Chargement du site…');
  try {
    await page.goto(BASE_URL + 'LRVcarte.html', { waitUntil: 'networkidle0', timeout: 40000 });
  } catch { /* timeout toléré */ }

  // Attendre que les données JS soient réellement disponibles (donnees.js peut être long à parser)
  console.log('⏳ Attente des données JS…');
  try {
    await page.waitForFunction(
      () => ELECTIONS && Object.keys(ELECTIONS).length > 0,
      { timeout: 30000 }
    );
  } catch {
    console.error('❌ Les données ELECTIONS ne sont pas disponibles après 30s. Abandon.');
    await browser.close(); process.exit(1);
  }

  // ── 2. Extraire la liste des élections, bureaux et quartiers ──────────────
  // On extrait BUREAU_INFO pour TOUTES les ères (pas seulement 2026) pour que la
  // dénomination/quartier d'un bureau corresponde bien à l'année de l'élection
  // tirée (ex. Municipales 1995 → nom du bureau en 1995, pas en 2026).
  const siteData = await page.evaluate(() => {
    // On exclut les scrutins marqués `draft: true` du tirage : ils restent
    // accessibles via deeplink mais ne peuvent pas être sélectionnés par le
    // robot tant que le flag n'est pas retiré.
    const elections = Object.keys(ELECTIONS || {}).filter(l => !(ELECTIONS[l] && ELECTIONS[l].draft === true));

    // map : election → era (year of the découpage utilisé pour cette élection)
    const electionEra = {};
    elections.forEach(el => {
      electionEra[el] = String(ELECTIONS[el]?.my || '2026');
    });

    // map : election → liste des tours disponibles (['T1','T2'] ou ['TU'])
    // Sert au calcul des cibles dynamiques par type de scrutin (option B :
    // proportionnel au nombre d'instances election × tour dans la base).
    const electionTours = {};
    elections.forEach(el => {
      electionTours[el] = Object.keys(ELECTIONS[el]?.sheets || {});
    });

    const bureauxParElection = {};
    elections.forEach(el => {
      const sheets = ELECTIONS[el]?.sheets || {};
      const sheet  = sheets.T1 || sheets.TU || sheets[Object.keys(sheets)[0]];
      if (sheet) {
        bureauxParElection[el] = Object.keys(sheet).filter(num => {
          const bd = sheet[num];
          return bd && bd.c && Object.keys(bd.c).length > 0;
        });
      }
    });

    // Infos bureaux par ère : { era: { num: {denomination, quartier} } }
    const bureauxByEra = {};
    const quartiersByEra = {}; // { era: { quartierNom: [num, ...] } }
    Object.keys(BUREAU_INFO || {}).forEach(era => {
      const bi = BUREAU_INFO[era] || {};
      bureauxByEra[era] = {};
      quartiersByEra[era] = {};
      Object.entries(bi).forEach(([num, b]) => {
        if (b && b.q !== 'Nul') {
          bureauxByEra[era][num] = { denomination: b.den || b.nom || `Bureau ${num}`, quartier: b.q || '' };
          const q = b.q || '';
          if (q) {
            if (!quartiersByEra[era][q]) quartiersByEra[era][q] = [];
            quartiersByEra[era][q].push(num);
          }
        }
      });
    });

    // Cantons modernes (ère 2015 uniquement pour les tweets) — 3 cantons.
    // On ne tire pas sur les anciens cantons (1985:N) : trop techniques pour un tweet public.
    const cantonsModernes = {}; // { cid: name }
    if (typeof CANTON_INFO !== 'undefined' && CANTON_INFO['2015']) {
      Object.entries(CANTON_INFO['2015'].cantons || {}).forEach(([cid, meta]) => {
        cantonsModernes[cid] = meta.name || ('La Rochelle-' + cid);
      });
    }

    return { elections, electionEra, electionTours, bureauxParElection, bureauxByEra, quartiersByEra, cantonsModernes };
  });

  const { elections, electionEra, electionTours, bureauxParElection, bureauxByEra, quartiersByEra, cantonsModernes } = siteData;

  // ── 2bis. Cibles MANUELLES par type de scrutin (cf. const SCRUTIN_TARGETS) ─
  // Pondération choisie volontairement (cf. commentaire en tête de fichier).
  // On filtre les scrutins absents du stock (defensive — si une cible est définie
  // pour un scrutin sans données, elle est ignorée et la somme renormalisée).
  const scrutinTargets = (() => {
    const availableScrutins = new Set();
    elections.forEach(el => {
      if (!(bureauxParElection[el] || []).length) return;
      availableScrutins.add(electionScrutin(el));
    });
    const out = {};
    let totalKept = 0;
    Object.entries(SCRUTIN_TARGETS).forEach(([s, w]) => {
      if (availableScrutins.has(s)) { out[s] = w; totalKept += w; }
    });
    // Renormalise pour que la somme = 1 (au cas où des scrutins manquent).
    if (totalKept > 0 && Math.abs(totalKept - 1) > 0.001) {
      Object.keys(out).forEach(k => out[k] /= totalKept);
    }
    return out;
  })();
  console.log(`🎯 Cibles scrutin (manuelles) :`, Object.fromEntries(
    Object.entries(scrutinTargets).map(([k, v]) => [k, (v * 100).toFixed(1) + '%'])
  ));
  // Pour les besoins du tirage aléatoire d'un quartier (qui doit exister pour l'élection
  // tirée), on consultera les quartiersByEra à la volée. Pour l'affichage du count log,
  // on utilise l'ère 2026 comme référence.
  const bureauxInfo2026 = bureauxByEra['2026'] || {};
  const quartiers2026 = Object.keys(quartiersByEra['2026'] || {});
  console.log(`📊 ${elections.length} élections, ${Object.keys(bureauxInfo2026).length} bureaux (2026), ${quartiers2026.length} quartiers (2026)`);

  // ── 3. Choisir le contenu du jour ─────────────────────────────────────────
  // Env vars de debug : NIVEAU=, ELECTION=, TOUR=, BUREAU=, QUARTIER= forcent un cas précis.
  // Les forçages (env + rdv) sont stables entre les essais ; le reste est re-tiré
  // si la signature obtenue est encore dans la fenêtre de cooldown.
  const forcedNiveau   = process.env.NIVEAU   || rdv?.type     || null;
  const forcedElection = process.env.ELECTION || rdv?.election || null;
  const forcedTour     = process.env.TOUR     || rdv?.tour     || null;
  const forcedBureau   = process.env.BUREAU   || rdv?.bureau   || null;
  const forcedQuartier = process.env.QUARTIER || rdv?.quartier || null;
  const forcedCanton   = process.env.CANTON   || rdv?.canton   || null;

  // Charge l'historique et calcule l'ensemble des signatures interdites (≤ COOLDOWN_DAYS jours).
  const { banned: bannedSignatures, history: tweetHistory } = loadBannedSignatures(today);
  console.log(`🚫 Cooldown ${COOLDOWN_DAYS}j → ${bannedSignatures.size} signatures interdites`);

  // Rééquilibrage auto-correctif : on calcule les probas effectives à partir de la cible
  // et de la proportion réelle observée dans les COOLDOWN_DAYS derniers jours.
  const niveauCounts = countByKey(tweetHistory, today, COOLDOWN_DAYS, e => e.niveau);
  const niveauProba  = rebalanceProba(PROBA, niveauCounts);

  const scrutinCounts = countByKey(tweetHistory, today, COOLDOWN_DAYS, e => electionScrutin(e.election));
  const scrutinProba  = rebalanceProba(scrutinTargets, scrutinCounts);

  const subCarteCounts = countByKey(tweetHistory, today, COOLDOWN_DAYS, subtypeOfHistoryEntry);
  const subCarteProba  = rebalanceProba(SUB_CARTE, subCarteCounts);

  console.log(`⚖️  Niveau   (cible → effectif) :`, Object.fromEntries(
    Object.entries(niveauProba).map(([k, v]) => [k, (v * 100).toFixed(1) + '%'])
  ));
  console.log(`⚖️  Scrutin  (cible → effectif) :`, Object.fromEntries(
    Object.entries(scrutinProba).map(([k, v]) => [k, (v * 100).toFixed(1) + '%'])
  ));
  console.log(`⚖️  SubCarte (cible → effectif) :`, Object.fromEntries(
    Object.entries(subCarteProba).map(([k, v]) => [k, (v * 100).toFixed(1) + '%'])
  ));

  let niveau, election, tour, bureau, quartier, canton, subCarte, candidatPicked;
  let era, bureauxInfoEra, quartiersBureauxEra, quartiersEra;
  let signature;
  const MAX_RETRIES = 30;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    // ── Étape 1 : niveau (rééquilibré)
    niveau = forcedNiveau || pickWeighted(niveauProba);

    // ── Étape 2 : élection (via tirage du scrutin rééquilibré, puis uniforme dans le scrutin)
    if (forcedElection) {
      election = forcedElection;
    } else {
      // Filtrer les scrutins qui ont au moins une élection disponible (defensive).
      // Cas particulier : aux niveaux 'global' (totalisation ville) et 'quartier'
      // (un quartier peut chevaucher plusieurs cantons), les Cantonales/Départementales
      // n'ont pas de résultat cohérent — un seul canton vote à la fois. On les exclut.
      // electionScrutin() retourne 'departementales' aussi bien pour les Cantonales que
      // pour les Départementales (regroupement historique).
      const skipDepartementales = (niveau === 'global' || niveau === 'quartier');
      const availableScrutins = Object.keys(scrutinProba).filter(s => {
        if (skipDepartementales && s === 'departementales') return false;
        return elections.some(el => electionScrutin(el) === s && (bureauxParElection[el] || []).length > 0);
      });
      const proba = {};
      availableScrutins.forEach(s => proba[s] = scrutinProba[s] || 0);
      const chosenScrutin = pickWeighted(proba);
      const electionsOfScrutin = elections.filter(el =>
        electionScrutin(el) === chosenScrutin && (bureauxParElection[el] || []).length > 0
      );
      election = pickRandom(electionsOfScrutin);
    }

    tour     = forcedTour;
    bureau   = forcedBureau;
    quartier = forcedQuartier;
    canton   = forcedCanton;

    // Normaliser 'fiche' (alias dans schedule.json) → bureau/quartier/canton/global selon les params
    if (niveau === 'fiche') {
      if (bureau)        niveau = 'bureau';
      else if (quartier) niveau = 'quartier';
      else if (canton)   niveau = 'canton';
      else               niveau = pickWeighted({ bureau: 0.6, quartier: 0.25, canton: 0.10, global: 0.05 });
    }

    // Déterminer le tour
    if (!tour) {
      const availTours = electionTours[election] || [];
      tour = availTours.includes('T1') ? 'T1' : availTours.includes('TU') ? 'TU' : availTours[0];
    }

    // L'ère du découpage utilisé pour cette élection (1988, 1995, ..., 2026)
    era = electionEra[election] || '2026';
    bureauxInfoEra = bureauxByEra[era] || {};
    quartiersBureauxEra = quartiersByEra[era] || {};
    quartiersEra = Object.keys(quartiersBureauxEra);

    // Sélections aléatoires selon le niveau (en se basant sur l'ère de l'élection)
    if (niveau === 'bureau' && !bureau) {
      const candidats = (bureauxParElection[election] || []).filter(n => bureauxInfoEra[n]);
      bureau = pickRandom(candidats);
      // Si on a bien tiré un bureau, déduire son quartier pour que le fallback
      // bureau→quartier (FALLBACK[bureau]) dans la cascade puisse en faire usage —
      // sans ça, l'étape quartier était toujours skip (audit medium #18).
      if (bureau && !quartier) {
        quartier = bureauxInfoEra[bureau]?.quartier || null;
      }
    }
    // niveau='bureau' avec !bureau est désormais inaccessible : la branche au-dessus
    // a soit tiré un bureau (et son quartier), soit pas (et alors pickRandom retourne
    // undefined → on serait bloqué de toute façon). On simplifie (audit low #8).
    if (niveau === 'quartier' && !quartier) {
      quartier = pickRandom(quartiersEra);
    }
    // Canton : on tire uniquement parmi les cantons modernes (3 cantons ère 2015).
    // Ces 3 cantons s'appliquent à toutes les élections (rétro-agrégées via
    // CANTON_CORRESPONDANCES pour les élections antérieures à 2015).
    if (niveau === 'canton' && !canton) {
      const availableCidsCanton = Object.keys(cantonsModernes || {});
      if (availableCidsCanton.length) canton = pickRandom(availableCidsCanton);
    }

    // ── Étape 3 : sous-type carte (rééquilibré) + tirage candidat pondéré si "candidat"
    subCarte = null;
    candidatPicked = null;
    if (niveau === 'carte') {
      // Référendum : pas de "carte candidat" (Oui/Non n'est pas un candidat à mettre en heatmap),
      // on retombe systématiquement sur "gagnants".
      if (electionSuffix(election) === 'referendum') {
        subCarte = 'gagnants';
      } else {
        subCarte = pickWeighted(subCarteProba);
      }

      if (subCarte === 'candidat') {
        // Récupère les scores ville pour (election, tour) et tire un candidat pondéré
        // par son score (option D). Les pseudo-candidats "Autres X listes" sont filtrés.
        const cityScores = await page.evaluate((el, tr) => {
          const sheets = ELECTIONS?.[el]?.sheets || {};
          const sheet  = sheets[tr] || sheets.TU || sheets[Object.keys(sheets)[0]];
          if (!sheet) return [];
          const nums = Object.keys(sheet).filter(n => sheet[n]?.c && Object.keys(sheet[n].c).length > 0);
          const totalExp = nums.reduce((s, n) => s + (sheet[n]?.e || 0), 0);
          const scores = {};
          nums.forEach(n => {
            const bd = sheet[n];
            if (!bd?.c || !bd.e) return;
            Object.entries(bd.c).forEach(([cand, pct]) => {
              if (/^Autres /.test(cand)) return;
              scores[cand] = (scores[cand] || 0) + (pct / 100) * bd.e;
            });
          });
          return Object.entries(scores).map(([cand, v]) => ({
            cand, pct: totalExp > 0 ? (v / totalExp) * 100 : 0
          })).sort((a, b) => b.pct - a.pct);
        }, election, tour);

        if (cityScores.length === 0) {
          // Aucun candidat exploitable → on retombe en "gagnants"
          subCarte = 'gagnants';
        } else {
          // Tirage pondéré par le score ville (un candidat à 30 % est 6× plus probable qu'un à 5 %)
          candidatPicked = pickWeightedFromList(cityScores.map(s => ({ key: s.cand, weight: s.pct })));
        }
      }
    }

    signature = computeSignature(niveau, election, tour, bureau, quartier, subCarte, candidatPicked, canton);
    if (!bannedSignatures.has(signature)) {
      if (attempt > 1) console.log(`✅ Signature libre trouvée à l'essai ${attempt}/${MAX_RETRIES}`);
      break;
    }
    console.log(`🔁 Essai ${attempt}/${MAX_RETRIES} — signature déjà publiée : ${signature}`);

    // Si tout est forcé (env vars ou rdv complet), inutile de retenter : la signature est figée.
    if (forcedNiveau && forcedElection && (forcedBureau || forcedQuartier || forcedCanton || forcedNiveau === 'global' || forcedNiveau === 'carte')) {
      console.warn(`⚠️  Combinaison entièrement forcée — on accepte la duplication.`);
      break;
    }

    if (attempt === MAX_RETRIES) {
      console.warn(`⚠️  Aucun tweet libre trouvé après ${MAX_RETRIES} essais — on accepte la duplication.`);
    }
  }

  const suffix = electionSuffix(election);
  const isRef  = suffix === 'referendum';
  console.log(`📌 Niveau : ${niveau}${subCarte ? '/' + subCarte : ''} | ${election} | Tour : ${tour} | Bureau : ${bureau||'—'} | Quartier : ${quartier||'—'} | Canton : ${canton||'—'}${candidatPicked ? ' | Candidat : ' + candidatPicked : ''}`);
  console.log(`🔖 Signature : ${signature}`);

  // ── 4. Extraire les données électorales ───────────────────────────────────
  // Note : si subjectCandidate est fourni (niveau carte_candidat), on remplace
  // cityWinner par les données de CE candidat précis, et bestBureau pointe vers
  // son meilleur bureau personnel (pas celui du gagnant ville). Le texte du tweet
  // utilise ainsi les mêmes canevas, juste avec un sujet différent.
  // Bureaux composant le canton choisi à l'ère de l'élection (pour les modernes,
  // rétro-agrégés via CANTON_CORRESPONDANCES pour les ères < 2015).
  const cantonBureaux = canton ? await page.evaluate((cid, eraB) => {
    const eraNum = parseInt(eraB);
    if (eraNum >= 2015) {
      return Object.entries(BUREAU_INFO[eraB] || {})
        .filter(([, b]) => String(b.c || '') === String(cid))
        .map(([id]) => id);
    }
    if (typeof CANTON_CORRESPONDANCES === 'undefined') return [];
    return (CANTON_CORRESPONDANCES['2015:' + cid] || {})[eraB] || [];
  }, canton, era) : null;

  const elecData = await page.evaluate((el, tr, bur, qrt, bureausDuQuartier, bureausDuCanton, isRef, subjectCandidate) => {
    const sheets = ELECTIONS?.[el]?.sheets || {};
    const sheet  = sheets[tr] || sheets.TU || sheets[Object.keys(sheets)[0]];
    if (!sheet) return null;

    // Filtre les pseudo-candidats qui n'ont pas de sens dans un tweet :
    // "Autres (X listes)" = agrégats de petites listes dans les Européennes.
    // Si l'un d'eux finit premier, le tweet aurait l'air bizarre, on le saute.
    function isPseudoCand(cand) {
      return /^Autres /.test(cand);
    }

    // Agrégation pondérée sur un ensemble de bureaux
    function aggregate(nums) {
      const totalExp = nums.reduce((s, n) => s + (sheet[n]?.e || 0), 0);
      const scores   = {};
      nums.forEach(n => {
        const bd = sheet[n];
        if (!bd?.c || !bd.e) return;
        Object.entries(bd.c).forEach(([cand, pct]) => {
          scores[cand] = (scores[cand] || 0) + (pct / 100) * bd.e;
        });
      });
      return { totalExp, ranked: Object.entries(scores)
        .filter(([cand]) => !isPseudoCand(cand))
        .map(([cand, v]) => ({ cand, pct: totalExp > 0 ? (v / totalExp) * 100 : 0 }))
        .sort((a, b) => b.pct - a.pct) };
    }

    const allNums     = Object.keys(sheet).filter(n => sheet[n]?.c && Object.keys(sheet[n].c).length > 0);
    const cityData    = aggregate(allNums);

    // cityWinner = TOUJOURS le vrai gagnant ville (utilisé par les canvas global_*).
    // Indépendant de subjectCandidate, sinon une cascade carte/candidat → global
    // afficherait "X arrive en tête à La Rochelle" pour un candidat qui n'a pas gagné.
    let cityWinner = cityData.ranked[0] || null;

    // carteSubject = sujet du canva carte_* (peut différer du gagnant ville).
    // En mode subCarte='candidat', on profile un candidat tiré pondéré par son score,
    // pas forcément le gagnant. Le texte carte_* dit "X a obtenu Y % à La Rochelle"
    // ce qui reste factuellement correct même si X n'a pas gagné.
    let carteSubject = cityWinner;
    if (subjectCandidate) {
      const found = cityData.ranked.find(r => r.cand === subjectCandidate);
      carteSubject = found || { cand: subjectCandidate, pct: 0 };
    }

    // Meilleur bureau du sujet carte (= carteSubject, pas cityWinner). Sert au canva
    // carte_* qui mentionne "📍 Meilleur score dans le bureau n°…". Si on est sur
    // subCarte='candidat' avec Simoné, on veut SON meilleur bureau personnel, pas
    // celui du vrai gagnant ville.
    let bestBureau = null, bestBureauPct = -1;
    if (carteSubject) {
      allNums.forEach(n => {
        const p = sheet[n]?.c?.[carteSubject.cand];
        if (typeof p === 'number' && p > bestBureauPct) { bestBureauPct = p; bestBureau = n; }
      });
      if (bestBureauPct < 0) bestBureauPct = 0;
    }

    // Gagnant dans un bureau précis (en excluant les pseudo-candidats)
    let bureauWinner = null;
    if (bur && sheet[bur]?.c) {
      const ranked = Object.entries(sheet[bur].c)
        .filter(([cand]) => !isPseudoCand(cand))
        .map(([cand, pct]) => ({ cand, pct }))
        .sort((a, b) => b.pct - a.pct);
      bureauWinner = ranked[0] || null;
    }

    // Gagnant dans un quartier (agrégation des bureaux du quartier)
    let quartierWinner = null;
    if (bureausDuQuartier?.length) {
      const qData = aggregate(bureausDuQuartier.filter(n => sheet[n]));
      quartierWinner = qData.ranked[0] || null;
    }

    // Gagnant dans un canton (agrégation des bureaux du canton)
    let cantonWinner = null;
    if (bureausDuCanton?.length) {
      const cData = aggregate(bureausDuCanton.filter(n => sheet[n]));
      cantonWinner = cData.ranked[0] || null;
    }

    // Cas référendum : remplacer le candidat par Oui/Non
    function toRef(winner, nums) {
      if (!winner) return null;
      const ouiTotal = nums.reduce((s, n) => s + ((sheet[n]?.c?.Oui || 0) / 100) * (sheet[n]?.e || 0), 0);
      const nonTotal = nums.reduce((s, n) => s + ((sheet[n]?.c?.Non || 0) / 100) * (sheet[n]?.e || 0), 0);
      const exp      = nums.reduce((s, n) => s + (sheet[n]?.e || 0), 0);
      const rep      = ouiTotal >= nonTotal ? 'Oui' : 'Non';
      return { cand: rep, pct: exp > 0 ? Math.max(ouiTotal, nonTotal) / exp * 100 : 0 };
    }

    if (isRef) {
      cityWinner   && Object.assign(cityWinner,    toRef(cityWinner,    allNums));
      bureauWinner && Object.assign(bureauWinner,  toRef(bureauWinner,  bur ? [bur] : []));
      quartierWinner && Object.assign(quartierWinner, toRef(quartierWinner, bureausDuQuartier || []));
      cantonWinner   && Object.assign(cantonWinner,   toRef(cantonWinner,   bureausDuCanton   || []));
      // Sur référendum, pas de subCarte='candidat' (cf. ligne ~618), donc
      // carteSubject === cityWinner par construction. On le réaligne après
      // mutation par toRef pour éviter toute divergence accidentelle.
      carteSubject = cityWinner;

      // Meilleur bureau pour la réponse gagnante (référendum)
      if (cityWinner) {
        const rep = cityWinner.cand;
        bestBureau = null; bestBureauPct = 0;
        allNums.forEach(n => {
          const p = sheet[n]?.c?.[rep] || 0;
          if (p > bestBureauPct) { bestBureauPct = p; bestBureau = n; }
        });
      }
    }

    return { cityWinner, carteSubject, bestBureau, bestBureauPct, bureauWinner, quartierWinner, cantonWinner };

  }, election, tour, bureau, quartier, bureau ? null : (quartiersBureauxEra[quartier] || null), cantonBureaux, isRef, candidatPicked);

  if (!elecData) {
    console.error('❌ Données introuvables. Abandon.');
    await browser.close(); process.exit(1);
  }

  // ── 5. Infos candidat depuis CAND_DATA ────────────────────────────────────
  // Ordre de lookup (plus spécifique → plus général), cohérent avec
  // l'implémentation de LRVcarte.html / LRVanalyse.html :
  //   1. name|election|tour  (ex. "Royal PS-PRG|Régionales 2010|T1")
  //   2. name|election       (override par scrutin)
  //   3. name                (entrée générique)
  async function candInfo(name) {
    if (!name || name === 'Oui' || name === 'Non') return { prenom: '', nom: name, parti: '' };
    return page.evaluate((n, el, tr) => {
      // Post-M5 : seul `CAND_DATA[n]` est peuplé. Les 2 lookups pipe-key (`n|el`,
      // `n|el|tr`) étaient des no-op. Variations par tour gérées via `tour_specific`.
      const cd = CAND_DATA?.[n] || {};
      // Cas binôme paritaire (Départementales/Cantonales modernes) : l'entrée
      // CAND_DATA n'a pas de p/n/s propres, on résout les 2 membres via PERSONS
      // — même logique que binomeMembers/binomeFullLabel dans LRVcarte (femme
      // devant si sexes connus, sinon ordre d'origine).
      if (Array.isArray(cd.binome) && cd.binome.length === 2) {
        const m1 = (typeof PERSONS !== 'undefined' && PERSONS[cd.binome[0]]) || {};
        const m2 = (typeof PERSONS !== 'undefined' && PERSONS[cd.binome[1]]) || {};
        const ordered = (m1.s !== 'F' && m2.s === 'F') ? [m2, m1] : [m1, m2];
        const nom = ordered
          .map(m => ((m.p ? m.p + ' ' : '') + (m.n || '')).trim())
          .filter(Boolean)
          .join(' / ');
        return { prenom: '', nom: nom || n, parti: cd.pa || '' };
      }
      return { prenom: cd.p || '', nom: cd.n || n, parti: cd.pa || '' };
    }, name, election, tour);
  }

  // ── 6. Construire les variables communes ──────────────────────────────────
  const baseVars = {
    date_election: getDate(election, tour) || '?',
    election:      formatElectionLabel(election),
    tour:          tourLabel(tour),
    emoji:         electionEmoji(election),
  };

  // Info meilleur bureau (pour carte) — dénomination/quartier de l'ère de l'élection
  const bestBInfo = bureauxInfoEra[elecData.bestBureau] || {};
  const carteVars = {
    bureau_num:   elecData.bestBureau ? String(parseInt(elecData.bestBureau)) : '?',
    denomination: bestBInfo.denomination || '',
    quartier:     bestBInfo.quartier || '',
  };

  // Info bureau sélectionné (pour fiche bureau) — idem, ère de l'élection
  const bInfo    = bureauxInfoEra[bureau] || {};
  const bureauVars = {
    bureau_num:   bureau ? String(parseInt(bureau)) : '?',
    denomination: bInfo.denomination || '',
    quartier:     bInfo.quartier || '',
  };

  // Construit l'URL profonde vers la vue exacte du tweet (carte/bureau/quartier/canton/global)
  function buildDeepLink(niv) {
    const params = new URLSearchParams();
    params.set('election', election);
    if (tour && tour !== 'TU')        params.set('tour',     tour);
    if (niv === 'bureau'   && bureau) params.set('bureau',   bureau);
    if (niv === 'quartier' && quartier) params.set('quartier', quartier);
    if (niv === 'canton'   && canton) params.set('canton',   canton);
    if (niv === 'global')             params.set('tab',      'global');
    // Carte candidat : précharger la heatmap du bon candidat
    if (niv === 'carte' && subCarte === 'candidat' && candidatPicked) {
      params.set('selection', candidatPicked);
    }
    return SITE_URL + '/LRVcarte.html#' + params.toString();
  }

  // ── 7. Générer le texte avec cascade de repli ─────────────────────────────
  //
  // Cascade à DEUX étages :
  //   1. À chaque niveau (carte/bureau/…), on tente 4 étapes de troncature
  //      progressive avant de passer au niveau plus large :
  //        Étape 1 : texte complet
  //        Étape 2 : CTA raccourcie en "Détails sur {site_url}"
  //        Étape 3 : suffixe géo "à {quartier}" retiré (bureau + carte uniquement)
  //        Étape 4 : prénom remplacé par son initiale (M., MH., JL.)
  //   2. Si même l'étape 4 dépasse 280 chars, on cascade vers le niveau suivant
  //      de FALLBACK[niveau] (filet de sécurité, rarement déclenché en pratique).
  async function buildText(niv, step = 1) {
    const key = `${niv}_${suffix}`;
    let tpl = C[key];
    if (!tpl) return null;

    let winner, extra = {};
    if (niv === 'carte') {
      // Sujet du canva carte_* : peut être le gagnant ville OU un candidat tiré
      // pondéré (subCarte='candidat'). Cf. carteSubject dans elecData.
      winner = elecData.carteSubject;
      extra  = { ...carteVars };
    } else if (niv === 'bureau') {
      winner = elecData.bureauWinner;
      extra  = { ...bureauVars };
    } else if (niv === 'quartier') {
      winner = elecData.quartierWinner;
      extra  = { quartier: quartier || bInfo.quartier || '?' };
    } else if (niv === 'canton') {
      winner = elecData.cantonWinner;
      // Le nom du canton (ex. "La Rochelle-1") vient de cantonsModernes calculé plus haut.
      extra  = { canton_nom: (cantonsModernes && canton) ? (cantonsModernes[canton] || ('La Rochelle-' + canton)) : '?' };
    } else { // global
      // ATTENTION : on utilise cityWinner (vrai gagnant ville), pas carteSubject.
      // Sinon une cascade carte/candidat → global afficherait "X arrive en tête à
      // La Rochelle" pour un candidat qui n'a pas réellement gagné.
      winner = elecData.cityWinner;
      extra  = {};
    }

    // Si pas de winner pour ce niveau (ex. quartier d'aujourd'hui mappé sur un découpage
    // antérieur où les bureau IDs ne matchent pas), on retourne null pour déclencher
    // la cascade de repli (FALLBACK[niveau] → niveau plus large jusqu'à 'global').
    if (!winner) return null;

    // ── Variante anniversaire (rdv schedule.json) ────────────────────────────
    // Si on est sur un rendez-vous (commémoration), on remplace l'en-tête
    // "{emoji} Le {date}, pour la {election}" par "🎂 Il y a N ans aujourd'hui,
    // pour la {election_anniv}" + verbes à l'imparfait. Vars `anniv_phrase` et
    // `election_anniv` injectées plus bas.
    const isAnniv = !!rdv;
    if (isAnniv) tpl = applyAnniversaryTemplate(tpl);

    // ── Troncatures niveau-template (étapes 2 et 3) ──────────────────────────
    // Étape 2 : remplace toutes les CTA longues "Les résultats de … sur {site_url}"
    // par la version courte "Détails sur {site_url}". Match unique en fin de
    // template (les 12 canevas suivent strictement ce pattern).
    if (step >= 2) {
      tpl = tpl.replace(/\n\nLes résultats de [^\n]+sur \{site_url\}$/, '\n\nDétails sur {site_url}');
    }
    // Étape 3 : retire le suffixe " à {quartier}" (uniquement bureau et carte,
    // qui ont la structure "n°X · DENOM à QUARTIER"). N/A pour quartier/canton/
    // global où l'unité géo EST le sujet du tweet.
    if (step >= 3 && (niv === 'bureau' || niv === 'carte')) {
      tpl = tpl.replace(' · {denomination} à {quartier}', ' · {denomination}');
    }

    const ci = await candInfo(winner?.cand);
    // Étape 4 : prénom → initiale (Marielle → M., Marie-Hélène → MH., Jean-Luc → JL.).
    // Sans effet pour les binômes (prenom vide) et "Oui"/"Non" (référendums).
    const prenomDisplay = step >= 4 ? initializePrenom(ci.prenom) : ci.prenom;

    const vars = {
      ...baseVars, ...extra,
      prenom_nom: `${prenomDisplay} ${ci.nom}`.trim(),
      parti:      ci.parti || '',
      score:      formatPct(winner?.pct),
      reponse:    isRef ? winner?.cand : '',
      site_url:   buildDeepLink(niv),
      // Variantes anniversaire (utilisées uniquement si le template a été
      // transformé par applyAnniversaryTemplate ; sinon ces placeholders
      // n'apparaissent pas dans le template et fillCaneva les ignore).
      anniv_phrase:   isAnniv ? anniversaryPhrase(anniversaryYears(election, today)) : '',
      election_anniv: isAnniv ? formatElectionLabelFull(election) : '',
    };

    return fillCaneva(tpl, vars).replace(/\s*\(\s*\)/g, '').replace(/\s+,/g, ',').trim();
  }

  let tweetText = null;
  let niveauFinal = niveau;
  let truncationStep = 1;
  outer:
  for (const niv of FALLBACK[niveau]) {
    for (let step = 1; step <= 4; step++) {
      // Étape 3 inutile pour quartier/canton/global (pas de "à {quartier}" à retirer) :
      // on saute directement à l'étape 4 pour ne pas refaire un essai identique au 2.
      if (step === 3 && niv !== 'bureau' && niv !== 'carte') continue;
      const text = await buildText(niv, step);
      if (text && twitterLen(text) <= 280) {
        tweetText    = text;
        niveauFinal  = niv;
        truncationStep = step;
        break outer;
      }
      if (text) console.warn(`⚠️  ${niv} étape ${step} : ${twitterLen(text)} chars — troncature suivante`);
    }
  }

  if (!tweetText) {
    // Dernier recours : texte global tronqué (étape 4 = toutes troncatures actives)
    tweetText = await buildText('global', 4) || `${CHAPEAU}\n{site_url}`;
    niveauFinal = 'global (forcé)';
    truncationStep = 4;
  }

  console.log(`\n📝 Canevas : ${niveauFinal}_${suffix} | étape ${truncationStep} | ${twitterLen(tweetText)} chars`);
  console.log('─'.repeat(60));
  console.log(tweetText);
  console.log('─'.repeat(60));

  // ── 8. Tuiles CARTO/OSM : interception déjà posée AVANT le 1er goto (cf. début
  // de la fonction). Ré-affirmer ici serait un double-bind erroné. ────────────

  // ── 9. Naviguer vers l'URL avec les params (sans mode=export — on contrôle nous-mêmes) ──
  // IMPORTANT : on utilise niveauFinal (le niveau REEL utilisé pour le texte après
  // éventuelle cascade de repli > 280 chars), pas niveau (le niveau initialement
  // tiré). Sans ça, si le texte cascadait p. ex. de "bureau" vers "global" parce
  // qu'il dépassait 280 chars, on continuait d'ouvrir la fiche du bureau initial
  // alors que le texte parlait de la ville → image incohérente avec le texte.
  // La normalisation `' (forcé)'` gère le cas de dernier recours (cf. ligne ~900
  // où niveauFinal devient 'global (forcé)' si aucun niveau ne tient en 280 chars).
  const urlNiveau = (niveauFinal || niveau).replace(' (forcé)', '');
  const params = new URLSearchParams();
  params.set('election', election);
  if (tour && tour !== 'TU') params.set('tour', tour);
  if (urlNiveau === 'bureau'   && bureau)   params.set('bureau',   bureau);
  if (urlNiveau === 'quartier' && quartier) params.set('quartier', quartier);
  if (urlNiveau === 'canton'   && canton)   params.set('canton',   canton);
  if (urlNiveau === 'global')               params.set('tab',      'global');
  // Carte candidat : sélectionne le bon candidat pour que la heatmap s'affiche
  // (mode 'candidat' est déjà le défaut côté LRVcarte.html — pas besoin de mode=).
  // Pas appliqué si on a cascadé vers 'global' : le tab global ouvre la fiche
  // ville, pas la heatmap candidat, donc selection= n'aurait pas de sens.
  if (urlNiveau === 'carte' && subCarte === 'candidat' && candidatPicked) {
    params.set('selection', candidatPicked);
  }
  // PAS de params.set('mode', 'export') — on évite l'IIFE auto-export de la page
  // qui a un timing fragile et un override de downloadCanvas qui peut nous échapper.

  const targetUrl = BASE_URL + 'LRVcarte.html#' + params.toString();
  console.log(`\n🌐 → ${targetUrl}`);

  await page.goto('about:blank');
  try {
    await page.goto(targetUrl, { waitUntil: 'networkidle0', timeout: 60000 });
  } catch { /* timeout toléré */ }

  // Capter les console.* du navigateur (debug)
  page.on('console', msg => {
    const t = msg.type();
    if (t === 'error' || t === 'warning' || t === 'log') console.log(`[browser ${t}]`, msg.text());
  });
  page.on('pageerror', err => console.log('[browser pageerror]', err.message));

  // ── 10. Attendre que window.compose / composeFiche soient dispo ──────────
  // Ces fonctions sont exposées par LRVcarte.html sur window à la fin de l'IIFE.
  // On les appelle directement → pas de download intempestif (downloadCanvas non touché).
  console.log('⏳ Attente de window.compose / composeFiche…');
  try {
    await page.waitForFunction(
      () => typeof window.compose === 'function'
         && typeof window.composeFiche === 'function'
         && typeof window.getFicheContext === 'function'
         && typeof ELECTIONS !== 'undefined'
         && Object.keys(ELECTIONS).length > 0,
      { timeout: 30000 }
    );
  } catch {
    console.error('❌ window.compose/composeFiche non dispo après 30s. Le LRVcarte.html sur lequel tu testes ne les expose pas (push à jour ou utilise LOCAL=1).');
    await browser.close(); process.exit(1);
  }

  // Petite attente pour que le site applique le hash (overlay ouvert si fiche, etc.)
  console.log('⏳ Attente application des params (3s)…');
  await new Promise(r => setTimeout(r, 3000));

  // ── 11. Capture : appel direct compose/composeFiche, retour dataUrl ──────
  let screenshotBuffer;
  console.log('🖼️  Génération de l\'image (appel direct compose/composeFiche)…');
  try {
    const dataUrl = await page.evaluate(async () => {
      window._exportMode = true; // skip fonts.ready dans compose

      const tStart = Date.now();
      const dt = () => ((Date.now() - tStart) / 1000).toFixed(1) + 's';

      const fctx = window.getFicheContext();
      console.log('[trace] fctx:', fctx ? 'fiche' : 'carte');

      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 60s')), 60000));
      const composer = fctx ? window.composeFiche(fctx) : window.compose();

      const canvas = await Promise.race([composer, timeout]);
      console.log('[trace] canvas obtenu après ' + dt(), 'taille:', canvas?.width, 'x', canvas?.height);
      if (!canvas) throw new Error('canvas null');
      return canvas.toDataURL('image/png');
    });

    if (!dataUrl || !dataUrl.startsWith('data:image/png;base64,')) {
      throw new Error('dataUrl manquant ou format invalide');
    }
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    screenshotBuffer = Buffer.from(base64, 'base64');
    console.log(`✅ Export natif réussi (${(screenshotBuffer.length / 1024).toFixed(0)} KB)`);
  } catch (err) {
    console.warn(`⚠️  Export natif échoué (${err.message}) — fallback screenshot`);
    // Le selector doit suivre le niveau RÉEL navigué (urlNiveau), pas le niveau
    // initialement tiré : si on a cascadé vers 'global', la page affiche le
    // #overlay (fiche globale), pas la #main (carte).
    const selector = urlNiveau === 'carte' ? '#main' : '#overlay';
    try {
      const el  = await page.$(selector);
      const box = el && await el.boundingBox();
      if (box && box.width > 10) {
        screenshotBuffer = await el.screenshot({ type: 'png' });
        console.log(`✅ Screenshot fallback : ${selector}`);
      }
    } catch { /* ignore */ }
    if (!screenshotBuffer) {
      screenshotBuffer = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 1280, height: 720 } });
    }
  }

  await browser.close();

  // ── 10. Sauvegarde ────────────────────────────────────────────────────────
  const outDir = path.join(__dirname, 'daily-tweet');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  // niveau_publie = niveauFinal (après cascade) normalisé en retirant " (forcé)".
  // Calculé ici pour être stocké à la fois dans meta.json et history.json,
  // cohérent entre les deux (audit low #7 : avant, meta.json stockait `niveauFinal`
  // brut avec suffixe, alors que history.json le normalisait).
  const niveauPublie = String(niveauFinal || niveau).replace(' (forcé)', '');

  fs.writeFileSync(path.join(outDir, 'image.png'),  screenshotBuffer);
  fs.writeFileSync(path.join(outDir, 'tweet.txt'),  tweetText, 'utf8');
  fs.writeFileSync(path.join(outDir, 'meta.json'),  JSON.stringify({
    date: today,
    niveau,                    // tirage initial (= sert à la signature anti-doublons)
    niveau_publie: niveauPublie, // après cascade éventuelle, normalisé
    election, tour, bureau, quartier, canton,
    subtype: subCarte || null,
    candidat: candidatPicked || null,
    signature,
    chars: twitterLen(tweetText), generated_at: new Date().toISOString(),
  }, null, 2), 'utf8');

  // ── 11. Mise à jour de l'historique anti-doublons ─────────────────────────
  // On retire d'éventuelles entrées du jour (re-run manuel) avant d'ajouter
  // la nouvelle, pour éviter qu'une même date apparaisse deux fois.
  const histPath = path.join(outDir, 'history.json');
  const updatedHistory = (tweetHistory || []).filter(e => e.date !== today);
  updatedHistory.push({
    date: today,
    signature,
    niveau,
    niveau_publie: niveauPublie,
    truncation_step: truncationStep,
    election,
    tour,
    bureau:   bureau   || null,
    quartier: quartier || null,
    subtype:  subCarte || null,
    candidat: candidatPicked || null,
  });
  updatedHistory.sort((a, b) => a.date.localeCompare(b.date));
  fs.writeFileSync(histPath, JSON.stringify(updatedHistory, null, 2) + '\n', 'utf8');
  console.log(`📚 history.json mis à jour (${updatedHistory.length} entrées)`);

  console.log('\n🎉 Prêt pour Make.com !');

  } finally {
    try { await browser.close(); } catch (_) {}
  }
})().catch(err => {
  console.error('❌ Erreur :', err);
  process.exit(1);
});
