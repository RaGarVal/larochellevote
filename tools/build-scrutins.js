/**
 * build-scrutins.js — La Rochelle Vote
 * ─────────────────────────────────────────────────────────────────────────────
 * Génère les pages statiques `/scrutins/{slug}.html` pour chaque scrutin
 * documenté dans donnees.js. Ces pages sont destinées au référencement Google
 * et au partage social — elles reproduisent le contenu de la fiche globale ville
 * (header, participation, top candidats, blocs politiques, quartiers, cantons)
 * en HTML statique, avec des title/meta/og dédiés.
 *
 * Usage :
 *   node tools/build-scrutins.js [--dry] [--only <slug>] [--verbose]
 *
 * Architecture :
 *   - Charge donnees.js + shared.js dans un sandbox vm (avec window stub)
 *   - Itère sur ELECTIONS et identifie les pages à produire :
 *       • élection classique → 1 page avec sections T1/T2 si applicable
 *       • cantonale/départementale → 1 page par canton
 *   - Calcule les agrégats ville/quartier/canton à partir des voix entières
 *     (`bd._voix[cid]`) — JAMAIS depuis `bd.c[cid] * e / 100`
 *   - Génère le HTML via un template et écrit dans `/scrutins/`
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

// ─── Configuration ───────────────────────────────────────────────────────────

const ROOT      = path.resolve(__dirname, '..');
const OUT_DIR   = path.join(ROOT, 'scrutins');
const VERBOSE   = process.argv.includes('--verbose');
const DRY       = process.argv.includes('--dry');
const ONLY_IDX  = process.argv.indexOf('--only');
const ONLY      = ONLY_IDX >= 0 ? process.argv[ONLY_IDX + 1] : null;

// ─── Chargement des données dans un sandbox ─────────────────────────────────

function loadData() {
  const donneesSrc  = fs.readFileSync(path.join(ROOT, 'donnees.js'), 'utf8');
  const sharedSrc   = fs.readFileSync(path.join(ROOT, 'shared.js'),  'utf8');

  // Stub window pour shared.js (qui suppose un environnement navigateur)
  const windowStub = {};
  const documentStub = {
    addEventListener: () => {},
    removeEventListener: () => {},
    documentElement: { setAttribute: () => {} },
    createElement: () => ({ style:{}, setAttribute:()=>{}, appendChild:()=>{} }),
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
  };
  const sandbox = {
    window: windowStub,
    document: documentStub,
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
  };
  windowStub.window = windowStub;
  windowStub.document = documentStub;

  // vm.runInContext ne remonte pas les `const` top-level au global. On annexe
  // donc un suffixe qui copie les noms exposés vers globalThis (= sandbox).
  const donneesNames = [
    'LAST_UPDATE','ELECTIONS','HISTORIQUE','BUREAU_INFO','BUREAU_CORRESPONDANCES',
    'QUARTIER_CORRESPONDANCES','CANTON_INFO','CANTON_CORRESPONDANCES','PARTI_NAMES',
    'CAND_DATA','PERSONS','CANDIDATURES','BLOC_CONFIG','BLOC_LEGACY','REDECOUPAGES'
  ];
  const donneesSuffix = ';Object.assign(globalThis,{' + donneesNames.join(',') + '});';

  const sharedNames = [
    'PARTI_COLORS','elecTypePriority','isReferendum','derivePaForBinome',
    'getCantonEraForBureauEra','getCantonEraForElection','getCantonOfBureau',
    'getBureauxOfCanton','isCantonEraAlive','isCantonalElection','getCantonOfElection',
    'personById','candById','candFullInfo','candidaturesOfPerson','candidaturesOfElection',
    'pickTextColor','pickTextColorForBg'
  ];
  const sharedSuffix = ';Object.assign(globalThis,{' + sharedNames.join(',') + '});';

  // geodata.js — contours géographiques des bureaux (GEOJSON pour 2026 + MAPS_DATA par ère)
  const geoSrc = fs.readFileSync(path.join(ROOT, 'geodata.js'), 'utf8');
  const geoSuffix = ';Object.assign(globalThis,{GEOJSON, MAPS_DATA});';

  vm.createContext(sandbox);
  vm.runInContext(donneesSrc + donneesSuffix, sandbox, { filename: 'donnees.js' });
  vm.runInContext(sharedSrc + sharedSuffix,  sandbox, { filename: 'shared.js' });
  vm.runInContext(geoSrc + geoSuffix,        sandbox, { filename: 'geodata.js' });

  // ERAS/CURRENT_ERA/ERAS_CANTON/CURRENT_ERA_CANTON sont posés sur window par shared.js
  sandbox.ERAS = windowStub.ERAS;
  sandbox.CURRENT_ERA = windowStub.CURRENT_ERA;
  sandbox.ERAS_CANTON = windowStub.ERAS_CANTON;
  sandbox.CURRENT_ERA_CANTON = windowStub.CURRENT_ERA_CANTON;

  return sandbox;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Slugifier un label d'élection : "Présidentielle 2002" → "presidentielle-2002" */
function slugifyElection(label) {
  return label
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Remplace les tirets ASCII par des tirets insécables U+2011 dans les noms composés
 *  (ex: "Lacoste-Lareymondie" → ne peut plus se couper en fin de ligne). */
function nbDash(s) {
  return String(s == null ? '' : s).replace(/-/g, '‑');
}

/** Abrège un prénom en initiales : "Jean-Luc" → "J.-L." */
function abbreviatePrenom(prenom) {
  if (!prenom) return '';
  return prenom.split('-')
    .map(p => p.trim()).filter(p => p.length)
    .map(p => p.charAt(0).toUpperCase() + '.')
    .join('-');
}

/** Construit le HTML d'un nom de candidat avec spans cn-prenom-full / cn-prenom-short
 *  pour la cascade de troncature. Gère individus et binômes. Tirets non-breaking dans nom. */
function candNameHTML(cd, ctx) {
  if (cd.binome && Array.isArray(cd.binome) && cd.binome.length === 2) {
    const persons = orderedBinomePersons(cd, ctx);
    return persons.map(m => {
      const nomNB = nbDash(m.n || '');
      if (!m.p) return nomNB;
      const short = abbreviatePrenom(m.p);
      return `<span class="cn-prenom-full">${esc(m.p)} </span><span class="cn-prenom-short">${esc(short)} </span>${esc(nomNB)}`;
    }).join(' / ');
  }
  const person = cd.person ? ctx.PERSONS[cd.person] : null;
  const prenom = (person && person.p) || cd.p || '';
  const nom = (person && person.n) || cd.n || '';
  const nomNB = nbDash(nom);
  if (!prenom) return esc(nomNB);
  const short = abbreviatePrenom(prenom);
  return `<span class="cn-prenom-full">${esc(prenom)} </span><span class="cn-prenom-short">${esc(short)} </span>${esc(nomNB)}`;
}

/** Échappement HTML basique */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Détermine la liste des pages à produire pour un scrutin donné */
function pagesForElection(label, el, ctx) {
  // Cantonales/Départementales : 1 page par canton dans par_canton
  if (el.par_canton) {
    return Object.keys(el.par_canton).sort().map(cid => ({
      label,
      canton: cid,
      slug: slugifyElection(label) + '-canton-' + cid,
      title: label + ' — Canton de La Rochelle-' + cid,
    }));
  }
  return [{
    label,
    canton: null,
    slug: slugifyElection(label),
    title: label,
  }];
}

/** Récupère les bureaux d'une page (selon le canton si applicable) */
function sheetsForPage(label, el, canton, ctx) {
  if (canton && el.par_canton) {
    return el.par_canton[canton].sheets;
  }
  return el.sheets;
}

/** Agrège les votes ville pour un sheet donné (T1, T2, TU) */
function aggregateSheet(sheet) {
  const out = {
    inscrits: 0, exprimes: 0, abstention_voix: 0, bn_voix: 0,
    voix_par_cand: {}, // cid → voix entières totales
    nb_bureaux: 0,
  };
  Object.values(sheet || {}).forEach(bd => {
    if (!bd) return;
    out.nb_bureaux++;
    out.inscrits += (bd.i || 0);
    out.exprimes += (bd.e || 0);
    out.abstention_voix += Math.round((bd.i || 0) * (bd.a || 0) / 100);
    out.bn_voix += (bd.bn || 0);
    // Voix entières (depuis _voix posé par l'IIFE de donnees.js)
    if (bd._voix) {
      Object.entries(bd._voix).forEach(([cid, v]) => {
        out.voix_par_cand[cid] = (out.voix_par_cand[cid] || 0) + v;
      });
    }
  });
  return out;
}

/** Calcule le pct candidat ville (entiers / exprimés) */
function pctOf(voix, exprimes) {
  if (!exprimes) return 0;
  return +(voix / exprimes * 100).toFixed(1);
}

/** Agrège par quartier : utilise le libellé `q` tel qu'il est dans BUREAU_INFO pour
 *  l'ère donnée (pas de split "A/B"). Un quartier composé "Tasdon/Les Minimes"
 *  reste une seule entrée, fidèle au découpage de l'époque. */
function aggregateByQuartier(sheet, bureauInfo) {
  const out = {};
  Object.entries(sheet || {}).forEach(([ns, bd]) => {
    if (!bd) return;
    const info = bureauInfo[ns];
    if (!info || !info.q || info.q === 'Nul' || info.q === '?') return;
    const q = info.q;
    if (!out[q]) out[q] = { inscrits: 0, exprimes: 0, abstention_voix: 0, bn_voix: 0, voix_par_cand: {}, nb_bureaux: 0 };
    const agg = out[q];
    agg.nb_bureaux++;
    agg.inscrits += (bd.i || 0);
    agg.exprimes += (bd.e || 0);
    agg.abstention_voix += Math.round((bd.i || 0) * (bd.a || 0) / 100);
    agg.bn_voix += (bd.bn || 0);
    if (bd._voix) {
      Object.entries(bd._voix).forEach(([cid, v]) => {
        agg.voix_par_cand[cid] = (agg.voix_par_cand[cid] || 0) + v;
      });
    }
  });
  return out;
}

/** Agrège par canton : { canton_id → { ... } }
 *  cantonEra = ère canton à utiliser (ex. "2015") ; bureauInfo doit contenir bd.c (canton id) */
function aggregateByCanton(sheet, bureauInfo, cantonEra, cantonCorrespondances) {
  const out = {};
  // Si on a cantonCorrespondances (ère canton "2015" rétro-applicable), on l'utilise
  // pour rattacher les bureaux historiques aux cantons modernes.
  Object.entries(sheet || {}).forEach(([ns, bd]) => {
    if (!bd) return;
    const info = bureauInfo[ns];
    if (!info) return;
    let cantonIds = [];
    // 1. Match direct via info.c (le canton stocké pour cette ère)
    if (info.c) cantonIds.push(String(info.c));
    // 2. Match via correspondances rétroactives (canton moderne ↔ bureaux historiques)
    //    (utilisé pour les élections antérieures à l'ère canton donnée)
    if (cantonCorrespondances) {
      Object.entries(cantonCorrespondances).forEach(([key, eraMap]) => {
        // key = "<era_canton>:<cid>", on ne retient que ceux qui matchent cantonEra
        if (!key.startsWith(cantonEra + ':')) return;
        const cid = key.split(':')[1];
        // Si ce bureau est listé dans cette correspondance, l'ajouter
        Object.values(eraMap || {}).forEach(list => {
          if (Array.isArray(list) && list.includes(ns) && !cantonIds.includes(cid)) {
            cantonIds.push(cid);
          }
        });
      });
    }
    cantonIds.forEach(cid => {
      if (!out[cid]) out[cid] = { inscrits: 0, exprimes: 0, abstention_voix: 0, bn_voix: 0, voix_par_cand: {}, nb_bureaux: 0 };
      const agg = out[cid];
      agg.nb_bureaux++;
      agg.inscrits += (bd.i || 0);
      agg.exprimes += (bd.e || 0);
      agg.abstention_voix += Math.round((bd.i || 0) * (bd.a || 0) / 100);
      agg.bn_voix += (bd.bn || 0);
      if (bd._voix) {
        Object.entries(bd._voix).forEach(([cid2, v]) => {
          agg.voix_par_cand[cid2] = (agg.voix_par_cand[cid2] || 0) + v;
        });
      }
    });
  });
  return out;
}

/** Calcule la répartition par bloc politique (G, C, D, EXD, ?) en %, depuis voix entières */
function computeBlocsFromVoix(voixParCand, totalExprimes, candData, blocLegacy) {
  const out = { G: 0, C: 0, D: 0, EXD: 0, '?': 0 };
  if (!totalExprimes) return out;
  Object.entries(voixParCand).forEach(([cid, voix]) => {
    const cd = candData[cid] || {};
    let bloc = cd.b;
    if (!bloc && cd.bk && blocLegacy) bloc = blocLegacy[cd.bk];
    if (!bloc) bloc = '?';
    out[bloc] = (out[bloc] || 0) + voix;
  });
  // Convertir en pct
  Object.keys(out).forEach(k => {
    out[k] = +(out[k] / totalExprimes * 100).toFixed(1);
  });
  return out;
}

/** Trouve les scrutins voisins (précédent et suivant) du même type.
 *  - Pour les cantonales/départementales : on regroupe TOUTES les élections
 *    cantonales (cantonale, cantonales, départementale, départementales) et on
 *    filtre par `serie` si elle est définie (A vs B → on saute les scrutins
 *    de l'autre série dont les cantons sont disjoints). */
function adjacentElections(label, ELECTIONS, ctx) {
  const curEl = ELECTIONS[label] || {};
  const curYear = parseInt((label.match(/(\d{4})/) || [])[1] || 0);
  if (!curYear) return { prev: null, next: null };

  const isCantonal = ctx.isCantonalElection && ctx.isCantonalElection(label);
  let sameType;
  if (isCantonal) {
    sameType = Object.keys(ELECTIONS).filter(l => ctx.isCantonalElection(l));
    // Si l'élection courante a une série (A/B des cantonales pre-2015),
    // on filtre pour rester dans la même série — sinon les voisins auraient
    // des cantons disjoints.
    if (curEl.serie) {
      sameType = sameType.filter(l => {
        const e = ELECTIONS[l];
        return !e.serie || e.serie === curEl.serie;
      });
    }
  } else {
    // Préfixe avant le premier nombre
    const m = label.match(/^(.+?)\s*(\d{4})/);
    if (!m) return { prev: null, next: null };
    const type = m[1].trim();
    sameType = Object.keys(ELECTIONS).filter(k => {
      const km = k.match(/^(.+?)\s*(\d{4})/);
      return km && km[1].trim() === type;
    });
  }

  const sorted = sameType
    .map(k => ({ label: k, year: parseInt(k.match(/(\d{4})/)[1]) }))
    .sort((a, b) => a.year - b.year);
  const idx = sorted.findIndex(e => e.label === label);
  return {
    prev: idx > 0 ? sorted[idx - 1].label : null,
    next: idx >= 0 && idx < sorted.length - 1 ? sorted[idx + 1].label : null,
  };
}

/** URL Wikipédia (reprise de LRVcarte.getElectionWikipediaURL) */
function getElectionWikipediaURL(label) {
  if (!label) return null;
  const OVERRIDES = {
    'Référendum 2000': 'https://fr.wikipedia.org/wiki/R%C3%A9f%C3%A9rendum_fran%C3%A7ais_de_2000_sur_le_quinquennat',
    'Référendum 2005': 'https://fr.wikipedia.org/wiki/R%C3%A9f%C3%A9rendum_fran%C3%A7ais_sur_le_trait%C3%A9_%C3%A9tablissant_une_constitution_pour_l%27Europe',
    'Municipales 1995': 'https://fr.wikipedia.org/wiki/%C3%89lections_municipales_fran%C3%A7aises_de_1995',
    'Municipales 2001': 'https://fr.wikipedia.org/wiki/%C3%89lections_municipales_fran%C3%A7aises_de_2001',
    'Municipales 2008': 'https://fr.wikipedia.org/wiki/%C3%89lections_municipales_fran%C3%A7aises_de_2008',
    'Municipales 2014': 'https://fr.wikipedia.org/wiki/%C3%89lections_municipales_de_2014_%C3%A0_La_Rochelle',
    'Municipales 2020': 'https://fr.wikipedia.org/wiki/%C3%89lections_municipales_de_2020_%C3%A0_La_Rochelle',
    'Municipales 2026': 'https://fr.wikipedia.org/wiki/%C3%89lections_municipales_de_2026_%C3%A0_La_Rochelle',
    'Cantonale partielle 2002': null,
    'Cantonales 2001': 'https://fr.wikipedia.org/wiki/%C3%89lections_cantonales_fran%C3%A7aises_de_2001',
  };
  if (label in OVERRIDES) return OVERRIDES[label];
  const ym = label.match(/(\d{4})/);
  if (!ym) return null;
  const y = ym[1];
  const enc = s => encodeURIComponent(s).replace(/%20/g, '_');
  if (/^Présidentielle/i.test(label))   return 'https://fr.wikipedia.org/wiki/' + enc('Élection présidentielle française de ' + y);
  if (/^Européennes/i.test(label))      return 'https://fr.wikipedia.org/wiki/' + enc('Élections européennes de ' + y + ' en France');
  if (/^Législatives/i.test(label))     return 'https://fr.wikipedia.org/wiki/' + enc('Élections législatives de ' + y + ' en Charente-Maritime');
  if (/^Régionales/i.test(label)) {
    const region = parseInt(y) < 2015 ? 'Poitou-Charentes' : 'Nouvelle-Aquitaine';
    return 'https://fr.wikipedia.org/wiki/' + enc('Élections régionales de ' + y + ' en ' + region);
  }
  if (/^Cantonales/i.test(label))       return 'https://fr.wikipedia.org/wiki/' + enc('Élections cantonales de ' + y + ' en Charente-Maritime');
  if (/^Départementales/i.test(label))  return 'https://fr.wikipedia.org/wiki/' + enc('Élections départementales de ' + y + ' en Charente-Maritime');
  if (/^Référendum/i.test(label))       return 'https://fr.wikipedia.org/wiki/' + enc('Référendum français de ' + y);
  return null;
}

/** Dates connues des scrutins (dupliquées depuis daily-capture.js — à factoriser un jour) */
const DATES = {
  'Présidentielle 1988': { T1: '24 avril 1988', T2: '8 mai 1988' },
  'Présidentielle 1995': { T1: '23 avril 1995', T2: '7 mai 1995' },
  'Présidentielle 2002': { T1: '21 avril 2002', T2: '5 mai 2002' },
  'Présidentielle 2007': { T1: '22 avril 2007', T2: '6 mai 2007' },
  'Présidentielle 2012': { T1: '22 avril 2012', T2: '6 mai 2012' },
  'Présidentielle 2017': { T1: '23 avril 2017', T2: '7 mai 2017' },
  'Présidentielle 2022': { T1: '10 avril 2022', T2: '24 avril 2022' },
  'Législatives 1988':   { T1: '5 juin 1988',   T2: '12 juin 1988' },
  'Législatives 1993':   { T1: '21 mars 1993',  T2: '28 mars 1993' },
  'Législatives 1997':   { T1: '25 mai 1997',   T2: '1er juin 1997' },
  'Législatives 2002':   { T1: '9 juin 2002',   T2: '16 juin 2002' },
  'Législatives 2007':   { T1: '10 juin 2007',  T2: '17 juin 2007' },
  'Législatives 2012':   { T1: '10 juin 2012',  T2: '17 juin 2012' },
  'Législatives 2017':   { T1: '11 juin 2017',  T2: '18 juin 2017' },
  'Législatives 2022':   { T1: '12 juin 2022',  T2: '19 juin 2022' },
  'Législatives 2024':   { T1: '30 juin 2024',  T2: '7 juillet 2024' },
  'Municipales 1995':    { T1: '11 juin 1995',  T2: '18 juin 1995' },
  'Municipales 2001':    { T1: '11 mars 2001',  T2: '18 mars 2001' },
  'Municipales 2008':    { T1: '9 mars 2008',   T2: '16 mars 2008' },
  'Municipales 2014':    { T1: '23 mars 2014',  T2: '30 mars 2014' },
  'Municipales 2020':    { T1: '15 mars 2020',  T2: '28 juin 2020' },
  'Municipales 2026':    { T1: '15 mars 2026',  T2: '22 mars 2026' },
  'Européennes 1994':    { TU: '12 juin 1994' },
  'Européennes 1999':    { TU: '13 juin 1999' },
  'Européennes 2004':    { TU: '13 juin 2004' },
  'Européennes 2009':    { TU: '7 juin 2009' },
  'Européennes 2014':    { TU: '25 mai 2014' },
  'Européennes 2019':    { TU: '26 mai 2019' },
  'Européennes 2024':    { TU: '9 juin 2024' },
  'Référendum 2000':     { TU: '24 septembre 2000' },
  'Référendum 2005':     { TU: '29 mai 2005' },
  'Cantonales 2001':     { T1: '11 mars 2001', T2: '18 mars 2001' },
  'Cantonale partielle 2002': { T1: '22 septembre 2002', T2: '29 septembre 2002' },
  'Cantonales 2004':     { T1: '21 mars 2004', T2: '28 mars 2004' },
  'Cantonales 2008':     { T1: '9 mars 2008',  T2: '16 mars 2008' },
  'Cantonales 2011':     { T1: '20 mars 2011', T2: '27 mars 2011' },
  'Départementales 2015': { T1: '22 mars 2015', T2: '29 mars 2015' },
  'Départementales 2021': { T1: '20 juin 2021', T2: '27 juin 2021' },
  'Régionales 1992':     { TU: '22 mars 1992' },
  'Régionales 1998':     { TU: '15 mars 1998' },
  'Régionales 2004':     { T1: '21 mars 2004', T2: '28 mars 2004' },
  'Régionales 2010':     { T1: '14 mars 2010', T2: '21 mars 2010' },
  'Régionales 2015':     { T1: '6 décembre 2015', T2: '13 décembre 2015' },
  'Régionales 2021':     { T1: '20 juin 2021', T2: '27 juin 2021' },
};

// ─── Carte SVG inline ───────────────────────────────────────────────────────

/** Pour un binôme paritaire, retourne le tableau des persons réordonné avec
 *  la femme devant l'homme. Si pas de F clairement identifiée, on garde l'ordre
 *  d'origine (cas legacy où le champ s n'est pas renseigné). */
function orderedBinomePersons(cd, ctx) {
  if (!cd.binome || !Array.isArray(cd.binome)) return null;
  const persons = cd.binome.map(pid => ctx.PERSONS[pid] || {});
  let femaleIdx = -1;
  persons.forEach((p, i) => {
    if (p && p.s === 'F' && femaleIdx === -1) femaleIdx = i;
  });
  if (femaleIdx === 1) return [persons[1], persons[0]];
  return persons;
}

/** Résout un cid brut → cid normalisé présent dans CAND_DATA.
 *  Cas particulier : référendums où bd.w et bd._voix utilisent "Oui"/"Non"
 *  mais CAND_DATA est indexé par "oui@referendum-YYYY". */
function resolveCid(cid, electionLabel, ctx) {
  if (!cid) return cid;
  if (ctx.CAND_DATA[cid]) return cid;
  if (electionLabel) {
    const slug = slugifyElection(electionLabel);
    const candidate = cid.toLowerCase() + '@' + slug;
    if (ctx.CAND_DATA[candidate]) return candidate;
  }
  return cid;
}

/** Récupère la couleur d'un candidat :
 *  1. cd.c si défini
 *  2. Sinon, fallback sur un autre candidat du même parti `pa` qui a une couleur
 *  3. Sinon gris #bbbbbb
 *  Cache mémoïsé par cid + par parti. */
const _colorCache = new Map();
const _partiColorCache = new Map();
function colorOfCand(cid, ctx) {
  if (_colorCache.has(cid)) return _colorCache.get(cid);
  const cd = ctx.CAND_DATA[cid] || {};
  let col = null;
  if (cd.c) col = cd.c;
  // Cas binôme : règle paritaire — couleur de la candidate (sauf F=DV* et H=vrai)
  else if (cd.binome && cd.binome_partis) {
    // Trouver la femme (s='F')
    let femaleIdx = -1;
    cd.binome.forEach((pid, i) => {
      const p = ctx.PERSONS[pid];
      if (p && p.s === 'F' && femaleIdx === -1) femaleIdx = i;
    });
    // Exception : si F est DV* et H est un vrai parti → on prend H
    if (femaleIdx >= 0) {
      const paF = cd.binome_partis[femaleIdx];
      const paH = cd.binome_partis[1 - femaleIdx];
      if (/^DV/i.test(paF) && paH && !/^DV/i.test(paH)) {
        col = partiColor(paH, ctx);
      } else {
        col = partiColor(paF, ctx);
      }
    } else {
      // Pas de F connue, prendre le 1er vrai parti
      col = partiColor(cd.binome_partis.find(p => p && !/^DV/i.test(p)) || cd.binome_partis[0], ctx);
    }
  }
  else if (cd.pa) col = partiColor(cd.pa, ctx);
  const final = col || '#bbbbbb';
  _colorCache.set(cid, final);
  return final;
}

/** Pour un binôme à 2 vrais partis différents (aucun DV*), retourne [c1, c2]
 *  pour rendu bicolore. Sinon null (couleur unique via colorOfCand). */
function binomeBicolor(cid, ctx) {
  const cd = ctx.CAND_DATA[cid] || {};
  if (!cd.binome || !cd.binome_partis || cd.binome_partis.length !== 2) return null;
  const [pa1, pa2] = cd.binome_partis;
  if (!pa1 || !pa2 || pa1 === pa2) return null;
  if (/^DV/i.test(pa1) || /^DV/i.test(pa2)) return null;
  // Ordre paritaire : femme devant si sexes connus
  let femaleIdx = -1;
  cd.binome.forEach((pid, i) => {
    const p = ctx.PERSONS[pid];
    if (p && p.s === 'F' && femaleIdx === -1) femaleIdx = i;
  });
  const partis = femaleIdx === 1 ? [pa2, pa1] : [pa1, pa2];
  const c1 = partiColor(partis[0], ctx) || '#bbbbbb';
  const c2 = partiColor(partis[1], ctx) || '#bbbbbb';
  return [c1, c2];
}

/** Background CSS d'une barre de candidat : couleur unique ou gradient diagonal */
function barBackground(cid, ctx) {
  const bi = binomeBicolor(cid, ctx);
  if (bi) return `linear-gradient(135deg, ${bi[0]} 50%, ${bi[1]} 50%)`;
  return colorOfCand(cid, ctx);
}

/** Cherche la couleur représentative d'un parti via les candidats existants */
function partiColor(pa, ctx) {
  if (!pa) return null;
  if (_partiColorCache.has(pa)) return _partiColorCache.get(pa);
  // Parcourir CAND_DATA, prendre le premier candidat avec ce pa et une couleur
  let found = null;
  for (const [cid, cd] of Object.entries(ctx.CAND_DATA)) {
    if (cd.pa === pa && cd.c) { found = cd.c; break; }
  }
  _partiColorCache.set(pa, found);
  return found;
}

/** Bureau au format agrégé : "0017-19" → liste ['0017','0018','0019'].
 *  Présents sur l'ère 1988 pour les bureaux dont la géo n'a pas pu être déduite. */
function isAggregatedNum(num) {
  return /^\d{4}-\d{2}$/.test(num);
}
function aggregatedBureauList(num) {
  const m = num.match(/^(\d{2})(\d{2})-(\d{2})$/);
  if (!m) return [num];
  const prefix = m[1];
  const start = parseInt(m[2]);
  const end = parseInt(m[3]);
  const out = [];
  for (let i = start; i <= end; i++) {
    out.push(prefix + String(i).padStart(2, '0'));
  }
  return out;
}

/** Pour un sheet donné, retourne { numero → { color, winnerName, winnerPct } }.
 *  Les `numero` peuvent être agrégés (XXXX-YY) — dans ce cas on somme les voix
 *  des bureaux composants et on détermine un winner agrégé. */
function bureauColorsForSheet(sheet, ctx, electionLabel, geojson) {
  const out = {};

  // Détecte les ex-aequo : si plusieurs candidats sont strictement au même
  // nombre de voix entières que le leader, on les retourne tous (sinon null).
  function detectTie(voixMap) {
    const sorted = Object.entries(voixMap).sort((a, b) => b[1] - a[1]);
    if (sorted.length < 2 || sorted[0][1] === 0) return null;
    const maxV = sorted[0][1];
    const tied = sorted.filter(([, v]) => v === maxV);
    return tied.length >= 2 ? tied.map(([cid]) => cid) : null;
  }

  function nameAndPctFromCid(cid, sheet, voixMap, exprimes) {
    const w = resolveCid(cid, electionLabel, ctx);
    const cd = ctx.CAND_DATA[w] || {};
    const person = cd.person ? ctx.PERSONS[cd.person] : null;
    const winnerName = cd.binome
      ? orderedBinomePersons(cd, ctx).map(p => (p.p ? p.p + ' ' : '') + (p.n || '')).join(' / ')
      : ((person && person.p) || cd.p || '') + ' ' + ((person && person.n) || cd.n || cid);
    const voix = voixMap[cid] || 0;
    const pct = exprimes > 0 ? +(voix / exprimes * 100).toFixed(1) : 0;
    return { name: winnerName.trim(), pct, color: colorOfCand(w, ctx) };
  }

  // Helper : calcule la couleur d'un bureau (ou d'une zone agrégée) depuis un
  // ensemble de bureaux composants. Si la liste contient 1 bureau → direct.
  // Si plusieurs (agrégat) → on somme les _voix puis on cherche le winner.
  // Détecte aussi les ex-aequo (motif hachuré dans le SVG via `tiedColors`).
  function colorFor(bureauList) {
    if (!bureauList || !bureauList.length) return { color: '#eee', winnerName: '', winnerPct: 0 };
    // Agréger les voix des bureaux composants (taille 1 = cas normal, sinon agrégat)
    const sumVoix = {};
    let sumExprimes = 0;
    bureauList.forEach(ns => {
      const bd = sheet[ns];
      if (!bd) return;
      sumExprimes += (bd.e || 0);
      if (bd._voix) {
        Object.entries(bd._voix).forEach(([cid, v]) => {
          sumVoix[cid] = (sumVoix[cid] || 0) + v;
        });
      }
    });
    const sorted = Object.entries(sumVoix).sort((a, b) => b[1] - a[1]);
    if (!sorted.length) return { color: '#eee', winnerName: '', winnerPct: 0 };

    // Ex-aequo : plusieurs candidats au même nombre de voix max
    const tiedCids = detectTie(sumVoix);
    if (tiedCids) {
      const tiedInfos = tiedCids.map(cid => nameAndPctFromCid(cid, sheet, sumVoix, sumExprimes));
      return {
        color: null, // remplacé par un fill="url(#tie-XX)" au rendu SVG
        tiedColors: tiedInfos.map(t => t.color),
        winnerName: tiedInfos.map(t => t.name).join(' ▤ '),
        winnerPct: tiedInfos[0].pct,
        isTie: true,
      };
    }

    // Pas d'ex-aequo : winner unique (depuis voix agrégées)
    const [rawW, winnerVoix] = sorted[0];
    const w = resolveCid(rawW, electionLabel, ctx);
    const cd = ctx.CAND_DATA[w] || {};
    const person = cd.person ? ctx.PERSONS[cd.person] : null;
    const winnerName = cd.binome
      ? orderedBinomePersons(cd, ctx).map(p => (p.p ? p.p + ' ' : '') + (p.n || '')).join(' / ')
      : ((person && person.p) || cd.p || '') + ' ' + ((person && person.n) || cd.n || rawW);
    return {
      color: colorOfCand(w, ctx),
      winnerName: winnerName.trim(),
      winnerPct: sumExprimes > 0 ? +(winnerVoix / sumExprimes * 100).toFixed(1) : 0,
    };
  }

  // Si on a un geojson, on itère sur ses features (qui peuvent contenir des
  // numéros agrégés `0017-19` pour l'ère 1988).
  if (geojson && geojson.features) {
    geojson.features.forEach(f => {
      const num = f.properties && f.properties.numero;
      if (!num) return;
      if (isAggregatedNum(num)) {
        out[num] = colorFor(aggregatedBureauList(num));
      } else {
        out[num] = colorFor([num]);
      }
    });
  } else {
    // Fallback : itération directe sur le sheet (pas d'agrégats)
    Object.keys(sheet || {}).forEach(ns => { out[ns] = colorFor([ns]); });
  }
  return out;
}

/** Récupère le GeoJSON pour une ère donnée (ère 2026 = GEOJSON, autres = MAPS_DATA[era]) */
function getGeoJSONForEra(era, ctx) {
  if (era === '2026' || era === ctx.CURRENT_ERA) return ctx.GEOJSON;
  return (ctx.MAPS_DATA && ctx.MAPS_DATA[era]) || null;
}

/** Convertit un GeoJSON en SVG inline.
 *  - bureauColors : { numero → { color, winnerName, winnerPct } }
 *  - bureauInfo : pour les title hover (denomination, quartier)
 *  - highlightCantonId : si défini, on garde TOUS les bureaux de la ville mais on
 *    grise ceux qui ne sont pas dans ce canton (permet de se repérer)
 *  - filterBureaux : si défini (Set), ne garde que ces numéros
 *  - width / height : dimensions du viewport SVG
 */
function geoJSONtoSVG(geojson, bureauColors, bureauInfo, opts) {
  const { width = 600, height = 480, highlightCantonId, filterBureaux } = opts || {};
  if (!geojson || !geojson.features) return '';

  // Filtrer : seulement le bureau 0057 (non-géo) et les bureaux explicitement exclus
  let features = geojson.features.filter(f => {
    const num = f.properties && f.properties.numero;
    if (!num) return false;
    if (filterBureaux && !filterBureaux.has(num)) return false;
    // Bureau non-géographique 0057 (Français de l'étranger)
    if (num === '0057') return false;
    return true;
  });

  if (!features.length) return '';

  // Bounding box
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  function walkCoords(c) {
    if (typeof c[0] === 'number') {
      const [lon, lat] = c;
      if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
    } else {
      c.forEach(walkCoords);
    }
  }
  features.forEach(f => walkCoords(f.geometry.coordinates));

  // Projection plate-carrée avec ajustement aspect (lat à La Rochelle ≈ 46°)
  const latRad = (minLat + maxLat) / 2 * Math.PI / 180;
  const lonScale = Math.cos(latRad);
  const dLon = (maxLon - minLon) * lonScale;
  const dLat = (maxLat - minLat);
  const PAD = 8;
  const usableW = width - 2 * PAD;
  const usableH = height - 2 * PAD;
  const scale = Math.min(usableW / dLon, usableH / dLat);
  const projW = dLon * scale;
  const projH = dLat * scale;
  const offX = (width - projW) / 2;
  const offY = (height - projH) / 2;
  const proj = (lon, lat) => {
    const x = offX + (lon - minLon) * lonScale * scale;
    const y = offY + (maxLat - lat) * scale; // y inversé (SVG)
    return [x, y];
  };

  function ringToPath(ring) {
    return ring.map((c, i) => {
      const [x, y] = proj(c[0], c[1]);
      return (i === 0 ? 'M' : 'L') + x.toFixed(2) + ',' + y.toFixed(2);
    }).join(' ') + ' Z';
  }
  function polygonToPath(coords) {
    // coords = array of rings (outer + holes)
    return coords.map(ringToPath).join(' ');
  }
  function geomToPath(geom) {
    if (geom.type === 'Polygon') return polygonToPath(geom.coordinates);
    if (geom.type === 'MultiPolygon') return geom.coordinates.map(polygonToPath).join(' ');
    return '';
  }

  // Générer les paths
  // - data-num : numéro du bureau (pour le tooltip JS)
  // - data-name : dénomination + winner (pour le tooltip JS)
  // - <title> en fallback pour user no-JS
  // - opacity réduite + couleur grisée pour les bureaux hors-canton (page canton)
  // Collecter les patterns pour les ex-aequo et leur attribuer un id unique
  const tiePatterns = [];
  function tieFillFor(num, tiedColors) {
    const id = 'tie-' + num.replace(/[^0-9-]/g, '');
    tiePatterns.push({ id, colors: tiedColors });
    return 'url(#' + id + ')';
  }

  const paths = features.map(f => {
    const num = f.properties.numero;
    const info = bureauInfo[num] || {};
    const inCanton = !highlightCantonId || String(info.c) === String(highlightCantonId);
    const colorData = bureauColors[num] || { color: '#eee', winnerName: '', winnerPct: 0 };
    // Si ex-aequo (et bureau in canton), utiliser un pattern hachuré ; sinon couleur unie ; hors canton, gris.
    let fillColor;
    if (!inCanton) {
      fillColor = '#dcd6cc';
    } else if (colorData.isTie && colorData.tiedColors) {
      fillColor = tieFillFor(num, colorData.tiedColors);
    } else {
      fillColor = colorData.color;
    }
    const d = geomToPath(f.geometry);
    // Pour les bureaux agrégés "0017-19", on affiche "n° 17 à 19 (zone agrégée)"
    // sinon le numéro simple.
    let numLabel, numDataAttr;
    if (isAggregatedNum(num)) {
      const list = aggregatedBureauList(num);
      numLabel = 'Bureaux ' + parseInt(list[0]) + ' à ' + parseInt(list[list.length - 1]) + ' (zone agrégée)';
      numDataAttr = parseInt(list[0]) + '–' + parseInt(list[list.length - 1]);
    } else {
      numLabel = 'Bureau n°' + parseInt(num);
      numDataAttr = String(parseInt(num));
    }
    const denom = info.den || info.nom || (f.properties.denomination) || (f.properties.nom) || '';
    const winnerLine = inCanton && colorData.winnerName
      ? `${colorData.winnerName} (${colorData.winnerPct.toFixed(1).replace('.', ',')} %)`
      : '';
    const tipText = `${numLabel}${denom ? ' · ' + denom : ''}`
      + (winnerLine ? ` — ${winnerLine}` : (inCanton ? '' : ' (hors canton)'));
    return `<path d="${d}" fill="${fillColor}" stroke="#fff" stroke-width="0.6"`
      + (inCanton ? '' : ' class="off-canton"')
      + ` data-num="${esc(numDataAttr)}" data-den="${esc(denom)}" data-winner="${esc(winnerLine || (inCanton ? '' : 'Hors canton'))}"`
      + (isAggregatedNum(num) ? ' data-agg="1"' : '')
      + `><title>${esc(tipText)}</title></path>`;
  }).join('');

  // Patterns hachurés pour les ex-aequo : pour chaque bureau tied, 2 (ou n) bandes diagonales colorées
  const defs = tiePatterns.length ? '<defs>' + tiePatterns.map(tp => {
    const colors = tp.colors;
    const n = colors.length;
    const tileSize = 6; // 6px de pattern = bandes assez visibles à toute échelle
    const stripeW = tileSize / n;
    const rects = colors.map((c, i) => `<rect x="${(i*stripeW).toFixed(2)}" width="${stripeW.toFixed(2)}" height="${tileSize}" fill="${c}"/>`).join('');
    return `<pattern id="${tp.id}" width="${tileSize}" height="${tileSize}" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">${rects}</pattern>`;
  }).join('') + '</defs>' : '';

  return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" class="s-mini-map" role="img" aria-label="Carte des bureaux de vote">${defs}${paths}</svg>`;
}

// ─── Construction des données d'une page ────────────────────────────────────

function buildPageData(pageSpec, ctx) {
  const { label, canton } = pageSpec;
  const el = ctx.ELECTIONS[label];
  const sheets = sheetsForPage(label, el, canton, ctx);
  const tours = Object.keys(sheets).filter(t => sheets[t]);

  const isReferendum = ctx.isReferendum(label);
  const isCantonale = ctx.isCantonalElection(label);
  const era = el.my || ctx.CURRENT_ERA;
  const bureauInfo = ctx.BUREAU_INFO[era] || {};
  // Filtrer les bureaux non géographiques (bureau 0057 — Français de l'étranger)
  const NON_GEO = new Set(['0057']);
  const filteredBureauInfo = {};
  Object.entries(bureauInfo).forEach(([ns, b]) => {
    if (!NON_GEO.has(ns)) filteredBureauInfo[ns] = b;
  });

  // Scrutins voisins (même type) — utiles pour le triptych
  const adj = adjacentElections(label, ctx.ELECTIONS, ctx);

  // Pour chaque tour, agréger ville
  const byTour = {};
  tours.forEach(t => {
    const agg = aggregateSheet(sheets[t]);
    // Construire le tableau des candidats avec leurs voix et pct
    const cands = Object.entries(agg.voix_par_cand).map(([rawCid, voix]) => {
      const cid = resolveCid(rawCid, label, ctx);
      const cd = ctx.CAND_DATA[cid] || {};
      // Nom à afficher : binôme (femme devant) ou individu. Tirets non-breaking
      // dans les noms composés pour éviter les cassures laides en fin de ligne.
      let displayName, nomFamille;
      if (cd.binome && Array.isArray(cd.binome)) {
        const persons = orderedBinomePersons(cd, ctx);
        displayName = persons.map(p => (p.p ? nbDash(p.p) + ' ' : '') + nbDash(p.n || '')).join(' / ');
        nomFamille = persons.map(p => nbDash(p.n || '')).join(' / ');
      } else {
        const person = cd.person ? ctx.PERSONS[cd.person] : null;
        const prenom = (person && person.p) || cd.p || '';
        const nom    = (person && person.n) || cd.n || cid;
        displayName  = (prenom ? nbDash(prenom) + ' ' : '') + nbDash(nom);
        nomFamille = nbDash(nom);
      }
      // Étiquette parti : pour les binômes hétérogènes, "PA_F+PA_H"
      let paLabel = cd.pa || '';
      if (cd.binome && cd.binome_partis && cd.binome_partis.length === 2) {
        const [p1, p2] = cd.binome_partis;
        if (p1 && p2 && p1 !== p2 && !/^DV/i.test(p1) && !/^DV/i.test(p2)) {
          let femaleIdx = -1;
          cd.binome.forEach((pid, i) => {
            const p = ctx.PERSONS[pid];
            if (p && p.s === 'F' && femaleIdx === -1) femaleIdx = i;
          });
          paLabel = femaleIdx === 1 ? p2 + '+' + p1 : p1 + '+' + p2;
        }
      }
      // Nom complet du parti (depuis PARTI_NAMES)
      const paFull = paLabel.indexOf('+') >= 0
        ? paLabel.split('+').map(c => (ctx.PARTI_NAMES && ctx.PARTI_NAMES[c]) || c).join(' + ')
        : ((ctx.PARTI_NAMES && ctx.PARTI_NAMES[paLabel]) || paLabel);
      return {
        cid,
        nom: displayName,
        nomFamille,
        nameHTML: candNameHTML(cd, ctx),
        pa: paLabel,
        paFull,
        bloc: cd.b || '',
        voix,
        pct: pctOf(voix, agg.exprimes),
        barBg: barBackground(cid, ctx),
      };
    }).sort((a, b) => b.voix - a.voix);

    const abst_pct = agg.inscrits > 0
      ? +(agg.abstention_voix / agg.inscrits * 100).toFixed(1)
      : 0;
    const votants = agg.inscrits - agg.abstention_voix;
    const bn_pct = votants > 0 ? +(agg.bn_voix / votants * 100).toFixed(1) : 0;

    // Agrégation quartiers (utilisation de bd._voix)
    const parQuartier = aggregateByQuartier(sheets[t], filteredBureauInfo);
    const quartiers = Object.entries(parQuartier).map(([qName, qAgg]) => {
      const qCands = Object.entries(qAgg.voix_par_cand)
        .map(([rawCid, voix]) => {
          const cid = resolveCid(rawCid, label, ctx);
          const cd = ctx.CAND_DATA[cid] || {};
          let displayName, nomFamille;
          if (cd.binome) {
            const persons = orderedBinomePersons(cd, ctx);
            displayName = persons.map(p => (p.p ? nbDash(p.p) + ' ' : '') + nbDash(p.n || '')).join(' / ');
            nomFamille = persons.map(p => nbDash(p.n || '')).join(' / ');
          } else {
            const person = cd.person ? ctx.PERSONS[cd.person] : null;
            const prenom = (person && person.p) || cd.p || '';
            const nom = (person && person.n) || cd.n || cid;
            displayName = (nbDash(prenom) + ' ' + nbDash(nom)).trim();
            nomFamille = nbDash(nom);
          }
          return { cid, nom: displayName, nomFamille, pa: cd.pa || '', voix, pct: pctOf(voix, qAgg.exprimes), color: colorOfCand(cid, ctx) };
        })
        .sort((a, b) => b.voix - a.voix);
      const abst_pct_q = qAgg.inscrits > 0 ? +(qAgg.abstention_voix / qAgg.inscrits * 100).toFixed(1) : 0;
      const blocs = computeBlocsFromVoix(qAgg.voix_par_cand, qAgg.exprimes, ctx.CAND_DATA, ctx.BLOC_LEGACY);
      return { nom: qName, ...qAgg, abst_pct: abst_pct_q, winner: qCands[0] || null, blocs };
    }).sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));

    // Agrégation cantons (seulement pour les pages non-canton)
    let cantons = [];
    if (!canton) {
      const cantonEra = ctx.getCantonEraForElection ? ctx.getCantonEraForElection(label) : (el.my_canton || ctx.CURRENT_ERA_CANTON);
      const parCanton = aggregateByCanton(sheets[t], filteredBureauInfo, cantonEra, ctx.CANTON_CORRESPONDANCES);
      cantons = Object.entries(parCanton).map(([cid, cAgg]) => {
        const cCands = Object.entries(cAgg.voix_par_cand)
          .map(([rawCid2, voix]) => {
            const cid2 = resolveCid(rawCid2, label, ctx);
            const cd = ctx.CAND_DATA[cid2] || {};
            let displayName, nomFamille;
            if (cd.binome) {
              const persons = orderedBinomePersons(cd, ctx);
              displayName = persons.map(p => (p.p ? nbDash(p.p) + ' ' : '') + nbDash(p.n || '')).join(' / ');
              nomFamille = persons.map(p => nbDash(p.n || '')).join(' / ');
            } else {
              const person = cd.person ? ctx.PERSONS[cd.person] : null;
              const prenom = (person && person.p) || cd.p || '';
              const nom = (person && person.n) || cd.n || cid2;
              displayName = (nbDash(prenom) + ' ' + nbDash(nom)).trim();
              nomFamille = nbDash(nom);
            }
            return { cid: cid2, nom: displayName, nomFamille, pa: cd.pa || '', voix, pct: pctOf(voix, cAgg.exprimes), color: colorOfCand(cid2, ctx) };
          })
          .sort((a, b) => b.voix - a.voix);
        const abst_pct_c = cAgg.inscrits > 0 ? +(cAgg.abstention_voix / cAgg.inscrits * 100).toFixed(1) : 0;
        const blocs = computeBlocsFromVoix(cAgg.voix_par_cand, cAgg.exprimes, ctx.CAND_DATA, ctx.BLOC_LEGACY);
        return { cid, era: cantonEra, ...cAgg, abst_pct: abst_pct_c, winner: cCands[0] || null, blocs };
      }).sort((a, b) => parseInt(a.cid) - parseInt(b.cid));
    }

    // Blocs ville (ou canton si page canton) — pour le scrutin courant
    const blocs = computeBlocsFromVoix(agg.voix_par_cand, agg.exprimes, ctx.CAND_DATA, ctx.BLOC_LEGACY);

    // Helper : récupère les blocs pour un autre scrutin (au même niveau ville/canton)
    // Préférence d'appariement T1↔T1, T2↔T2, TU↔TU — avec fallback si le voisin
    // n'a pas le même tour (ex. élection T1+T2 vs élection TU).
    function blocsForLabel(otherLabel, currentTour) {
      if (!otherLabel) return null;
      const otherEl = ctx.ELECTIONS[otherLabel];
      if (!otherEl) return null;
      let otherSheets;
      if (canton && otherEl.par_canton) {
        if (!otherEl.par_canton[canton]) return null; // série incompatible
        otherSheets = otherEl.par_canton[canton].sheets;
      } else if (!canton && !otherEl.par_canton) {
        otherSheets = otherEl.sheets;
      } else {
        return null; // niveaux incompatibles
      }
      if (!otherSheets) return null;
      // Ordre de priorité : même tour d'abord, puis fallback raisonnable
      const tourPriority = currentTour === 'T1' ? ['T1', 'TU', 'T2']
                         : currentTour === 'T2' ? ['T2', 'TU', 'T1']
                         : ['TU', 'T1', 'T2'];
      let otherSheet = null;
      for (const tk of tourPriority) {
        if (otherSheets[tk]) { otherSheet = otherSheets[tk]; break; }
      }
      if (!otherSheet) return null;
      const oa = aggregateSheet(otherSheet);
      return computeBlocsFromVoix(oa.voix_par_cand, oa.exprimes, ctx.CAND_DATA, ctx.BLOC_LEGACY);
    }
    const prevBlocs = adj.prev ? blocsForLabel(adj.prev, t) : null;
    const nextBlocs = adj.next ? blocsForLabel(adj.next, t) : null;

    // Carte SVG inline pour ce tour
    const geo = getGeoJSONForEra(era, ctx);
    const bureauColors = bureauColorsForSheet(sheets[t], ctx, label, geo);
    // Pour les pages canton : on affiche TOUTE la ville mais on grise les bureaux
    // hors canton, pour permettre au lecteur de se repérer géographiquement.
    // bureauColors ne contient que les bureaux du canton (sheets[t] est filtré
    // par canton dans par_canton) — il faut donc passer la BUREAU_INFO ENTIÈRE
    // (filtrée juste pour exclure 0057), pas seulement les bureaux du canton.
    const fullBureauInfo = filteredBureauInfo; // déjà filtré sur l'ère, sans 0057
    const mapSVG = geo ? geoJSONtoSVG(geo, bureauColors, fullBureauInfo, {
      width: 600, height: 480,
      highlightCantonId: canton || null,
    }) : '';

    byTour[t] = {
      ...agg,
      abst_pct,
      bn_pct,
      votants,
      cands,
      winner: cands[0] || null,
      quartiers,
      cantons,
      blocs,
      prevBlocs,
      nextBlocs,
      mapSVG,
    };
  });

  // Dates du scrutin
  const dates = DATES[label] || {};

  // URL Wikipédia
  const wpUrl = getElectionWikipediaURL(label);

  return {
    label,
    canton,
    title: pageSpec.title,
    slug: pageSpec.slug,
    el,
    isReferendum,
    isCantonale,
    tours,
    byTour,
    adj,
    dates,
    wpUrl,
  };
}

// ─── Template HTML ──────────────────────────────────────────────────────────

function renderHTML(data, opts) {
  const { label, title, tours, byTour, isReferendum, isCantonale, canton, el, adj, dates, wpUrl } = data;
  const tourLabel = t => t === 'TU' ? 'Tour unique' : t === 'T2' ? '2ᵉ tour' : '1ᵉʳ tour';
  const fmtPct = p => (p == null ? '0,0' : p.toFixed(1).replace('.', ','));
  const fmtNum = n => (n == null ? '0' : Number(n).toLocaleString('fr-FR'));

  // Slug d'un scrutin voisin, en tenant compte du canton courant si applicable.
  // - Si voisin = cantonale et on est sur une page canton :
  //     • même cid présent dans le voisin → lien vers ce canton
  //     • sinon → null (pas de lien, série différente / découpage incompatible)
  // - Si voisin = cantonale et on est sur une page ville → null (lien ambigu)
  // - Sinon → slug simple.
  const neighborSlug = (neighborLabel, currentCanton) => {
    const baseSlug = slugifyElection(neighborLabel);
    const neighborEl = opts.ctx ? opts.ctx.ELECTIONS[neighborLabel] : null;
    if (neighborEl && neighborEl.par_canton) {
      if (!currentCanton) return null;
      if (neighborEl.par_canton[currentCanton]) {
        return baseSlug + '-canton-' + currentCanton;
      }
      return null;
    }
    return baseSlug;
  };

  // Description SEO : un texte court avec le top 3 et l'abstention du dernier tour
  const lastTour = tours[tours.length - 1];
  const td = byTour[lastTour];
  const top3 = (td.cands || []).slice(0, 3).map(c => c.nom + ' (' + fmtPct(c.pct) + ' %)').join(', ');
  const metaDesc = `Résultats détaillés de ${label}${canton ? ' — canton La Rochelle-' + canton : ''} à La Rochelle, bureau par bureau. Top 3 : ${top3}. Abstention : ${fmtPct(td.abst_pct)} %.`;

  // Date du scrutin (pour le lead)
  const datesArr = tours.map(t => dates[t]).filter(Boolean);
  const dateLead = datesArr.length === 1
    ? `Scrutin du ${datesArr[0]}.`
    : datesArr.length === 2
      ? `Scrutin des ${datesArr[0]} et ${datesArr[1]}.`
      : '';

  // Slug URL pour les liens cohérents — sans `tab=global`, pour ouvrir la carte
  // directement (et pas la modale fiche globale) sur l'élection sélectionnée.
  const urlCarte = '/LRVcarte.html#election=' + encodeURIComponent(label) + (canton ? '&canton=' + canton : '');
  const urlAnalyse = '/LRVanalyse.html#level=' + (canton ? 'canton&canton=' + canton : 'ville') + '&election=' + encodeURIComponent(label);

  // Couleurs et libellés des blocs politiques (source de vérité = ctx.BLOC_CONFIG depuis donnees.js)
  const BC = opts.ctx && opts.ctx.BLOC_CONFIG ? opts.ctx.BLOC_CONFIG : {};
  const BLOC_COLORS = {
    G:   (BC.G && BC.G.color)   || '#CC0100',
    C:   (BC.C && BC.C.color)   || '#F1C232',
    D:   (BC.D && BC.D.color)   || '#0F55CC',
    EXD: (BC.EXD && BC.EXD.color) || '#20124D',
    '?': (BC['?'] && BC['?'].color) || '#A0E1E2',
  };
  const BLOC_LABELS = {
    G:   (BC.G && BC.G.label)   || 'Gauche',
    C:   (BC.C && BC.C.label)   || 'Centre',
    D:   (BC.D && BC.D.label)   || 'Droite',
    EXD: (BC.EXD && BC.EXD.label) || 'Extrême droite',
    '?': (BC['?'] && BC['?'].label) || 'Divers',
  };

  /** Rendu d'une barre empilée par blocs (segments de couleur) */
  function renderBlocBar(blocs, height) {
    const order = ['G', 'C', 'D', 'EXD', '?'];
    const total = order.reduce((s, b) => s + (blocs[b] || 0), 0) || 1;
    const segs = order
      .filter(b => (blocs[b] || 0) > 0)
      .map(b => `<div class="bb-seg" title="${BLOC_LABELS[b]} : ${fmtPct(blocs[b])} %" style="width:${((blocs[b]||0)/total*100).toFixed(2)}%;background:${BLOC_COLORS[b]}"></div>`)
      .join('');
    return `<div class="bb" style="height:${height}px">${segs}</div>`;
  }

  /** Segments de blocs en flex, à insérer dans un container avec hauteur fixée */
  function renderBlocSegs(blocs) {
    const order = ['G', 'C', 'D', 'EXD', '?'];
    const total = order.reduce((s, b) => s + (blocs[b] || 0), 0) || 1;
    return order
      .filter(b => (blocs[b] || 0) > 0)
      .map(b => `<div class="bb-seg" title="${BLOC_LABELS[b]} : ${fmtPct(blocs[b])} %" style="width:${((blocs[b]||0)/total*100).toFixed(2)}%;background:${BLOC_COLORS[b]}"></div>`)
      .join('');
  }

  /** Segments Oui/Non pour les référendums (à partir d'un voix_par_cand) */
  function renderRefSegs(voixParCand, exprimes) {
    if (!exprimes) return '';
    // Trouver les voix Oui et Non (clés brutes ou résolues)
    let ouiVoix = 0, nonVoix = 0;
    Object.entries(voixParCand).forEach(([k, v]) => {
      const kl = k.toLowerCase();
      if (kl === 'oui' || kl.startsWith('oui@')) ouiVoix += v;
      else if (kl === 'non' || kl.startsWith('non@')) nonVoix += v;
    });
    const tot = ouiVoix + nonVoix || 1;
    const ouiPct = +(ouiVoix / exprimes * 100).toFixed(1);
    const nonPct = +(nonVoix / exprimes * 100).toFixed(1);
    let segs = '';
    if (ouiVoix > 0) segs += `<div class="bb-seg" title="Oui : ${fmtPct(ouiPct)} %" style="width:${(ouiVoix/tot*100).toFixed(2)}%;background:#0F8A8A"></div>`;
    if (nonVoix > 0) segs += `<div class="bb-seg" title="Non : ${fmtPct(nonPct)} %" style="width:${(nonVoix/tot*100).toFixed(2)}%;background:#8E2C5C"></div>`;
    return segs;
  }

  // Avertissement canton hors LR (ère 1985 → cantons 5, 8, 9)
  let cantonWarning = '';
  if (canton) {
    const cantonEra = el.my_canton || '2015';
    if (cantonEra === '1985') {
      const warnings = {
        '5': 'Le canton La Rochelle-5 (1985) comprenait aussi les communes de Puilboreau, Saint-Xandre, Marsilly et Esnandes. Cette page ne présente que la totalisation de la partie rochelaise du canton.',
        '8': 'Le canton La Rochelle-8 (1985) comprenait aussi les communes de Périgny et Dompierre-sur-Mer. Cette page ne présente que la totalisation de la partie rochelaise du canton.',
        '9': 'Le canton La Rochelle-9 (1985) comprenait aussi les communes de L\'Houmeau, Lagord et Nieul-sur-Mer. Cette page ne présente que la totalisation de la partie rochelaise du canton.',
      };
      if (warnings[canton]) cantonWarning = warnings[canton];
    }
  }

  // Date de génération
  const now = new Date();
  const fmtDate = now.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script>
  /* Force la vue mobile (viewport=720) si le flag localStorage est activé. */
  (function () {
    try {
      if (localStorage.getItem('lrvote_force_mobile') === '1') {
        document.querySelector('meta[name=viewport]').setAttribute('content', 'width=720, user-scalable=yes');
      }
    } catch (_) {}
  })();
</script>
<title>${esc(title)} à La Rochelle — Résultats bureau par bureau — La Rochelle Vote</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<meta name="description" content="${esc(metaDesc)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="La Rochelle Vote">
<meta property="og:locale" content="fr_FR">
<meta property="og:title" content="${esc(title)} à La Rochelle — Résultats bureau par bureau">
<meta property="og:description" content="${esc(metaDesc)}">
<meta property="og:image" content="https://larochellevote.fr/share.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:url" content="https://larochellevote.fr/scrutins/${data.slug}.html">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@LaRochelleVote">
<meta name="twitter:title" content="${esc(title)} à La Rochelle — Résultats bureau par bureau">
<meta name="twitter:description" content="${esc(metaDesc)}">
<meta name="twitter:image" content="https://larochellevote.fr/share.png">
<link rel="canonical" href="https://larochellevote.fr/scrutins/${data.slug}.html">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
<script>
  /* Theme bootstrap (anti-FOUC) */
  (function(){
    try {
      var t = localStorage.getItem('lrvote_theme');
      if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    } catch(e) {}
  })();
</script>
<link rel="stylesheet" href="/shared.css"/>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; }
:root {
  --bg-chrome: #F7F3EE; --bg-chrome-hover: #FAF6F0; --bg-chrome-accent: #EFE8DD;
  --text-chrome: #1A1A1A; --text-chrome-muted: #5A5A5A; --border-chrome: #E6DFD5;
  --bg-page: #F0EAE0; --bg-card: #FFFFFF; --bg-blockquote: #FBF7EE;
  --text-body: #2A2A2A; --accent-warm: #B49B7E;
  /* Variables utilisées par les composants partagés (menu burger, share modal, Cmd+K) */
  --bg-modal: #FFFFFF; --border-modal: #E6DFD5;
  --bg-modal-hover: #FAF6F0; --bg-modal-accent: #EFE8DD;
  --text-modal: #1A1A1A; --text-modal-muted: #5A5A5A;
  --bg-tooltip: #1A1A1A; --text-tooltip: #F7F3EE;
  --bg-active: #1A1A1A; --text-active: #FFFFFF;
}
[data-theme="dark"] {
  --bg-chrome: #16151A; --bg-chrome-hover: #2D2A30; --bg-chrome-accent: #383438;
  --text-chrome: #ECE6DD; --text-chrome-muted: #9D968B; --border-chrome: #2D2A30;
  --bg-page: #0F0E13; --bg-card: #21202A; --bg-blockquote: rgba(180, 155, 126, 0.08);
  --text-body: #D8D2C7; --accent-warm: #C9A878;
  --bg-modal: #21202A; --border-modal: #3A3640;
  --bg-modal-hover: #2D2C36; --bg-modal-accent: #3A3640;
  --text-modal: #ECE6DD; --text-modal-muted: #9D968B;
  --bg-tooltip: #ECE6DD; --text-tooltip: #16151A;
  --bg-active: #8A7758; --text-active: #ECE6DD;
}
body { font-family: 'Space Grotesk', system-ui, sans-serif; background: var(--bg-page); color: var(--text-chrome); -webkit-font-smoothing: antialiased; display: flex; flex-direction: column; min-height: 100vh; }
/* ── Topbar (mêmes styles que LRVcarte / methodologie) ── */
#topbar { background: var(--bg-chrome); color: var(--text-chrome); display: flex; align-items: center; gap: 16px; padding: 0 24px; height: 66px; flex-shrink: 0; z-index: 50; border-bottom: 1px solid var(--border-chrome); }
.tb-logo { display: flex; align-items: center; gap: 4px; text-decoration: none; color: inherit; flex-shrink: 0; background: none; border: none; padding: 0; margin: 0; cursor: pointer; font-family: inherit; font-size: 2.1rem; line-height: 1; align-items: baseline; }
.tb-brand-light, .tb-brand-bold { letter-spacing: -0.02em; white-space: nowrap; }
.tb-brand-light { font-size: 0.95em; font-weight: 400; }
.tb-brand-bold { font-weight: 700; }
.tb-logo:hover .tb-brand-bold, .tb-logo:hover .tb-brand-light { opacity: 0.7; }
.tb-logo-burger { width: 16px; height: 16px; color: var(--text-chrome-muted); margin-right: 6px; align-self: center; transition: color .15s; }
.tb-logo:hover .tb-logo-burger { color: var(--text-chrome); }
.tb-logo[aria-expanded="true"] .tb-logo-burger { color: var(--text-chrome); }
.sail-mini { width: 1cap; height: 1cap; display: flex; flex-direction: column; align-items: flex-end; gap: 1px; flex-shrink: 0; align-self: center; }
[data-theme="dark"] .sail-mini { filter: drop-shadow(0 0 1.5px rgba(236,230,221,0.35)); }
.sail-mini .sail-row { position: relative; width: var(--w); height: calc((100% - 5px) / 6); background-color: var(--c1, #CC0100); overflow: hidden; }
.sail-mini .sail-row::after { content: ''; position: absolute; inset: 0; background-color: var(--c2, #F1C232); clip-path: inset(0 0 0 100%); transition: clip-path 0.55s cubic-bezier(0.33, 0, 0.4, 1); }
.sail-mini .sail-row.sliding::after { clip-path: inset(0 0 0 0%); }
.sail-mini .sail-row.no-trans::after { transition: none; }
.tb-search-btn { background: none; border: 1px solid var(--border-chrome); border-radius: 6px; width: 30px; height: 30px; cursor: pointer; color: var(--text-chrome-muted); transition: all .15s; display: flex; align-items: center; justify-content: center; padding: 0; flex-shrink: 0; }
.tb-search-btn:hover { background: var(--bg-chrome-hover); color: var(--text-chrome); }
.tb-search-btn svg { width: 15px; height: 15px; }
.tb-nav { display: flex; align-items: center; gap: 22px; flex-shrink: 0; }
.tb-nav-link { font-size: .86rem; font-weight: 500; color: var(--text-chrome-muted); text-decoration: none; padding: 4px 0; border-bottom: 2px solid transparent; transition: color .15s, border-color .15s; }
.tb-nav-link:hover { color: var(--text-chrome); }
main.scrutin { flex: 1; padding: 50px 24px 60px; display: flex; justify-content: center; }
.s-wrap { width: 100%; max-width: 880px; display: flex; flex-direction: column; gap: 28px; }
header.s-head { border-bottom: 1px solid var(--border-chrome); padding-bottom: 24px; }
header.s-head .eyebrow { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.12em; color: var(--accent-warm); margin-bottom: 10px; }
header.s-head h1 { font-size: 2.2rem; font-weight: 700; letter-spacing: -0.025em; line-height: 1.15; margin-bottom: 14px; }
header.s-head .lead { font-size: 1.02rem; color: var(--text-chrome-muted); line-height: 1.55; max-width: 700px; }
section.s-block { display: flex; flex-direction: column; gap: 14px; }
section.s-block h2 { font-size: 1.4rem; font-weight: 700; letter-spacing: -0.02em; border-bottom: 2px solid var(--text-chrome); padding-bottom: 8px; }
section.s-block h3 { font-size: 1.08rem; font-weight: 600; margin-top: 8px; color: var(--text-chrome); }
section.s-block p { font-size: 1rem; line-height: 1.6; color: var(--text-body); }
/* Participation : layout identique à la fiche globale ville (LRVcarte particiHTML) */
.partici-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 5px; margin-bottom: 0; }
.pbox { background: var(--bg-modal-hover); border-radius: 6px; padding: 8px 8px; min-width: 0; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 3px; }
.pbox-lbl { font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.4px; color: var(--text-chrome-muted); font-weight: 700; white-space: nowrap; }
.pbox-val { font-size: 0.92rem; font-weight: 800; color: var(--text-chrome); line-height: 1.1; white-space: nowrap; }
.s-table { width: 100%; border-collapse: collapse; background: var(--bg-card); border: 1px solid var(--border-chrome); border-radius: 8px; overflow: hidden; }
.s-table thead { background: var(--bg-chrome-accent); }
.s-table th { font-size: 0.74rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-chrome-muted); text-align: left; padding: 10px 14px; }
.s-table th.num { text-align: right; }
.s-table td { padding: 10px 14px; font-size: 0.94rem; border-top: 1px solid var(--border-chrome); }
.s-table td.num { text-align: right; font-variant-numeric: tabular-nums; }
.s-table .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 8px; vertical-align: middle; }
.s-table .winner { font-weight: 700; }
.s-warn { background: #FFF7E6; border: 1px solid #E6C77E; color: #8A6A2C; padding: 12px 16px; border-radius: 6px; font-size: 0.9rem; line-height: 1.5; font-style: italic; }
/* Lignes candidat·e — reproduit le style cand-row de LRVcarte */
.s-cands { background: var(--bg-modal-hover); border-radius: 8px; padding: 16px 18px; }
.cand-list { display: flex; flex-direction: column; gap: 14px; }
.cand-row { display: flex; flex-direction: column; gap: 6px; }
.cand-row-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 10px; }
.cand-row-namepart { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.cand-name { font-size: 1.15rem; font-weight: 700; line-height: 1.1; color: var(--text-chrome); min-width: 0; }
.cand-row.winner .cand-name { font-weight: 800; }
.cand-sub { font-size: 0.82rem; color: var(--text-chrome-muted); }
/* Cascade de troncature (alignée sur LRVcarte) : par défaut on affiche les versions
   longues ; le JS applique .prenom-abbrev / .prenom-hidden / .parti-abbrev quand
   le contenu déborde sur 2 lignes (ou wrap en column mobile). */
.cn-prenom-full { display: inline; }
.cn-prenom-short { display: none; }
.cand-name.prenom-abbrev .cn-prenom-full { display: none; }
.cand-name.prenom-abbrev .cn-prenom-short { display: inline; }
.cand-name.prenom-hidden .cn-prenom-full,
.cand-name.prenom-hidden .cn-prenom-short { display: none; }
.cand-parti-full { display: inline; }
.cand-parti-short { display: none; }
.cand-sub.parti-abbrev .cand-parti-full { display: none; }
.cand-sub.parti-abbrev .cand-parti-short { display: inline; }

/* Palier intermédiaire (tablette / fenêtre étroite) : juste réduit polices. */
@media (max-width: 900px) and (min-width: 721px) {
  .cand-name { font-size: 1.05rem; }
  .cand-sub { font-size: 0.78rem; }
  .cand-pct { font-size: 1.2rem; }
  .cand-voix { font-size: 0.78rem; }
}
.cand-row-pctvoix { display: flex; align-items: baseline; gap: 8px; flex-shrink: 0; }
.cand-voix { font-size: 0.82rem; color: var(--text-chrome-muted); font-variant-numeric: tabular-nums; }
.cand-sep { color: var(--text-chrome-muted); font-size: 0.8rem; }
.cand-pct { font-size: 1.35rem; font-weight: 700; line-height: 1; color: var(--text-chrome); font-variant-numeric: tabular-nums; }
.cand-pct .pct-sym { font-size: 0.55em; margin-left: 2px; font-weight: 600; color: var(--text-chrome-muted); }
.bar-bg { width: 100%; height: 8px; background: var(--bg-chrome-accent); border-radius: 4px; overflow: hidden; }
.bar-fg { height: 100%; border-radius: 4px; transition: width .3s; }
.cand-fold { margin-top: 10px; }
.cand-fold summary { cursor: pointer; font-size: 0.88rem; color: var(--text-chrome-muted); padding: 6px 0; user-select: none; }
.cand-fold summary:hover { color: var(--text-chrome); }
.cand-fold[open] summary { margin-bottom: 12px; }
.cand-fold .cand-list { padding-top: 4px; }
.s-map-wrap { background: var(--bg-card); border: 1px solid var(--border-chrome); border-radius: 8px; padding: 14px; position: relative; }
.s-mini-map { width: 100%; height: auto; max-height: 480px; display: block; }
.s-mini-map path { transition: opacity .15s; cursor: pointer; }
.s-mini-map path:hover { opacity: 0.78; stroke: var(--text-chrome); stroke-width: 1.2; }
.s-mini-map path.off-canton { opacity: 0.65; }
.s-mini-map path.off-canton:hover { opacity: 0.85; }
/* Tooltip carte custom (style cohérent avec le reste du site) */
.svg-tip { position: fixed; background: var(--bg-tooltip); color: var(--text-tooltip); padding: 7px 11px; border-radius: 6px; font-family: 'Space Grotesk', system-ui, sans-serif; font-size: 0.78rem; line-height: 1.4; pointer-events: none; z-index: 10000; opacity: 0; transform: translate(-50%, calc(-100% - 10px)); transition: opacity .12s; box-shadow: 0 4px 12px rgba(0,0,0,.18); max-width: 260px; }
.svg-tip.show { opacity: 1; }
.svg-tip .stip-num { font-weight: 700; font-size: 0.86rem; display: block; }
.svg-tip .stip-den { opacity: 0.9; }
.svg-tip .stip-win { display: block; margin-top: 3px; font-weight: 600; }
.bb { display: flex; width: 100%; border-radius: 4px; overflow: hidden; border: 1px solid var(--border-chrome); }
.bb-seg { transition: opacity .15s; }
.bb-seg:hover { opacity: 0.85; }
.s-blocs-legend { display: flex; flex-wrap: wrap; gap: 14px; font-size: 0.86rem; color: var(--text-body); margin-top: 8px; }
.bl-item { display: inline-flex; align-items: center; gap: 6px; }
.bl-dot { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
/* Triptyque blocs politiques — reproduit le visuel de la fiche globale LRVcarte
   (3 barres empilées : suivant en haut, actuel au milieu, précédent en bas) */
.trip-wrap { border-radius: 6px; overflow: hidden; }
.trip-bar { display: flex; width: 100%; position: relative; }
.trip-bar-current { height: 72px; }
.trip-bar-side { height: 20px; }
.trip-mid-line { position: absolute; top: 0; bottom: 0; left: 50%; width: 0; border-left: 1.5px dashed rgba(255,255,255,0.65); pointer-events: none; z-index: 2; }
.trip-side { position: relative; display: block; text-decoration: none; opacity: 0.42; cursor: pointer; transition: opacity .15s; }
.trip-side:hover { opacity: 0.85; }
.trip-side-label { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); font-size: 0.62rem; font-weight: 700; color: #fff; text-shadow: 0 1px 2px rgba(0,0,0,.5); pointer-events: none; white-space: nowrap; }
.trip-side-meta { font-weight: 500; opacity: 0.85; }
.cell-meta { color: var(--text-chrome-muted); font-size: 0.86em; }
/* Listes quartiers / cantons cliquables — chaque row pointe vers la fiche LRVcarte */
.agg-list { display: flex; flex-direction: column; gap: 4px; background: var(--bg-modal-hover); border-radius: 8px; padding: 8px; }
.agg-row { display: grid; grid-template-columns: 1.4fr 0.9fr 2fr 1.6fr; gap: 12px; align-items: center; padding: 8px 12px; background: var(--bg-card); border: 1px solid var(--border-chrome); border-radius: 6px; text-decoration: none; color: var(--text-chrome); transition: background .15s, border-color .15s; font-size: 0.86rem; }
.agg-row:hover { background: var(--bg-modal-hover); border-color: var(--accent-warm); }
.agg-name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.agg-abst { color: var(--text-chrome-muted); font-variant-numeric: tabular-nums; font-size: 0.78rem; white-space: nowrap; }
.agg-winner { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.agg-dot { width: 11px; height: 11px; border-radius: 50%; flex-shrink: 0; }
.agg-pct { font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; margin-left: 4px; color: var(--text-chrome); }
.agg-bar { position: relative; display: flex; height: 18px; width: 100%; border-radius: 3px; overflow: hidden; }
.agg-bar-mid { position: absolute; top: 0; bottom: 0; left: 50%; width: 0; border-left: 1.5px dashed rgba(255,255,255,0.7); pointer-events: none; z-index: 2; }
.s-bureau-cta { font-size: 0.92rem; color: var(--text-chrome-muted); padding: 12px 16px; background: var(--bg-modal-hover); border-left: 3px solid var(--accent-warm); border-radius: 0 6px 6px 0; margin: 6px 0; }
.s-bureau-cta a { color: var(--text-chrome); font-weight: 600; text-decoration: underline; text-decoration-color: var(--accent-warm); text-underline-offset: 3px; }
.s-bureau-cta a:hover { color: var(--accent-warm); }
.s-cta { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 8px; }
.s-cta-top { margin-top: 18px; }
.s-cta a { display: inline-flex; align-items: center; gap: 8px; padding: 10px 16px; background: var(--bg-chrome); color: var(--text-chrome); text-decoration: none; border: 1px solid var(--border-chrome); border-radius: 6px; font-size: 0.9rem; font-weight: 600; transition: all .15s; }
.s-cta a:hover { background: var(--bg-chrome-hover); border-color: var(--accent-warm); }
.s-cta a.primary { background: var(--text-chrome); color: var(--bg-page); border-color: var(--text-chrome); }
.s-cta a.primary:hover { background: var(--accent-warm); border-color: var(--accent-warm); color: #FFFFFF; }
footer.s-foot { margin-top: 24px; padding-top: 18px; border-top: 1px solid var(--border-chrome); font-size: 0.82rem; color: var(--text-chrome-muted); display: flex; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
footer.s-foot a { color: var(--text-chrome-muted); text-decoration: none; }
footer.s-foot a:hover { color: var(--text-chrome); }

@media (max-width: 720px) {
  #topbar { height: 56px; padding: 0 12px; gap: 8px; }
  .tb-nav { display: none; }
  .tb-logo { font-size: 1.6rem; gap: 3px; flex-shrink: 0; }
  .tb-search-btn { flex-shrink: 0; margin-left: auto; }
  #tb-page-title { display: none; }
  main.scrutin { padding: 24px 14px 40px; }
  .s-wrap { gap: 22px; }
  header.s-head { padding-bottom: 18px; }
  header.s-head h1 { font-size: 1.55rem; }
  header.s-head .lead { font-size: 0.94rem; }
  section.s-block h2 { font-size: 1.15rem; }
  .s-table th, .s-table td { padding: 8px 10px; font-size: 0.86rem; }
  /* Participation : 2 colonnes sur mobile (5 stats → 2/2/1) */
  .partici-grid { grid-template-columns: repeat(2, 1fr); gap: 4px; }
  .pbox { padding: 6px; gap: 2px; }
  .pbox-val { font-size: 0.82rem; }
  .pbox-lbl { font-size: 0.6rem; letter-spacing: 0.2px; }
  /* Mobile (≤720px) : layout column nom/parti à gauche, %/voix à droite.
     La cascade JS applique .prenom-abbrev / .prenom-hidden / .parti-abbrev quand
     un élément déborde sur 2 lignes — pas de forçage CSS du nom court. */
  .cand-row-namepart { flex-direction: column; align-items: flex-start; gap: 2px; flex-wrap: nowrap; }
  .cand-row-pctvoix { flex-direction: column; align-items: flex-end; gap: 1px; }
  .cand-sep { display: none; }
  .cand-row-pctvoix .cand-pct { order: 1; font-size: 1.3rem; }
  .cand-row-pctvoix .cand-voix { order: 2; font-size: 0.7rem; }
  .cand-name { font-size: 1.1rem; font-weight: 700; line-height: 1.15; }
  .cand-sub { font-size: 0.72rem; }
  /* Listes agrégées : layout compact à 2 lignes sur mobile */
  .agg-row { grid-template-columns: 1fr auto; grid-template-areas: 'name abst' 'win win' 'bar bar'; gap: 4px 10px; font-size: 0.82rem; padding: 8px; }
  .agg-name { grid-area: name; }
  .agg-winner { grid-area: win; font-size: 0.78rem; }
  .agg-abst { grid-area: abst; text-align: right; }
  .agg-bar { grid-area: bar; height: 10px; }
}
</style>
</head>
<body>

<div id="topbar">
  <button type="button" class="tb-logo" id="tb-logo-btn" aria-label="Menu" aria-haspopup="true" aria-expanded="false">
    <svg class="tb-logo-burger" viewBox="0 0 16 16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none" aria-hidden="true"><path d="M2 4h12M2 8h12M2 12h12"/></svg>
    <span class="tb-brand-light">LR</span>
    <div class="sail-mini">
      <div class="sail-row" style="--w:17%"></div>
      <div class="sail-row" style="--w:33%"></div>
      <div class="sail-row" style="--w:50%"></div>
      <div class="sail-row" style="--w:67%"></div>
      <div class="sail-row" style="--w:83%"></div>
      <div class="sail-row" style="--w:100%"></div>
    </div>
    <span class="tb-brand-bold">Vote</span>
  </button>
  <nav class="tb-nav">
    <a href="/LRVcarte.html" class="tb-nav-link">La carte</a>
    <a href="/LRVanalyse.html" class="tb-nav-link">L'analyse</a>
  </nav>
  <div style="flex:1"></div>
  <button class="tb-search-btn" id="tb-search-btn" title="Rechercher (⌘K / Ctrl+K)" aria-label="Rechercher">
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="5"/><path d="M11 11l3.5 3.5"/></svg>
  </button>
</div>

<main class="scrutin">
  <div class="s-wrap">

    <header class="s-head">
      <div class="eyebrow">Scrutin</div>
      <h1>${esc(title)}${/La Rochelle/.test(title) ? '' : ' à La Rochelle'}</h1>
      <p class="lead">${dateLead ? esc(dateLead) + ' ' : ''}Résultats détaillés bureau par bureau, agrégés à l'échelle ${canton ? 'de la partie rochelaise du canton' : 'de la commune'}.</p>
      <div class="s-cta s-cta-top">
        <a href="${esc(urlCarte)}">🗺️ Aller sur la carte interactive</a>
        <a href="${esc(urlAnalyse)}">📊 Aller sur l'analyse historique</a>
      </div>
    </header>

    ${cantonWarning ? `<div class="s-warn">${esc(cantonWarning)}</div>` : ''}

    ${tours.map(t => {
      const td = byTour[t];
      const tour = tourLabel(t);
      const showTourTitle = tours.length > 1;
      const winnerCand = td.winner;
      const dateTour = dates[t] || '';
      const winnerLine = winnerCand
        ? `<p>${dateTour ? 'Le <strong>' + esc(dateTour) + '</strong>, ' : ''}<strong>${esc(winnerCand.nom)}</strong>${winnerCand.pa ? ' (' + esc(winnerCand.pa) + ')' : ''} arrive en tête avec <strong>${fmtPct(winnerCand.pct)} %</strong> (${fmtNum(winnerCand.voix)} voix).</p>`
        : '';
      return `
    <section class="s-block">
      ${showTourTitle ? `<h2>${esc(tour)}</h2>` : ''}
      ${winnerLine}

      ${td.mapSVG ? `
      <div class="s-map-wrap">${td.mapSVG}</div>
      ` : ''}

      ${(() => {
        const part_pct = td.inscrits > 0 ? +(td.votants / td.inscrits * 100).toFixed(1) : 0;
        return `
      <div class="partici-grid">
        <div class="pbox"><div class="pbox-lbl">Inscrits</div><div class="pbox-val">${fmtNum(td.inscrits)}</div></div>
        <div class="pbox"><div class="pbox-lbl">Votants</div><div class="pbox-val">${fmtNum(td.votants)} · ${fmtPct(part_pct)} %</div></div>
        <div class="pbox"><div class="pbox-lbl">Abstention</div><div class="pbox-val">${fmtNum(td.abstention_voix)} · ${fmtPct(td.abst_pct)} %</div></div>
        <div class="pbox"><div class="pbox-lbl">Exprimés</div><div class="pbox-val">${fmtNum(td.exprimes)}</div></div>
        <div class="pbox"><div class="pbox-lbl">Blancs / nuls</div><div class="pbox-val">${fmtNum(td.bn_voix)} · ${fmtPct(td.bn_pct)} %</div></div>
      </div>`;
      })()}

      <h3>Résultats par candidat·e</h3>
      ${(() => {
        const FOLD = 7;
        const visible = td.cands.slice(0, FOLD);
        const hidden = td.cands.slice(FOLD);
        const isCantNoun = isCantonale;
        const noun = isCantNoun ? 'binôme' : 'candidat·e';
        function row(c, i) {
          // Cascade de troncature aligné sur LRVcarte :
          // .cand-name contient des spans cn-prenom-full/short (basculés via .prenom-abbrev/.prenom-hidden)
          // .cand-sub contient des spans cand-parti-full/short (basculés via .parti-abbrev)
          const partiShort = esc(c.pa || '');
          const partiFull = esc(c.paFull || c.pa || '');
          const partiSpan = partiFull && partiFull !== partiShort
            ? `<span class="cand-parti-full">${partiFull}</span><span class="cand-parti-short">${partiShort}</span>`
            : partiFull;
          return `
        <div class="cand-row${i===0 ? ' winner' : ''}" title="${esc(c.nom)}${partiFull && partiFull !== partiShort ? ' — ' + partiFull : ''}">
          <div class="cand-row-head">
            <div class="cand-row-namepart">
              <span class="cand-name">${c.nameHTML}</span>
              ${partiSpan ? `<span class="cand-sub">${partiSpan}</span>` : ''}
            </div>
            <div class="cand-row-pctvoix">
              <span class="cand-voix">${fmtNum(c.voix)} voix</span>
              <span class="cand-sep">·</span>
              <span class="cand-pct">${fmtPct(c.pct)}<span class="pct-sym">%</span></span>
            </div>
          </div>
          <div class="bar-bg"><div class="bar-fg" style="width:${Math.max(c.pct, 0.5).toFixed(1)}%;background:${c.barBg}"></div></div>
        </div>`;
        }
        let out = '<div class="s-cands"><div class="cand-list">' + visible.map(row).join('') + '</div>';
        if (hidden.length) {
          const label = '+ ' + hidden.length + ' autre' + (hidden.length > 1 ? 's ' : ' ') + noun + (hidden.length > 1 ? 's' : '');
          out += `
        <details class="cand-fold">
          <summary>${esc(label)}</summary>
          <div class="cand-list">${hidden.map(row).join('')}</div>
        </details>`;
        }
        out += '</div>';
        return out;
      })()}

      ${!isReferendum ? (() => {
        // Triptyque actif sur les pages ville ET canton. neighborSlug retourne
        // null si le voisin n'a pas le même canton id (série A↔B incompatible
        // ou départementale↔cantonale), évitant les liens trompeurs.
        const nextSlug = adj.next ? neighborSlug(adj.next, canton) : null;
        const prevSlug = adj.prev ? neighborSlug(adj.prev, canton) : null;
        const hasNext = nextSlug && td.nextBlocs;
        const hasPrev = prevSlug && td.prevBlocs;
        function sideBar(blocs, otherLabel, slug, position) {
          return `
        <a class="trip-side" href="/scrutins/${slug}.html" title="${esc(otherLabel)}">
          <div class="trip-bar trip-bar-side">${renderBlocSegs(blocs)}</div>
          <span class="trip-side-label">${esc(otherLabel)} <span class="trip-side-meta">(${position})</span></span>
        </a>`;
        }
        return `
      <h3>Blocs politiques</h3>
      <div class="trip-wrap">
        ${hasNext ? sideBar(td.nextBlocs, adj.next, nextSlug, 'suivant') : ''}
        <div class="trip-bar trip-bar-current">${renderBlocSegs(td.blocs)}<div class="trip-mid-line"></div></div>
        ${hasPrev ? sideBar(td.prevBlocs, adj.prev, prevSlug, 'précédent') : ''}
      </div>
      <p class="s-blocs-legend">
        ${['G','C','D','EXD','?'].filter(b => (td.blocs[b]||0) > 0).map(b => `<span class="bl-item"><span class="bl-dot" style="background:${BLOC_COLORS[b]}"></span>${BLOC_LABELS[b]} ${fmtPct(td.blocs[b])} %</span>`).join('')}
      </p>`;
      })() : ''}

      <h3>Par bureau de vote</h3>
      <p class="s-bureau-cta">📍 Pour les résultats détaillés bureau par bureau, <a href="${esc(urlCarte)}">rendez-vous sur la carte interactive →</a></p>

      ${!canton && td.quartiers && td.quartiers.length ? (() => {
        function row(q, href) {
          const w = q.winner;
          const color = w ? w.color : '#bbbbbb';
          const segs = isReferendum
            ? renderRefSegs(q.voix_par_cand, q.exprimes)
            : renderBlocSegs(q.blocs);
          return `
        <a class="agg-row" href="${esc(href)}">
          <span class="agg-name">${esc(q.nom)}</span>
          <span class="agg-abst">${fmtPct(q.abst_pct)} % abst.</span>
          <span class="agg-winner"><span class="agg-dot" style="background:${color}"></span>${w ? esc(w.nomFamille || w.nom) : '—'}<span class="agg-pct">${w ? fmtPct(w.pct) + ' %' : ''}</span></span>
          <span class="agg-bar">${segs}<div class="agg-bar-mid"></div></span>
        </a>`;
        }
        return `
      <h3>Par quartier</h3>
      <div class="agg-list">
        ${td.quartiers.map(q => row(q, '/LRVcarte.html#election=' + encodeURIComponent(label) + '&quartier=' + encodeURIComponent(q.nom))).join('')}
      </div>`;
      })() : ''}

    </section>`;
    }).join('\n')}

    <section class="s-block">
      <h2>Explorer ce scrutin</h2>
      <p>Pour voir le détail bureau par bureau sur la carte interactive, comparer ce scrutin à d'autres, ou explorer un quartier en particulier&nbsp;:</p>
      <div class="s-cta">
        <a href="${esc(urlCarte)}">🗺️ Aller sur la carte interactive</a>
        <a href="${esc(urlAnalyse)}">📊 Aller sur l'analyse historique</a>
        ${wpUrl ? `<a href="${esc(wpUrl)}" target="_blank" rel="noopener">📖 Page Wikipédia</a>` : ''}
      </div>
    </section>

    <footer class="s-foot">
      <span>Page générée le ${fmtDate} à partir des données de <a href="/">larochellevote.fr</a>.</span>
      <span><a href="/methodologie.html">Méthodologie &amp; sources →</a></span>
    </footer>

  </div>
</main>

<!-- shared.js fournit setupAppMenu + setupSailAnimation (pas de dépendance donnees.js) -->
<script src="/shared.js" defer></script>
<script defer>
document.addEventListener('DOMContentLoaded', function() {
  if (typeof setupAppMenu === 'function') setupAppMenu();
  if (typeof setupSailAnimation === 'function') setupSailAnimation();
  // Bouton recherche : redirige vers LRVcarte (où Cmd+K est complet avec les données chargées)
  var sb = document.getElementById('tb-search-btn');
  if (sb) sb.addEventListener('click', function() {
    location.href = '/LRVcarte.html';
  });

  // ── Cascade de troncature des noms candidats (alignée sur LRVcarte) ───
  // Mesure si le nom ou le parti déborde sur 2 lignes (mobile) ou si le sub
  // passe sur la ligne suivante (desktop), et applique les classes adaptées.
  function lineHeightOf(el) {
    var s = getComputedStyle(el);
    var lh = parseFloat(s.lineHeight);
    if (isNaN(lh)) lh = parseFloat(s.fontSize) * 1.2;
    return lh || 0;
  }
  function isMultiline(el) {
    var lh = lineHeightOf(el);
    if (!lh) return false;
    return el.offsetHeight > lh * 1.5;
  }
  function isSubOnNextLine(nameEl, subEl) {
    if (!nameEl || !subEl) return false;
    var nameRect = nameEl.getBoundingClientRect();
    var subRect = subEl.getBoundingClientRect();
    return subRect.top >= nameRect.bottom - 4;
  }
  function applyCandTruncationCascade(rootEl) {
    var containers = (rootEl || document).querySelectorAll('.cand-row-namepart');
    containers.forEach(function(np) {
      var nameEl = np.querySelector('.cand-name');
      var subEl  = np.querySelector('.cand-sub');
      if (!nameEl || !subEl) return;
      nameEl.classList.remove('prenom-abbrev', 'prenom-hidden');
      subEl.classList.remove('parti-abbrev');
      var parentDir = getComputedStyle(np).flexDirection;
      var isColumn = (parentDir === 'column' || parentDir === 'column-reverse');
      if (isColumn) {
        function nameOver() { void nameEl.offsetHeight; return isMultiline(nameEl); }
        function subOver()  { void subEl.offsetHeight;  return isMultiline(subEl);  }
        if (nameOver()) {
          nameEl.classList.add('prenom-abbrev');
          if (nameOver()) {
            nameEl.classList.remove('prenom-abbrev');
            nameEl.classList.add('prenom-hidden');
          }
        }
        if (subOver()) {
          subEl.classList.add('parti-abbrev');
        }
        return;
      }
      // Desktop : sub passe sur la 2e ligne → on cascade
      if (!isSubOnNextLine(nameEl, subEl)) return;
      nameEl.classList.add('prenom-abbrev');
      if (!isSubOnNextLine(nameEl, subEl)) return;
      subEl.classList.add('parti-abbrev');
      if (!isSubOnNextLine(nameEl, subEl)) return;
      nameEl.classList.add('prenom-hidden');
    });
  }
  applyCandTruncationCascade();
  // Re-mesure au resize (debounced 150ms) : couvre rotation tel, barre URL Chrome
  var rt;
  window.addEventListener('resize', function() {
    clearTimeout(rt);
    rt = setTimeout(applyCandTruncationCascade, 150);
  }, { passive: true });

  // ── Tooltip custom sur la carte SVG ───────────────────────────────────
  // On retire les <title> natifs (pour éviter le double tooltip browser + custom)
  // et on attache des handlers hover qui affichent un div .svg-tip flottant.
  var tip = null;
  function ensureTip() {
    if (tip) return tip;
    tip = document.createElement('div');
    tip.className = 'svg-tip';
    document.body.appendChild(tip);
    return tip;
  }
  document.querySelectorAll('.s-mini-map path').forEach(function(p) {
    // Supprime le <title> natif pour éviter le tooltip browser
    var t = p.querySelector('title');
    if (t) t.remove();
    p.addEventListener('mouseenter', function(e) {
      var num = p.dataset.num || '';
      var den = p.dataset.den || '';
      var win = p.dataset.winner || '';
      var agg = p.dataset.agg === '1';
      var el = ensureTip();
      var prefix = agg ? 'Bureaux ' : 'N°';
      var suffix = agg ? ' (zone agrégée)' : '';
      el.innerHTML = '<span class="stip-num">' + prefix + num + suffix + (den ? ' · <span class="stip-den">' + den + '</span>' : '') + '</span>'
        + (win ? '<span class="stip-win">' + win + '</span>' : '');
      el.classList.add('show');
    });
    p.addEventListener('mousemove', function(e) {
      if (!tip) return;
      tip.style.left = e.clientX + 'px';
      tip.style.top = e.clientY + 'px';
    });
    p.addEventListener('mouseleave', function() {
      if (tip) tip.classList.remove('show');
    });
  });
});
</script>

</body>
</html>
`;
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  console.log('⏳ Chargement des données…');
  const ctx = loadData();
  console.log(`✅ ${Object.keys(ctx.ELECTIONS).length} élections chargées`);

  // Construire la liste des pages à générer
  const pages = [];
  Object.entries(ctx.ELECTIONS).forEach(([label, el]) => {
    pagesForElection(label, el, ctx).forEach(p => pages.push(p));
  });
  console.log(`📄 ${pages.length} pages à générer`);

  if (ONLY) {
    const before = pages.length;
    pages.splice(0, pages.length, ...pages.filter(p => p.slug === ONLY));
    console.log(`🔍 Filtre --only ${ONLY} : ${pages.length}/${before} pages retenues`);
  }

  // Préparer le dossier de sortie
  if (!DRY) {
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  }

  let ok = 0, fail = 0;
  pages.forEach(pageSpec => {
    try {
      const data = buildPageData(pageSpec, ctx);
      const html = renderHTML(data, { ctx });
      const outPath = path.join(OUT_DIR, pageSpec.slug + '.html');
      if (DRY) {
        console.log(`  [dry] ${pageSpec.slug}.html (${html.length} bytes)`);
      } else {
        fs.writeFileSync(outPath, html, 'utf8');
        if (VERBOSE) console.log(`  ✓ ${pageSpec.slug}.html`);
      }
      ok++;
    } catch (err) {
      console.error(`  ✗ ${pageSpec.slug} — ${err.message}`);
      if (VERBOSE) console.error(err.stack);
      fail++;
    }
  });

  console.log(`\n✅ ${ok} générées, ❌ ${fail} en erreur`);
  if (fail > 0) process.exit(1);

  // ─── Régénération du sitemap.xml ────────────────────────────────────────
  if (!DRY && !ONLY) {
    const today = new Date().toISOString().slice(0, 10);
    const baseURLs = [
      { loc: 'https://larochellevote.fr/', changefreq: 'weekly', priority: '1.0' },
      { loc: 'https://larochellevote.fr/LRVcarte.html', changefreq: 'daily', priority: '0.9' },
      { loc: 'https://larochellevote.fr/LRVanalyse.html', changefreq: 'weekly', priority: '0.9' },
      { loc: 'https://larochellevote.fr/methodologie.html', changefreq: 'monthly', priority: '0.7' },
      { loc: 'https://larochellevote.fr/apropos.html', changefreq: 'monthly', priority: '0.6' },
    ];
    const scrutinURLs = pages.map(p => ({
      loc: 'https://larochellevote.fr/scrutins/' + p.slug + '.html',
      changefreq: 'monthly',
      priority: '0.7',
    }));
    const allURLs = [...baseURLs, ...scrutinURLs];
    const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${allURLs.map(u => `
  <url>
    <loc>${u.loc}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('')}

</urlset>
`;
    fs.writeFileSync(path.join(ROOT, 'sitemap.xml'), sitemap, 'utf8');
    console.log(`📑 sitemap.xml mis à jour (${allURLs.length} URLs)`);
  }
}

main();
