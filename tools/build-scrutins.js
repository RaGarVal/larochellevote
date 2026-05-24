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

  vm.createContext(sandbox);
  vm.runInContext(donneesSrc + donneesSuffix, sandbox, { filename: 'donnees.js' });
  vm.runInContext(sharedSrc + sharedSuffix,  sandbox, { filename: 'shared.js' });

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

/** Split d'un libellé quartier "A/B" en parts individuelles (bureaux partagés) */
function getQuartierParts(q) {
  if (!q) return [];
  return String(q).split('/').map(s => s.trim()).filter(Boolean);
}

/** Agrège par quartier : { quartier → { abst_pct, exprimes, voix_par_cand, nb_bureaux } } */
function aggregateByQuartier(sheet, bureauInfo) {
  const out = {};
  Object.entries(sheet || {}).forEach(([ns, bd]) => {
    if (!bd) return;
    const info = bureauInfo[ns];
    if (!info || !info.q || info.q === 'Nul') return;
    const parts = getQuartierParts(info.q);
    parts.forEach(q => {
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

/** Trouve les scrutins voisins (précédent et suivant) du même type d'élection */
function adjacentElections(label, ELECTIONS, ctx) {
  // On cherche par "type" (préfixe avant le premier nombre)
  const m = label.match(/^(.+?)\s*(\d{4})/);
  if (!m) return { prev: null, next: null };
  const type = m[1].trim();
  const year = parseInt(m[2]);
  // Liste des élections du même type, avec leur année
  const sameType = Object.keys(ELECTIONS)
    .filter(k => {
      const km = k.match(/^(.+?)\s*(\d{4})/);
      return km && km[1].trim() === type;
    })
    .map(k => ({ label: k, year: parseInt(k.match(/(\d{4})/)[1]) }))
    .sort((a, b) => a.year - b.year);
  const idx = sameType.findIndex(e => e.label === label);
  return {
    prev: idx > 0 ? sameType[idx - 1].label : null,
    next: idx >= 0 && idx < sameType.length - 1 ? sameType[idx + 1].label : null,
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

  // Pour chaque tour, agréger ville
  const byTour = {};
  tours.forEach(t => {
    const agg = aggregateSheet(sheets[t]);
    // Construire le tableau des candidats avec leurs voix et pct
    const cands = Object.entries(agg.voix_par_cand).map(([cid, voix]) => {
      const cd = ctx.CAND_DATA[cid] || {};
      // Nom à afficher : binôme ou individu
      let displayName;
      if (cd.binome && Array.isArray(cd.binome)) {
        const persons = cd.binome.map(pid => ctx.PERSONS[pid] || {});
        displayName = persons.map(p => (p.p ? p.p + ' ' : '') + (p.n || '')).join(' / ');
      } else {
        const person = cd.person ? ctx.PERSONS[cd.person] : null;
        const prenom = (person && person.p) || cd.p || '';
        const nom    = (person && person.n) || cd.n || cid;
        displayName  = (prenom ? prenom + ' ' : '') + nom;
      }
      return {
        cid,
        nom: displayName,
        pa: cd.pa || '',
        bloc: cd.b || '',
        voix,
        pct: pctOf(voix, agg.exprimes),
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
        .map(([cid, voix]) => {
          const cd = ctx.CAND_DATA[cid] || {};
          let displayName;
          if (cd.binome) {
            const persons = cd.binome.map(pid => ctx.PERSONS[pid] || {});
            displayName = persons.map(p => (p.p ? p.p + ' ' : '') + (p.n || '')).join(' / ');
          } else {
            const person = cd.person ? ctx.PERSONS[cd.person] : null;
            displayName = ((person && person.p) || cd.p || '') + ' ' + ((person && person.n) || cd.n || cid);
            displayName = displayName.trim();
          }
          return { cid, nom: displayName, pa: cd.pa || '', voix, pct: pctOf(voix, qAgg.exprimes) };
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
          .map(([cid2, voix]) => {
            const cd = ctx.CAND_DATA[cid2] || {};
            let displayName;
            if (cd.binome) {
              const persons = cd.binome.map(pid => ctx.PERSONS[pid] || {});
              displayName = persons.map(p => (p.p ? p.p + ' ' : '') + (p.n || '')).join(' / ');
            } else {
              const person = cd.person ? ctx.PERSONS[cd.person] : null;
              displayName = ((person && person.p) || cd.p || '') + ' ' + ((person && person.n) || cd.n || cid2);
              displayName = displayName.trim();
            }
            return { cid: cid2, nom: displayName, pa: cd.pa || '', voix, pct: pctOf(voix, cAgg.exprimes) };
          })
          .sort((a, b) => b.voix - a.voix);
        const abst_pct_c = cAgg.inscrits > 0 ? +(cAgg.abstention_voix / cAgg.inscrits * 100).toFixed(1) : 0;
        const blocs = computeBlocsFromVoix(cAgg.voix_par_cand, cAgg.exprimes, ctx.CAND_DATA, ctx.BLOC_LEGACY);
        return { cid, era: cantonEra, ...cAgg, abst_pct: abst_pct_c, winner: cCands[0] || null, blocs };
      }).sort((a, b) => parseInt(a.cid) - parseInt(b.cid));
    }

    // Blocs ville
    const blocs = computeBlocsFromVoix(agg.voix_par_cand, agg.exprimes, ctx.CAND_DATA, ctx.BLOC_LEGACY);

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
    };
  });

  // Scrutins voisins (même type) — utiles pour le triptych
  const adj = adjacentElections(label, ctx.ELECTIONS, ctx);

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

  // Slug URL pour les liens cohérents
  const urlCarte = '/LRVcarte.html#election=' + encodeURIComponent(label) + (canton ? '&canton=' + canton : '') + '&tab=global';
  const urlAnalyse = '/LRVanalyse.html#level=' + (canton ? 'canton&canton=' + canton : 'ville') + '&election=' + encodeURIComponent(label);

  // Couleurs des blocs politiques (depuis BLOC_CONFIG ; reprises en dur ici pour le HTML statique)
  const BLOC_COLORS = { G: '#CC0100', C: '#F1C232', D: '#0F55CC', EXD: '#20124D', '?': '#888888' };
  const BLOC_LABELS = { G: 'Gauche', C: 'Centre', D: 'Droite', EXD: 'Extrême-droite', '?': 'Divers' };

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
}
[data-theme="dark"] {
  --bg-chrome: #16151A; --bg-chrome-hover: #2D2A30; --bg-chrome-accent: #383438;
  --text-chrome: #ECE6DD; --text-chrome-muted: #9D968B; --border-chrome: #2D2A30;
  --bg-page: #0F0E13; --bg-card: #21202A; --bg-blockquote: rgba(180, 155, 126, 0.08);
  --text-body: #D8D2C7; --accent-warm: #C9A878;
}
body { font-family: 'Space Grotesk', system-ui, sans-serif; background: var(--bg-page); color: var(--text-chrome); -webkit-font-smoothing: antialiased; display: flex; flex-direction: column; min-height: 100vh; }
#topbar { background: var(--bg-chrome); color: var(--text-chrome); display: flex; align-items: center; gap: 16px; padding: 0 24px; height: 66px; flex-shrink: 0; z-index: 50; border-bottom: 1px solid var(--border-chrome); }
.tb-logo { display: flex; align-items: baseline; gap: 4px; text-decoration: none; color: inherit; flex-shrink: 0; font-size: 2.1rem; line-height: 1; }
.tb-brand-light, .tb-brand-bold { letter-spacing: -0.02em; white-space: nowrap; }
.tb-brand-light { font-size: 0.95em; font-weight: 400; }
.tb-brand-bold { font-weight: 700; }
.tb-nav { margin-left: auto; display: flex; align-items: center; gap: 22px; flex-shrink: 0; }
.tb-nav-link { font-size: .86rem; font-weight: 500; color: var(--text-chrome-muted); text-decoration: none; padding: 4px 0; border-bottom: 2px solid transparent; transition: color .15s; }
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
.s-particip { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 14px; padding: 18px; background: var(--bg-card); border: 1px solid var(--border-chrome); border-radius: 8px; }
.s-particip .stat { display: flex; flex-direction: column; gap: 4px; }
.s-particip .stat-label { font-size: 0.72rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-chrome-muted); }
.s-particip .stat-val { font-size: 1.4rem; font-weight: 700; color: var(--text-chrome); }
.s-particip .stat-sub { font-size: 0.78rem; color: var(--text-chrome-muted); }
.s-table { width: 100%; border-collapse: collapse; background: var(--bg-card); border: 1px solid var(--border-chrome); border-radius: 8px; overflow: hidden; }
.s-table thead { background: var(--bg-chrome-accent); }
.s-table th { font-size: 0.74rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-chrome-muted); text-align: left; padding: 10px 14px; }
.s-table th.num { text-align: right; }
.s-table td { padding: 10px 14px; font-size: 0.94rem; border-top: 1px solid var(--border-chrome); }
.s-table td.num { text-align: right; font-variant-numeric: tabular-nums; }
.s-table .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 8px; vertical-align: middle; }
.s-table .winner { font-weight: 700; }
.s-warn { background: #FFF7E6; border: 1px solid #E6C77E; color: #8A6A2C; padding: 12px 16px; border-radius: 6px; font-size: 0.9rem; line-height: 1.5; font-style: italic; }
.bb { display: flex; width: 100%; border-radius: 4px; overflow: hidden; border: 1px solid var(--border-chrome); }
.bb-seg { transition: opacity .15s; }
.bb-seg:hover { opacity: 0.85; }
.s-blocs-legend { display: flex; flex-wrap: wrap; gap: 14px; font-size: 0.86rem; color: var(--text-body); margin-top: 8px; }
.bl-item { display: inline-flex; align-items: center; gap: 6px; }
.bl-dot { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
.s-triptych { margin-top: 10px; }
.s-triptych summary { cursor: pointer; font-size: 0.88rem; color: var(--text-chrome-muted); padding: 6px 0; user-select: none; }
.s-triptych summary:hover { color: var(--text-chrome); }
.trip { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; }
.trip-row { display: flex; align-items: center; padding: 8px 12px; background: var(--bg-card); border: 1px solid var(--border-chrome); border-radius: 6px; }
.trip-row.trip-current { background: var(--bg-chrome-accent); }
.trip-label { flex: 1; font-size: 0.92rem; }
.trip-meta { font-size: 0.78rem; color: var(--text-chrome-muted); }
.trip-link { color: var(--text-chrome); text-decoration: none; font-size: 1.1rem; padding: 2px 8px; border-radius: 4px; transition: background .15s; }
.trip-link:hover { background: var(--bg-chrome-hover); }
.cell-meta { color: var(--text-chrome-muted); font-size: 0.86em; }
.s-cta { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 8px; }
.s-cta a { display: inline-flex; align-items: center; gap: 8px; padding: 10px 16px; background: var(--bg-chrome); color: var(--text-chrome); text-decoration: none; border: 1px solid var(--border-chrome); border-radius: 6px; font-size: 0.9rem; font-weight: 600; transition: all .15s; }
.s-cta a:hover { background: var(--bg-chrome-hover); border-color: var(--accent-warm); }
.s-cta a.primary { background: var(--text-chrome); color: var(--bg-page); border-color: var(--text-chrome); }
.s-cta a.primary:hover { background: var(--accent-warm); border-color: var(--accent-warm); color: #FFFFFF; }
footer.s-foot { margin-top: 24px; padding-top: 18px; border-top: 1px solid var(--border-chrome); font-size: 0.82rem; color: var(--text-chrome-muted); display: flex; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
footer.s-foot a { color: var(--text-chrome-muted); text-decoration: none; }
footer.s-foot a:hover { color: var(--text-chrome); }

@media (max-width: 720px) {
  #topbar { height: 56px; padding: 0 12px; gap: 8px; }
  .tb-logo { font-size: 1.6rem; gap: 3px; }
  main.scrutin { padding: 24px 14px 40px; }
  .s-wrap { gap: 22px; }
  header.s-head { padding-bottom: 18px; }
  header.s-head h1 { font-size: 1.55rem; }
  header.s-head .lead { font-size: 0.94rem; }
  section.s-block h2 { font-size: 1.15rem; }
  .s-table th, .s-table td { padding: 8px 10px; font-size: 0.86rem; }
  .s-particip { padding: 14px; gap: 10px; }
  .s-particip .stat-val { font-size: 1.2rem; }
}
</style>
</head>
<body>

<div id="topbar">
  <a href="/" class="tb-logo">
    <span class="tb-brand-light">LR</span>
    <span class="tb-brand-bold">Vote</span>
  </a>
  <nav class="tb-nav">
    <a href="/LRVcarte.html" class="tb-nav-link">La carte</a>
    <a href="/LRVanalyse.html" class="tb-nav-link">L'analyse</a>
    <a href="/methodologie.html" class="tb-nav-link">Méthodologie</a>
  </nav>
</div>

<main class="scrutin">
  <div class="s-wrap">

    <header class="s-head">
      <div class="eyebrow">Scrutin</div>
      <h1>${esc(title)}${/La Rochelle/.test(title) ? '' : ' à La Rochelle'}</h1>
      <p class="lead">${dateLead ? esc(dateLead) + ' ' : ''}Résultats détaillés bureau par bureau, agrégés à l'échelle ${canton ? 'de la partie rochelaise du canton' : 'de la commune'}.</p>
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

      <h3>Participation</h3>
      <div class="s-particip">
        <div class="stat"><span class="stat-label">Inscrits</span><span class="stat-val">${fmtNum(td.inscrits)}</span></div>
        <div class="stat"><span class="stat-label">Abstention</span><span class="stat-val">${fmtPct(td.abst_pct)} %</span><span class="stat-sub">${fmtNum(td.abstention_voix)} personnes</span></div>
        <div class="stat"><span class="stat-label">Blancs/nuls</span><span class="stat-val">${fmtPct(td.bn_pct)} %</span><span class="stat-sub">${fmtNum(td.bn_voix)} bulletins</span></div>
        <div class="stat"><span class="stat-label">Exprimés</span><span class="stat-val">${fmtNum(td.exprimes)}</span></div>
      </div>

      <h3>Résultats par candidat</h3>
      <table class="s-table">
        <thead>
          <tr><th>Candidat·e</th><th>Parti</th><th class="num">Voix</th><th class="num">%</th></tr>
        </thead>
        <tbody>
${td.cands.map((c, i) => `          <tr${i===0 ? ' class="winner"' : ''}><td>${esc(c.nom)}</td><td>${esc(c.pa)}</td><td class="num">${fmtNum(c.voix)}</td><td class="num">${fmtPct(c.pct)} %</td></tr>`).join('\n')}
        </tbody>
      </table>

      ${!isReferendum ? `
      <h3>Blocs politiques</h3>
      ${renderBlocBar(td.blocs, 36)}
      <p class="s-blocs-legend">
        ${['G','C','D','EXD','?'].filter(b => (td.blocs[b]||0) > 0).map(b => `<span class="bl-item"><span class="bl-dot" style="background:${BLOC_COLORS[b]}"></span>${BLOC_LABELS[b]} ${fmtPct(td.blocs[b])} %</span>`).join('')}
      </p>
      ${(() => {
        const nextSlug = adj.next ? neighborSlug(adj.next, canton) : null;
        const prevSlug = adj.prev ? neighborSlug(adj.prev, canton) : null;
        if (!nextSlug && !prevSlug) return '';
        return `
      <details class="s-triptych">
        <summary>Comparer aux scrutins voisins</summary>
        <div class="trip">
          ${nextSlug ? `<div class="trip-row"><div class="trip-label">${esc(adj.next)} <span class="trip-meta">(suivant)</span></div><a class="trip-link" href="/scrutins/${nextSlug}.html">→</a></div>` : ''}
          <div class="trip-row trip-current"><div class="trip-label"><strong>${esc(label)}</strong> <span class="trip-meta">(actuel)</span></div></div>
          ${prevSlug ? `<div class="trip-row"><div class="trip-label">${esc(adj.prev)} <span class="trip-meta">(précédent)</span></div><a class="trip-link" href="/scrutins/${prevSlug}.html">→</a></div>` : ''}
        </div>
      </details>`;
      })()}
      ` : ''}

      ${td.quartiers && td.quartiers.length ? `
      <h3>Par quartier</h3>
      <table class="s-table">
        <thead>
          <tr><th>Quartier</th><th class="num">Abst.</th><th>${isReferendum ? 'Réponse en tête' : 'Arrivé·e en tête'}</th><th class="num">%</th></tr>
        </thead>
        <tbody>
${td.quartiers.map(q => `          <tr><td>${esc(q.nom)}</td><td class="num">${fmtPct(q.abst_pct)} %</td><td>${q.winner ? esc(q.winner.nom) + (q.winner.pa ? ' <span class="cell-meta">(' + esc(q.winner.pa) + ')</span>' : '') : '—'}</td><td class="num">${q.winner ? fmtPct(q.winner.pct) + ' %' : '—'}</td></tr>`).join('\n')}
        </tbody>
      </table>` : ''}

      ${td.cantons && td.cantons.length ? `
      <h3>Par canton</h3>
      <table class="s-table">
        <thead>
          <tr><th>Canton</th><th class="num">Abst.</th><th>${isReferendum ? 'Réponse en tête' : 'Arrivé·e en tête'}</th><th class="num">%</th></tr>
        </thead>
        <tbody>
${td.cantons.map(c => `          <tr><td>La Rochelle-${esc(c.cid)}</td><td class="num">${fmtPct(c.abst_pct)} %</td><td>${c.winner ? esc(c.winner.nom) + (c.winner.pa ? ' <span class="cell-meta">(' + esc(c.winner.pa) + ')</span>' : '') : '—'}</td><td class="num">${c.winner ? fmtPct(c.winner.pct) + ' %' : '—'}</td></tr>`).join('\n')}
        </tbody>
      </table>` : ''}

    </section>`;
    }).join('\n')}

    <section class="s-block">
      <h2>Explorer ce scrutin</h2>
      <p>Pour voir le détail bureau par bureau sur la carte interactive, comparer ce scrutin à d'autres, ou explorer un quartier en particulier&nbsp;:</p>
      <div class="s-cta">
        <a class="primary" href="${esc(urlCarte)}">🗺️ Carte interactive</a>
        <a href="${esc(urlAnalyse)}">📊 Analyse comparative</a>
        ${wpUrl ? `<a href="${esc(wpUrl)}" target="_blank" rel="noopener">📖 Page Wikipédia</a>` : ''}
      </div>
    </section>

    <footer class="s-foot">
      <span>Page générée le ${fmtDate} à partir des données de <a href="/">larochellevote.fr</a>.</span>
      <span><a href="/methodologie.html">Méthodologie &amp; sources →</a></span>
    </footer>

  </div>
</main>

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
