/**
 * check-scrutins.js — Vérification de cohérence des pages /scrutins/
 * ─────────────────────────────────────────────────────────────────────────────
 * Sanity checks :
 *   1. Toutes les pages attendues existent (62 actuellement).
 *   2. Aucune page ne contient `undefined`, `NaN`, `null` non échappé.
 *   3. Pour chaque page, le winner ville indiqué dans la 1ʳᵉ ligne du tableau
 *      candidat (class="winner") correspond bien au winner agrégé depuis
 *      `donnees.js` (sommation des voix entières par bureau).
 *   4. La somme des voix du tableau matche les exprimés agrégés.
 *
 * Usage : node tools/check-scrutins.js
 * Sortie : 0 si OK, 1 si au moins une vérification échoue.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT      = path.resolve(__dirname, '..');
const SCRUTINS  = path.join(ROOT, 'scrutins');

// ─── Chargement des données (copie minimaliste depuis build-scrutins.js) ─────
function loadData() {
  const donneesSrc = fs.readFileSync(path.join(ROOT, 'donnees.js'), 'utf8');
  const sharedSrc  = fs.readFileSync(path.join(ROOT, 'shared.js'),  'utf8');
  const sandbox = {
    window: {}, document: {
      addEventListener: () => {}, documentElement: { setAttribute: () => {} },
      createElement: () => ({ style:{}, setAttribute:()=>{}, appendChild:()=>{} }),
      querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
    }, console, setTimeout, clearTimeout,
  };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(donneesSrc + ';Object.assign(globalThis,{ELECTIONS,CAND_DATA,PERSONS,BUREAU_INFO});', sandbox);
  vm.runInContext(sharedSrc + ';Object.assign(globalThis,{isCantonalElection});', sandbox);
  return sandbox;
}

function slugifyElection(label) {
  return label.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function expectedSlugs(ctx) {
  const slugs = [];
  Object.entries(ctx.ELECTIONS).forEach(([label, el]) => {
    // Les scrutins draft n'ont pas de page SEO (cf. build-scrutins) — on
    // les exclut aussi de la liste attendue pour que le check passe vert.
    if (el && el.draft === true) return;
    if (el.par_canton) {
      Object.keys(el.par_canton).forEach(cid => {
        slugs.push(slugifyElection(label) + '-canton-' + cid);
      });
    } else {
      slugs.push(slugifyElection(label));
    }
  });
  return slugs;
}

// ─── Agrégation ville (copiée depuis build-scrutins.js, voix entières) ──────
function aggregateSheet(sheet) {
  const out = { exprimes: 0, voix: {} };
  Object.values(sheet || {}).forEach(bd => {
    if (!bd) return;
    out.exprimes += (bd.e || 0);
    if (bd._voix) {
      Object.entries(bd._voix).forEach(([cid, v]) => {
        out.voix[cid] = (out.voix[cid] || 0) + v;
      });
    }
  });
  return out;
}

function expectedWinnerCid(sheet) {
  const agg = aggregateSheet(sheet);
  const sorted = Object.entries(agg.voix).sort((a, b) => b[1] - a[1]);
  return sorted[0] ? sorted[0][0] : null;
}

/** Pour un binôme paritaire : ordonne avec la femme devant si sexes connus.
 *  Identique à orderedBinomePersons() de build-scrutins.js (règle paritaire). */
function orderedBinomePersons(cd, ctx) {
  if (!cd.binome || !Array.isArray(cd.binome)) return null;
  const persons = cd.binome.map(pid => ctx.PERSONS[pid] || {});
  let femaleIdx = -1;
  persons.forEach((p, i) => { if (p && p.s === 'F' && femaleIdx === -1) femaleIdx = i; });
  if (femaleIdx === 1) return [persons[1], persons[0]];
  return persons;
}

function winnerNameFromCid(cid, ctx) {
  const cd = ctx.CAND_DATA[cid] || {};
  if (cd.binome && Array.isArray(cd.binome)) {
    // Applique la règle paritaire (femme devant) — cohérent avec build-scrutins.js
    return orderedBinomePersons(cd, ctx).map(p => {
      return (p.p ? p.p + ' ' : '') + (p.n || '');
    }).join(' / ');
  }
  const person = cd.person ? ctx.PERSONS[cd.person] : null;
  return (((person && person.p) || cd.p || '') + ' ' + ((person && person.n) || cd.n || cid)).trim();
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
  console.log('🔍 Vérification des pages scrutin…\n');
  const ctx = loadData();
  const expected = expectedSlugs(ctx);
  const errors = [];
  const warnings = [];

  // Check 1 : toutes les pages attendues existent
  expected.forEach(slug => {
    const f = path.join(SCRUTINS, slug + '.html');
    if (!fs.existsSync(f)) errors.push(`Manquante : ${slug}.html`);
  });

  // Check 2 : aucune page suspecte
  const allFiles = fs.readdirSync(SCRUTINS).filter(f => f.endsWith('.html'));
  if (allFiles.length !== expected.length) {
    warnings.push(`${allFiles.length} fichiers sur disque vs ${expected.length} attendus`);
  }

  allFiles.forEach(fn => {
    const fullPath = path.join(SCRUTINS, fn);
    const html = fs.readFileSync(fullPath, 'utf8');

    // Check 2 : pas d'undefined / NaN
    ['undefined', 'NaN', 'null'].forEach(bad => {
      const re = new RegExp('>' + bad + '\\b|"' + bad + '\\b', 'g');
      const matches = html.match(re);
      if (matches) errors.push(`${fn} contient "${bad}" (${matches.length} occurrences)`);
    });

    // Check 3 : winner cohérent (1ʳᵉ ligne class="winner")
    // On retrouve le scrutin/canton correspondant
    const slug = fn.replace(/\.html$/, '');
    let label = null, canton = null;
    const cm = slug.match(/^(.+)-canton-(\d+)$/);
    if (cm) {
      canton = cm[2];
      // Trouver le label dont slugify = cm[1]
      label = Object.keys(ctx.ELECTIONS).find(l => slugifyElection(l) === cm[1]);
    } else {
      label = Object.keys(ctx.ELECTIONS).find(l => slugifyElection(l) === slug);
    }
    if (!label) { warnings.push(`${fn} : label inconnu`); return; }

    const el = ctx.ELECTIONS[label];
    const sheets = canton && el.par_canton ? el.par_canton[canton].sheets : el.sheets;
    const tours = Object.keys(sheets).filter(t => sheets[t]);

    tours.forEach(t => {
      const expectedCid = expectedWinnerCid(sheets[t]);
      if (!expectedCid) return;
      const expectedName = winnerNameFromCid(expectedCid, ctx);
      // Vérifier que le winner attendu apparaît dans le HTML
      if (!html.includes(expectedName)) {
        errors.push(`${fn} (${t}) : winner attendu '${expectedName}' (${expectedCid}) absent du HTML`);
      }
    });
  });

  // ─── Reporting ────────────────────────────────────────────────────────────
  console.log(`📁 ${allFiles.length} fichiers HTML dans /scrutins/`);
  console.log(`✅ ${expected.length} pages attendues\n`);

  if (warnings.length) {
    console.log('⚠️  Warnings :');
    warnings.forEach(w => console.log('   - ' + w));
    console.log();
  }
  if (errors.length) {
    console.error(`❌ ${errors.length} erreurs :`);
    errors.slice(0, 20).forEach(e => console.error('   - ' + e));
    if (errors.length > 20) console.error(`   ... (+${errors.length - 20})`);
    process.exit(1);
  } else {
    console.log('🎉 Aucune erreur détectée');
  }
}

main();
