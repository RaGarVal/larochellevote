/**
 * daily-capture.js — LaRochelleVote
 * ─────────────────────────────────────────────────────────────────────────────
 * Chaque matin GitHub Actions exécute ce script qui :
 *   1. Vérifie si aujourd'hui est un rendez-vous fixé dans schedule.json
 *   2. Sinon, choisit aléatoirement un type de contenu et une élection
 *   3. Ouvre le site, extrait les données réelles
 *   4. Génère le texte du tweet (12 canevas + cascade si > 280 chars)
 *   5. Capture l'image et sauvegarde le tout dans daily-tweet/
 *
 * Cascade de repli automatique si le texte dépasse 280 caractères :
 *   carte    → texte global (même image)
 *   bureau   → quartier → global (même image)
 *   quartier → global   (même image)
 *   global   → toujours dans les limites
 * ─────────────────────────────────────────────────────────────────────────────
 */

const puppeteer = require('puppeteer');
const fs        = require('fs');
const path      = require('path');

// ══ CONFIGURATION ════════════════════════════════════════════════════════════

const BASE_URL = 'https://ragarval.github.io/larochellevote/';
const SITE_URL = 'https://ragarval.github.io/larochellevote'; // compté 23 chars par Twitter
const CHAPEAU  = '📊 @LaRochelleVote — La donnée du jour';

// Probabilités de tirage (doivent sommer à 1)
const PROBA = {
  carte:    0.30,
  bureau:   0.42,
  quartier: 0.21,
  global:   0.07,
};

// ══ LES 12 CANEVAS ═══════════════════════════════════════════════════════════

const C = {

  // ── CARTE ──────────────────────────────────────────────────────────────────
  // Vue carte complète. Texte : gagnant ville + meilleur bureau.

  carte_presidentielle:
`${CHAPEAU}
{emoji} Le {date_election}, pour la {election} {tour}, {prenom_nom} ({parti}) a obtenu {score} % à La Rochelle. 📍 Meilleur score dans le bureau n°{bureau_num} · {denomination} à {quartier}.
Les résultats de ce scrutin, bureau par bureau, sur ${SITE_URL}`,

  carte_referendum:
`${CHAPEAU}
{emoji} Le {date_election}, pour le {election}, le {reponse} a obtenu {score} % à La Rochelle. 📍 Meilleur score dans le bureau n°{bureau_num} · {denomination} à {quartier}.
Les résultats de ce scrutin, bureau par bureau, sur ${SITE_URL}`,

  carte_autres:
`${CHAPEAU}
{emoji} Le {date_election}, pour les {election} {tour}, {prenom_nom} ({parti}) a obtenu {score} % à La Rochelle. 📍 Meilleur score dans le bureau n°{bureau_num} · {denomination} à {quartier}.
Les résultats de ce scrutin, bureau par bureau, sur ${SITE_URL}`,

  // ── FICHE BUREAU ───────────────────────────────────────────────────────────
  // Vue panneau d'un bureau. Texte : gagnant dans ce bureau.

  bureau_presidentielle:
`${CHAPEAU}
{emoji} Le {date_election}, pour la {election} {tour}, {prenom_nom} ({parti}) est arrivé·e en tête avec {score} % dans le bureau n°{bureau_num} · {denomination} à {quartier}.
Les résultats de ce bureau, et tous les autres, sur ${SITE_URL}`,

  bureau_referendum:
`${CHAPEAU}
{emoji} Le {date_election}, pour le {election}, le {reponse} est arrivé en tête avec {score} % dans le bureau n°{bureau_num} · {denomination} à {quartier}.
Les résultats de ce bureau, et tous les autres, sur ${SITE_URL}`,

  bureau_autres:
`${CHAPEAU}
{emoji} Le {date_election}, pour les {election} {tour}, {prenom_nom} ({parti}) est arrivé·e en tête avec {score} % dans le bureau n°{bureau_num} · {denomination} à {quartier}.
Les résultats de ce bureau, et tous les autres, sur ${SITE_URL}`,

  // ── FICHE QUARTIER ─────────────────────────────────────────────────────────
  // Vue panneau d'un quartier. Texte : gagnant dans ce quartier.

  quartier_presidentielle:
`${CHAPEAU}
{emoji} Le {date_election}, pour la {election} {tour}, {prenom_nom} ({parti}) est arrivé·e en tête avec {score} % dans le quartier de {quartier}.
Les résultats de ce quartier, et tous les autres, sur ${SITE_URL}`,

  quartier_referendum:
`${CHAPEAU}
{emoji} Le {date_election}, pour le {election}, le {reponse} est arrivé en tête avec {score} % dans le quartier de {quartier}.
Les résultats de ce quartier, et tous les autres, sur ${SITE_URL}`,

  quartier_autres:
`${CHAPEAU}
{emoji} Le {date_election}, pour les {election} {tour}, {prenom_nom} ({parti}) est arrivé·e en tête avec {score} % dans le quartier de {quartier}.
Les résultats de ce quartier, et tous les autres, sur ${SITE_URL}`,

  // ── FICHE GLOBAL ───────────────────────────────────────────────────────────
  // Vue résultats ville entière. Texte : gagnant à La Rochelle.

  global_presidentielle:
`${CHAPEAU}
{emoji} Le {date_election}, pour la {election} {tour}, {prenom_nom} ({parti}) est arrivé·e en tête avec {score} % à La Rochelle.
Les résultats de ce scrutin, et tous les autres, sur ${SITE_URL}`,

  global_referendum:
`${CHAPEAU}
{emoji} Le {date_election}, pour le {election}, le {reponse} est arrivé en tête avec {score} % à La Rochelle.
Les résultats de ce scrutin, et tous les autres, sur ${SITE_URL}`,

  global_autres:
`${CHAPEAU}
{emoji} Le {date_election}, pour les {election} {tour}, {prenom_nom} ({parti}) est arrivé·e en tête avec {score} % à La Rochelle.
Les résultats de ce scrutin, et tous les autres, sur ${SITE_URL}`,
};

// Ordre de repli si > 280 chars (du plus spécifique au plus court)
const FALLBACK = {
  carte:    ['carte', 'global'],
  bureau:   ['bureau', 'quartier', 'global'],
  quartier: ['quartier', 'global'],
  global:   ['global'],
};

// ══ TABLE DES DATES D'ÉLECTIONS ══════════════════════════════════════════════

const DATES = {
  'Présidentielle 1988': { T1: '24 avril 1988',      T2: '8 mai 1988'       },
  'Présidentielle 1995': { T1: '23 avril 1995',      T2: '7 mai 1995'       },
  'Présidentielle 2002': { T1: '21 avril 2002',      T2: '5 mai 2002'       },
  'Présidentielle 2007': { T1: '22 avril 2007',      T2: '6 mai 2007'       },
  'Présidentielle 2012': { T1: '22 avril 2012',      T2: '6 mai 2012'       },
  'Présidentielle 2017': { T1: '23 avril 2017',      T2: '7 mai 2017'       },
  'Présidentielle 2022': { T1: '10 avril 2022',      T2: '24 avril 2022'    },
  'Législatives 1988':   { T1: '5 juin 1988',        T2: '12 juin 1988'     },
  'Législatives 1993':   { T1: '21 mars 1993',       T2: '28 mars 1993'     },
  'Législatives 1997':   { T1: '25 mai 1997',        T2: '1er juin 1997'    },
  'Législatives 2002':   { T1: '9 juin 2002',        T2: '16 juin 2002'     },
  'Législatives 2007':   { T1: '10 juin 2007',       T2: '17 juin 2007'     },
  'Législatives 2012':   { T1: '10 juin 2012',       T2: '17 juin 2012'     },
  'Législatives 2017':   { T1: '11 juin 2017',       T2: '18 juin 2017'     },
  'Législatives 2022':   { T1: '12 juin 2022',       T2: '19 juin 2022'     },
  'Législatives 2024':   { T1: '30 juin 2024',       T2: '7 juillet 2024'   },
  'Municipales 1989':    { T1: '12 mars 1989',       T2: '19 mars 1989'     },
  'Municipales 1995':    { T1: '11 juin 1995',       T2: '18 juin 1995'     },
  'Municipales 2001':    { T1: '11 mars 2001',       T2: '18 mars 2001'     },
  'Municipales 2008':    { T1: '9 mars 2008',        T2: '16 mars 2008'     },
  'Municipales 2014':    { T1: '23 mars 2014',       T2: '30 mars 2014'     },
  'Municipales 2020':    { T1: '15 mars 2020',       T2: '28 juin 2020'     },
  'Municipales 2026':    { T1: '15 mars 2026',       T2: '22 mars 2026'     },
  'Européennes 1989':    { TU: '18 juin 1989'        },
  'Européennes 1994':    { TU: '12 juin 1994'        },
  'Européennes 1999':    { TU: '13 juin 1999'        },
  'Européennes 2004':    { TU: '13 juin 2004'        },
  'Européennes 2009':    { TU: '7 juin 2009'         },
  'Européennes 2014':    { TU: '25 mai 2014'         },
  'Européennes 2019':    { TU: '26 mai 2019'         },
  'Européennes 2024':    { TU: '9 juin 2024'         },
  'Référendum 1992':     { TU: '20 septembre 1992'   },
  'Référendum 2000':     { TU: '24 septembre 2000'   },
  'Référendum 2005':     { TU: '29 mai 2005'         },
};

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

function electionEmoji(label) {
  if (/présidentielle/i.test(label))       return '👤';
  if (/référendum/i.test(label))           return '🗳️';
  if (/législative/i.test(label))          return '🏛️';
  if (/municipale|régionale/i.test(label)) return '🏙️';
  if (/européenne/i.test(label))           return '🇪🇺';
  return '🗳️';
}

function tourLabel(tour) {
  if (!tour || tour === 'TU') return '';
  if (tour === 'T1') return '(1er tour)';
  if (tour === 'T2') return '(2e tour)';
  return `(${tour})`;
}

function getDate(electionLabel, tour) {
  const entry = DATES[electionLabel];
  if (!entry) return null;
  return entry[tour] || entry.TU || entry.T1 || Object.values(entry)[0];
}

// ══ PROGRAMME ÉDITORIAL ══════════════════════════════════════════════════════

const today = (process.env.TWEET_DATE || new Date().toISOString().split('T')[0]).trim();
console.log(`\n📅 Date : ${today}`);

const schedulePath = path.join(__dirname, '../daily-tweet/schedule.json');
const schedule     = fs.existsSync(schedulePath)
  ? JSON.parse(fs.readFileSync(schedulePath, 'utf8')).filter(e => e.date)
  : [];

const rdv = schedule.find(e => e.date === today) || null;
console.log(rdv ? `📌 Rendez-vous : ${rdv.note || rdv.election}` : '🎲 Sélection aléatoire');

// ══ LANCEMENT ════════════════════════════════════════════════════════════════

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--lang=fr-FR'],
  });

  const page = await browser.newPage();

  // Supprimer la visite guidée sur toutes les navigations (doit être avant le premier goto)
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('lrvote_tour_carte_v2_seen', '1');
  });

  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });

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
    await browser.close(); process.exit(0);
  }

  // ── 2. Extraire la liste des élections, bureaux et quartiers ──────────────
  const siteData = await page.evaluate(() => {
    const elections = Object.keys(ELECTIONS || {});

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

    // Infos bureaux
    const bi = BUREAU_INFO?.['2026'] || {};
    const bureauxInfo = {};
    const quartiersBureaux = {}; // { quartierNom: [num, num, ...] }
    Object.entries(bi).forEach(([num, b]) => {
      if (b && b.q !== 'Nul') {
        bureauxInfo[num] = { denomination: b.den || b.nom || `Bureau ${num}`, quartier: b.q || '' };
        const q = b.q || '';
        if (q) {
          if (!quartiersBureaux[q]) quartiersBureaux[q] = [];
          quartiersBureaux[q].push(num);
        }
      }
    });

    return { elections, bureauxParElection, bureauxInfo, quartiersBureaux };
  });

  const { elections, bureauxParElection, bureauxInfo, quartiersBureaux } = siteData;
  const quartiers = Object.keys(quartiersBureaux);
  console.log(`📊 ${elections.length} élections, ${Object.keys(bureauxInfo).length} bureaux, ${quartiers.length} quartiers`);

  // ── 3. Choisir le contenu du jour ─────────────────────────────────────────
  let niveau   = rdv?.type     || pickWeighted(PROBA);     // carte/bureau/quartier/global
  let election = rdv?.election || pickRandom(elections.filter(el => (bureauxParElection[el]||[]).length > 0));
  let tour     = rdv?.tour     || null;
  let bureau   = rdv?.bureau   || null;
  let quartier = rdv?.quartier || null;

  // Déterminer le tour
  if (!tour) {
    const availTours = await page.evaluate(el => Object.keys(ELECTIONS?.[el]?.sheets || {}), election);
    tour = availTours.includes('T1') ? 'T1' : availTours.includes('TU') ? 'TU' : availTours[0];
  }

  // Sélections aléatoires selon le niveau
  if (niveau === 'bureau' && !bureau) {
    const candidats = (bureauxParElection[election] || []).filter(n => bureauxInfo[n]);
    bureau = pickRandom(candidats);
  }
  if ((niveau === 'quartier' || (niveau === 'bureau' && !bureau)) && !quartier) {
    quartier = pickRandom(quartiers);
  }

  const suffix = electionSuffix(election);
  const isRef  = suffix === 'referendum';
  console.log(`📌 Niveau : ${niveau} | ${election} | Tour : ${tour} | Bureau : ${bureau||'—'} | Quartier : ${quartier||'—'}`);

  // ── 4. Extraire les données électorales ───────────────────────────────────
  const elecData = await page.evaluate((el, tr, bur, qrt, bureausDuQuartier, isRef) => {
    const sheets = ELECTIONS?.[el]?.sheets || {};
    const sheet  = sheets[tr] || sheets.TU || sheets[Object.keys(sheets)[0]];
    if (!sheet) return null;

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
        .map(([cand, v]) => ({ cand, pct: totalExp > 0 ? (v / totalExp) * 100 : 0 }))
        .sort((a, b) => b.pct - a.pct) };
    }

    const allNums     = Object.keys(sheet).filter(n => sheet[n]?.c && Object.keys(sheet[n].c).length > 0);
    const cityData    = aggregate(allNums);
    const cityWinner  = cityData.ranked[0];

    // Meilleur bureau du gagnant ville
    let bestBureau = null, bestBureauPct = 0;
    if (cityWinner) {
      allNums.forEach(n => {
        const p = sheet[n]?.c?.[cityWinner.cand] || 0;
        if (p > bestBureauPct) { bestBureauPct = p; bestBureau = n; }
      });
    }

    // Gagnant dans un bureau précis
    let bureauWinner = null;
    if (bur && sheet[bur]?.c) {
      const ranked = Object.entries(sheet[bur].c)
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

    return { cityWinner, bestBureau, bestBureauPct, bureauWinner, quartierWinner };

  }, election, tour, bureau, quartier, bureau ? null : (quartiersBureaux[quartier] || null), isRef);

  if (!elecData) {
    console.error('❌ Données introuvables. Abandon.');
    await browser.close(); process.exit(0);
  }

  // ── 5. Infos candidat depuis CAND_DATA ────────────────────────────────────
  async function candInfo(name) {
    if (!name || name === 'Oui' || name === 'Non') return { prenom: '', nom: name, parti: '' };
    return page.evaluate((n, el) => {
      const cd = CAND_DATA?.[n + '|' + el] || CAND_DATA?.[n] || {};
      return { prenom: cd.p || '', nom: cd.n || n, parti: cd.pa || '' };
    }, name, election);
  }

  // ── 6. Construire les variables communes ──────────────────────────────────
  const baseVars = {
    date_election: getDate(election, tour) || '?',
    election:      formatElectionLabel(election),
    tour:          tourLabel(tour),
    emoji:         electionEmoji(election),
  };

  // Info meilleur bureau (pour carte)
  const bestBInfo = bureauxInfo[elecData.bestBureau] || {};
  const carteVars = {
    bureau_num:   elecData.bestBureau ? String(parseInt(elecData.bestBureau)) : '?',
    denomination: bestBInfo.denomination || '',
    quartier:     bestBInfo.quartier || '',
  };

  // Info bureau sélectionné (pour fiche bureau)
  const bInfo    = bureauxInfo[bureau] || {};
  const bureauVars = {
    bureau_num:   bureau ? String(parseInt(bureau)) : '?',
    denomination: bInfo.denomination || '',
    quartier:     bInfo.quartier || '',
  };

  // ── 7. Générer le texte avec cascade de repli ─────────────────────────────
  async function buildText(niv) {
    const key = `${niv}_${suffix}`;
    const tpl = C[key];
    if (!tpl) return null;

    let winner, extra = {};
    if (niv === 'carte') {
      winner = elecData.cityWinner;
      extra  = { ...carteVars };
    } else if (niv === 'bureau') {
      winner = elecData.bureauWinner;
      extra  = { ...bureauVars };
    } else if (niv === 'quartier') {
      winner = elecData.quartierWinner;
      extra  = { quartier: quartier || bInfo.quartier || '?' };
    } else { // global
      winner = elecData.cityWinner;
      extra  = {};
    }

    const ci = await candInfo(winner?.cand);
    const vars = {
      ...baseVars, ...extra,
      prenom_nom: `${ci.prenom} ${ci.nom}`.trim(),
      parti:      ci.parti || '',
      score:      formatPct(winner?.pct),
      reponse:    isRef ? winner?.cand : '',
    };

    return fillCaneva(tpl, vars).replace(/\s*\(\s*\)/g, '').trim();
  }

  let tweetText = null;
  let niveauFinal = niveau;
  for (const niv of FALLBACK[niveau]) {
    const text = await buildText(niv);
    if (text && twitterLen(text) <= 280) {
      tweetText    = text;
      niveauFinal  = niv;
      break;
    }
    console.warn(`⚠️  Niveau "${niv}" : ${twitterLen(text || '')} chars — repli`);
  }

  if (!tweetText) {
    // Dernier recours : texte global tronqué
    tweetText = await buildText('global') || `${CHAPEAU}\n${SITE_URL}`;
    niveauFinal = 'global (forcé)';
  }

  console.log(`\n📝 Canevas : ${niveauFinal}_${suffix} | ${twitterLen(tweetText)} chars`);
  console.log('─'.repeat(60));
  console.log(tweetText);
  console.log('─'.repeat(60));

  // ── 8. Naviguer vers la bonne URL ─────────────────────────────────────────
  const params = new URLSearchParams();
  params.set('election', election);
  if (tour && tour !== 'TU') params.set('tour', tour);
  if (niveau === 'bureau'   && bureau)   params.set('bureau',   bureau);
  if (niveau === 'quartier' && quartier) params.set('quartier', quartier);

  const targetUrl = BASE_URL + 'LRVcarte.html#' + params.toString();
  console.log(`\n🌐 → ${targetUrl}`);

  // Passer par about:blank pour forcer un vrai rechargement (pas une simple navigation hash)
  await page.goto('about:blank');

  try {
    await page.goto(targetUrl, { waitUntil: 'networkidle0', timeout: 60000 });
  } catch { /* timeout toléré */ }

  // Attendre que les données soient rechargées après la navigation
  console.log('⏳ Attente des données après navigation vers la cible…');
  try {
    await page.waitForFunction(
      () => typeof ELECTIONS !== 'undefined' && Object.keys(ELECTIONS).length > 0,
      { timeout: 30000 }
    );
  } catch { console.warn('⚠️  ELECTIONS non détecté après navigation'); }

  // Attendre le rendu complet de la carte et de l'élection sélectionnée
  await new Promise(r => setTimeout(r, 10000));

  // ── 9. Capture via l'export natif du site ────────────────────────────────
  let screenshotBuffer;

  console.log('🖼️  Déclenchement de l\'export natif…');
  try {
    // Attendre que la fonction d'export soit disponible
    await page.waitForFunction(
      () => typeof window.exportShareImage === 'function',
      { timeout: 10000 }
    );

    // Intercepter downloadCanvas pour récupérer le PNG au lieu de le télécharger
    // + patcher document.fonts.ready qui bloque infiniment en mode headless
    const imageDataUrl = await page.evaluate(async () => {
      // Patch : forcer fonts.ready à se résoudre au bout de 3s max
      try {
        const fontsObj = document.fonts;
        if (fontsObj && fontsObj.ready) {
          const patchedReady = Promise.race([
            fontsObj.ready,
            new Promise(r => setTimeout(r, 3000))
          ]);
          Object.defineProperty(document, 'fonts', {
            get: () => ({ ...fontsObj, ready: patchedReady }),
            configurable: true,
          });
        }
      } catch(e) { /* ignore si non configurable */ }

      return new Promise((resolve, reject) => {
        window.downloadCanvas = function(canvas) {
          resolve(canvas.toDataURL('image/png'));
          return Promise.resolve(true);
        };
        window.exportShareImage().catch(reject);
        setTimeout(() => reject(new Error('timeout export')), 25000);
      });
    });

    const base64 = imageDataUrl.replace(/^data:image\/png;base64,/, '');
    screenshotBuffer = Buffer.from(base64, 'base64');
    console.log('✅ Export natif réussi (1200×675 px)');

  } catch (err) {
    console.warn(`⚠️  Export natif échoué (${err.message}) — fallback screenshot`);
    const selector = niveau === 'carte' ? '#main' : '#overlay';
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
  const outDir = path.join(__dirname, '../daily-tweet');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  fs.writeFileSync(path.join(outDir, 'image.png'),  screenshotBuffer);
  fs.writeFileSync(path.join(outDir, 'tweet.txt'),  tweetText, 'utf8');
  fs.writeFileSync(path.join(outDir, 'meta.json'),  JSON.stringify({
    date: today, niveau: niveauFinal, election, tour, bureau, quartier,
    chars: twitterLen(tweetText), generated_at: new Date().toISOString(),
  }, null, 2), 'utf8');

  console.log('\n🎉 Prêt pour Make.com !');

})().catch(err => {
  console.error('❌ Erreur :', err);
  process.exit(1);
});
