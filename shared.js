// shared.js — Helpers et constantes partagés entre les pages LRVote
// Importé par : index.html · LRVcarte.html · LRVanalyse.html · apropos.html · methodologie.html
// Doit être chargé APRÈS donnees.js (qui définit BLOC_CONFIG, PARTI_NAMES, ELECTIONS, etc.)
// et AVANT les scripts de page.

// ───────────────────────────────────────────────────────────────
//  DÉTECTION INPUT MOUSE / KEYBOARD (a11y)
//  Pose un attribut data-input="mouse"|"keyboard" sur <html>, utilisé par shared.css
//  pour ne montrer l'anneau de focus orange qu'en navigation clavier.
//  Plus robuste que :focus-visible seul, qui a des comportements variables selon
//  les navigateurs (Safari notamment, et Chrome dans certains cas après ouverture
//  de modale ou focus programmatique).
// ───────────────────────────────────────────────────────────────
(function () {
  function setMouse() { document.documentElement.setAttribute('data-input', 'mouse'); }
  function setKeyboard(e) {
    // Tab / flèches / Espace / Entrée / Échap → mode clavier
    if (e.key === 'Tab' || e.key === 'Escape' || e.key === 'Enter' || e.key === ' '
        || e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      document.documentElement.setAttribute('data-input', 'keyboard');
    }
  }
  document.addEventListener('mousedown', setMouse, true);
  document.addEventListener('touchstart', setMouse, true);
  document.addEventListener('keydown', setKeyboard, true);
})();

// ───────────────────────────────────────────────────────────────
//  PALETTE DES PARTIS — 25 teintes
//  Utilisée par les voiles candidats et les KPI rotatifs.
// ───────────────────────────────────────────────────────────────
const PARTI_COLORS = [
  '#063763', '#0C5394', '#0F55CC', '#20124D', '#361C75',
  '#38761D', '#3C78D8', '#46818E', '#6AA84F', '#6D9EEB',
  '#741B47', '#7F6001', '#8E7CC3', '#93C47D', '#980000',
  '#9A5084', '#A0E1E2', '#BF9000', '#CC0100', '#E06667',
  '#EA9999', '#F1C232', '#FF0000', '#FF4D50', '#FF9900'
];

// ───────────────────────────────────────────────────────────────
//  ANIMATION DU LOGO VOILE (.sail-mini > .sail-row)
//  À appeler après que le DOM soit prêt sur les pages qui ont la voile mini
//  dans leur topbar (apropos, methodologie, …). Cycle de couleurs aléatoires
//  prises dans PARTI_COLORS, avec respect de prefers-reduced-motion.
//
//  Note : LRVcarte, LRVanalyse, index ont leur propre implémentation inline
//  (pour des raisons historiques). Cette fonction reproduit le même comportement
//  pour les pages doc.
// ───────────────────────────────────────────────────────────────
function setupSailAnimation() {
  if (typeof PARTI_COLORS === 'undefined' || !PARTI_COLORS.length) return;
  const rows = Array.from(document.querySelectorAll('.sail-mini .sail-row')).reverse();
  if (!rows.length) return;
  // a11y : prefers-reduced-motion → couleur fixe sans animation
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion) {
    const fixed = PARTI_COLORS[Math.floor(Math.random() * PARTI_COLORS.length)];
    rows.forEach(r => { r.style.setProperty('--c1', fixed); r.style.setProperty('--c2', fixed); });
    return;
  }
  const NB = rows.length, SLIDE_DUR = 550, STEP = 200, PAUSE_END = 4000;
  function pickColor(prev) {
    let c; do { c = PARTI_COLORS[Math.floor(Math.random()*PARTI_COLORS.length)]; }
    while (c === prev); return c;
  }
  let curColor = pickColor(null), nextColor = pickColor(curColor), cursor = 0;
  rows.forEach(r => { r.style.setProperty('--c1', curColor); r.style.setProperty('--c2', nextColor); });
  function tick() {
    const row = rows[cursor], target = nextColor;
    row.classList.add('sliding');
    setTimeout(() => {
      row.classList.add('no-trans');
      row.style.setProperty('--c1', target);
      row.classList.remove('sliding');
      void row.offsetWidth;
      row.classList.remove('no-trans');
    }, SLIDE_DUR + 30);
    cursor++;
    let nextDelay = STEP;
    if (cursor >= NB) {
      cursor = 0;
      curColor = nextColor;
      nextColor = pickColor(curColor);
      const newC2 = nextColor;
      setTimeout(() => rows.forEach(r => r.style.setProperty('--c2', newC2)), SLIDE_DUR + 60);
      nextDelay = SLIDE_DUR - STEP + PAUSE_END;
    }
    setTimeout(tick, nextDelay);
  }
  tick();
}

// ───────────────────────────────────────────────────────────────
//  TRI DES ÉLECTIONS — priorité par type
//  Pour départager des élections de la même année.
//  Exceptions chronologiques :
//   • Européennes 2024 (juin) précèdent Législatives 2024 (juillet)
//   • Régionales 2004 (mars) précèdent Européennes 2004 (juin)
// ───────────────────────────────────────────────────────────────
function elecTypePriority(label) {
  if (label.startsWith('Européennes 2024')) return 1.5;
  if (label.startsWith('Régionales 2004'))  return 3.5;
  // ── EXCEPTIONS "même jour" pour Cantonales/Départementales ──
  // Règle : Cantonales/Départementales sont en général à 3.5 (mars typique, avant
  // Régionales décembre). MAIS quand elles ont eu lieu LE MÊME JOUR qu'une autre
  // élection, elles passent JUSTE APRÈS l'autre scrutin (qui prime) pour garder
  // un ordre chronologique cohérent dans l'année.
  //   • Cantonales 1992    = 22 mars 1992 (= Régionales 1992 prio 5)       → 5.2
  //   • Cantonales 1998    = 15 mars 1998 (= Régionales 1998 prio 5)       → 5.2
  //   • Cantonales 2004    = 21 mars 2004 (= Régionales 2004 prio 3.5)     → 3.7
  //   • Cantonales 2008    = 9 mars 2008  (= Municipales 2008 prio 3)      → 3.2
  //   • Départementales 2021 = 20 juin 2021 (= Régionales 2021 prio 5)     → 5.2
  // Cantonales 1988 / 2011 / Départementales 2015 : seules, restent à 3.5.
  if (label.startsWith('Cantonales 1992'))      return 5.2;
  if (label.startsWith('Cantonales 1998'))      return 5.2;
  if (label.startsWith('Cantonales 2004'))      return 3.7;
  if (label.startsWith('Cantonales 2008'))      return 3.2;
  if (label.startsWith('Départementales 2021')) return 5.2;
  // Partielles (hors cycle) : typiquement en cours d'année après les scrutins
  // normaux. On les range en queue (5.5) faute de mieux ; idéalement on
  // utiliserait la date exacte mais ce serait un autre modèle.
  if (/^Cantonale partielle/i.test(label))      return 5.5;
  if (label.startsWith('Présidentielle')) return 1;
  if (label.startsWith('Législatives'))  return 2;
  if (label.startsWith('Municipales'))   return 3;
  // Cantonales/Départementales par défaut : typiquement en mars, donc entre
  // Municipales (3) et Européennes (4). Pour 2015, les Départementales (mars,
  // sans collision) précèdent ainsi les Régionales (décembre, priorité 5).
  if (label.startsWith('Cantonales'))    return 3.5;
  if (label.startsWith('Départementales')) return 3.5;
  if (label.startsWith('Européennes'))   return 4;
  if (label.startsWith('Régionales'))    return 5;
  if (label.startsWith('Référendum'))    return 6;
  return 9;
}

// ───────────────────────────────────────────────────────────────
//  A11y — Contraste auto du texte (WCAG)
//  Calcule la luminance perçue d'une couleur hex (#RGB ou #RRGGBB) et retourne
//  '#fff' ou '#000' pour assurer un contraste lisible. Pour les couleurs claires
//  (jaune CNI, orange MoDem, vert EELV…) ça renvoie '#000', sinon '#fff'.
// ───────────────────────────────────────────────────────────────
function pickTextColor(bgHex) {
  if (!bgHex || typeof bgHex !== 'string') return '#fff';
  let hex = bgHex.trim().replace(/^#/, '');
  // Support #RGB → #RRGGBB
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  if (hex.length !== 6) return '#fff';
  const r = parseInt(hex.slice(0,2), 16);
  const g = parseInt(hex.slice(2,4), 16);
  const b = parseInt(hex.slice(4,6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return '#fff';
  // Luminance perçue (formule YIQ — moins précise que WCAG mais bien suffisante
  // et plus rapide). Seuil 0.6 ajusté empiriquement pour matcher les couleurs
  // partis "limite" (orange MoDem #FF9900, vert EELV).
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? '#000' : '#fff';
}
// Variante pratique pour les backgrounds qui peuvent être soit une couleur unie
// (#RRGGBB) soit un linear-gradient (binôme à 2 vrais partis). On extrait la
// 1ère couleur hex du string et on délègue à pickTextColor. Si pas trouvable
// (ex. var(--css-var)), fallback à '#fff'.
function pickTextColorForBg(bg) {
  if (!bg || typeof bg !== 'string') return '#fff';
  const m = bg.match(/#[0-9a-fA-F]{3,6}/);
  return m ? pickTextColor(m[0]) : '#fff';
}

// ───────────────────────────────────────────────────────────────
//  A11y — Focus trap réutilisable pour modals (WCAG 2.4.3)
//  Usage :
//    const trap = createFocusTrap(modalEl);
//    trap.activate();   // au open du modal
//    trap.deactivate(); // au close
//  Comportement : Tab/Shift+Tab boucle dans les focusables visibles du modal,
//  focus initial sur le 1er focusable à l'activation, restauration du focus
//  précédent à la désactivation.
// ───────────────────────────────────────────────────────────────
function createFocusTrap(modalEl) {
  let prevFocus = null;
  function getFocusables() {
    if (!modalEl) return [];
    const sel = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return [...modalEl.querySelectorAll(sel)].filter(el => el.offsetParent !== null);
  }
  function onKeydown(e) {
    if (e.key !== 'Tab') return;
    const focusables = getFocusables();
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && active === first) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault(); first.focus();
    }
  }
  return {
    activate() {
      prevFocus = document.activeElement;
      document.addEventListener('keydown', onKeydown, true);
      setTimeout(() => {
        const focusables = getFocusables();
        if (focusables.length) focusables[0].focus();
      }, 0);
    },
    deactivate() {
      document.removeEventListener('keydown', onKeydown, true);
      if (prevFocus && typeof prevFocus.focus === 'function') {
        try { prevFocus.focus(); } catch (_) {}
      }
      prevFocus = null;
    },
  };
}

// ───────────────────────────────────────────────────────────────
//  RÉFÉRENDUMS — détection
//  Les référendums (Oui/Non) sont stockés dans ELECTIONS comme les autres
//  scrutins, mais traités différemment côté UI :
//   • LRVcarte : mode bloc désactivé, fiche bureau en duel, question affichée
//   • LRVanalyse : exclus du graphique, du sélecteur, de la frise
// ───────────────────────────────────────────────────────────────
function isReferendum(elecLabel) {
  if (!elecLabel) return false;
  return elecLabel.indexOf('Référendum') === 0;
}

// ───────────────────────────────────────────────────────────────
//  isDraftElection — true si l'élection est marquée `draft: true`
//  dans donnees.js. Une élection draft est :
//    • cachée du dropdown LRVcarte, du sélecteur LRVanalyse
//    • non générée en page scrutin statique (tools/build-scrutins.js)
//    • exclue du tirage daily-capture
//    • ignorée par la navigation prev/next (LRVcarte + triptyque)
//    • absente des fiches candidats (LRVcandidat)
//  Permet d'ajouter une élection complète (data, candidatures,
//  corrections) sans la rendre visible publiquement tant que le
//  flag n'est pas retiré.
// ───────────────────────────────────────────────────────────────
function isDraftElection(elecLabel) {
  if (!elecLabel) return false;
  if (typeof ELECTIONS === 'undefined') return false;
  const e = ELECTIONS[elecLabel];
  return !!(e && e.draft === true);
}
if (typeof window !== 'undefined') window.isDraftElection = isDraftElection;

// ───────────────────────────────────────────────────────────────
//  derivePaForBinome — dérivation systématique du pa d'un binôme
//  depuis ses partis individuels. Décision : on ne stocke plus pa
//  côté binôme dans donnees.js, on le dérive au chargement via un
//  IIFE qui appelle ce helper. Le parti qui compte est celui de
//  chaque candidat (binome_partis), pas une étiquette globale.
//
//  Règles :
//    • bp homogène (pa1 === pa2)               → pa1
//    • DV* + vrai parti                        → vrai parti seul
//      (un binôme "PRG + DVG" reste de famille PRG ; le DVG
//      n'est qu'une étiquette administrative pour le co-équipier
//      non encarté).
//    • 2 vrais partis distincts                → "paF+paH" (femme devant
//      si sexes connus, sinon ordre brut [a, b]).
//    • 2 divers distincts                      → idem (femme devant)
//    • bp invalide                             → '' (caller décide)
//
//  Paramètre sexes : tableau [s0, s1] des sexes des membres dans le
//  même ordre que bp (depuis c.binome → PERSONS[pid].s). Optionnel —
//  si absent on ne réordonne pas (label = ordre brut).
//  Règle paritaire (mai 2026) : la candidate F passe devant l'homme H.
// ───────────────────────────────────────────────────────────────
function derivePaForBinome(bp, sexes) {
  if (!Array.isArray(bp) || bp.length !== 2) return '';
  let a = (bp[0] || '').trim();
  let b = (bp[1] || '').trim();
  if (!a || !b) return a || b || '';
  if (a === b) return a;
  const aDiv = /^DV/i.test(a);
  const bDiv = /^DV/i.test(b);
  // Mixte vrai + divers : on garde le vrai parti seul (lisibilité politique).
  if (aDiv && !bDiv) return b;
  if (bDiv && !aDiv) return a;
  // 2 vrais OU 2 divers : on combine "paF+paH" (femme devant si connue).
  if (Array.isArray(sexes) && sexes.length === 2) {
    if (sexes[0] !== 'F' && sexes[1] === 'F') return b + '+' + a;
  }
  return a + '+' + b;
}

// ───────────────────────────────────────────────────────────────
//  MENU LOGO (dropdown global) — réutilisé par les 4 pages
//
//  Usage :
//    setupAppMenu({ tourFn: 'startCarteTour' });   // LRVcarte
//    setupAppMenu({ tourFn: 'startAnalyseTour' }); // LRVanalyse
//    setupAppMenu();                                // apropos / methodologie (tour désactivé)
//
//  Config :
//    tourFn (string) — nom de la fonction globale à appeler pour la visite guidée.
//                       Si absente : item « Visite guidée » désactivé avec badge « Bientôt ».
//
//  Le bouton déclencheur doit avoir l'id #tb-logo-btn dans le DOM.
//  Le hook window.onThemeChange(theme) est appelé à chaque bascule clair/sombre.
// ───────────────────────────────────────────────────────────────
function setupAppMenu(opts) {
  opts = opts || {};
  function isDark(){ return document.documentElement.getAttribute('data-theme') === 'dark'; }
  function toggleTheme(){
    const next = isDark() ? 'light' : 'dark';
    if (next === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    try { localStorage.setItem('lrvote_theme', next); } catch(e) {}
    if (typeof window.onThemeChange === 'function') window.onThemeChange(next);
  }
  // Item « Visite guidée » : actif si tourFn fourni, sinon désactivé avec badge.
  const tourItem = opts.tourFn
    ? { ico: '🧭', label: 'Visite guidée', action: () => { const f = window[opts.tourFn]; if (f) f(); } }
    : { ico: '🧭', label: 'Visite guidée', disabled: true, badge: 'Bientôt' };
  // Détection de la page courante pour griser les items "La carte" / "L'analyse" déjà actifs.
  const _path = location.pathname || '';
  const _isCarte   = /LRVcarte\.html/i.test(_path);
  const _isAnalyse = /LRVanalyse\.html/i.test(_path);
  // Toggle "Vue mobile" — visible uniquement sur tablette/desktop (screen.width > 720).
  // Sur un vrai smartphone, l'option n'a pas de sens car déjà en mobile.
  function isForcedMobile(){ try { return localStorage.getItem('lrvote_force_mobile') === '1'; } catch(_) { return false; } }
  function toggleForcedMobile(){
    try { localStorage.setItem('lrvote_force_mobile', isForcedMobile() ? '0' : '1'); } catch(_) {}
    location.reload();
  }
  const _showMobToggle = (typeof screen !== 'undefined' && screen.width > 720);
  const mobileToggleItem = _showMobToggle
    ? { dynamic: 'forcedMobile', action: toggleForcedMobile }
    : null;
  // Paths absolus depuis la racine du site — fonctionnent depuis n'importe quel
  // sous-dossier (utile pour /scrutins/<slug>.html notamment).
  const ITEMS = [
    { ico: '🏠', label: 'Accueil', action: () => location.href = '/' },
    { sep: true },
    tourItem,
    { ico: '📐', label: 'Méthodologie & sources', action: () => location.href = '/methodologie.html' },
    { ico: '📤', label: 'Partager cette vue',     action: () => { if (window.openShareModal) window.openShareModal(); } },
    { sep: true },
    { dynamic: 'theme', action: toggleTheme },
    ...(mobileToggleItem ? [mobileToggleItem] : []),
    { sep: true },
    { ico: '📂', label: 'À propos', action: () => location.href = '/apropos.html' }
  ];
  function resolveItem(it){
    if (it.dynamic === 'theme') {
      return { ico: isDark() ? '☀️' : '🌙', label: isDark() ? 'Mode clair' : 'Mode sombre', action: it.action };
    }
    if (it.dynamic === 'forcedMobile') {
      const forced = isForcedMobile();
      return { ico: forced ? '🖥️' : '📱', label: forced ? 'Vue large' : 'Vue mobile', action: it.action };
    }
    return it;
  }
  const css = '.app-menu{position:fixed;background:var(--bg-modal);border:1px solid var(--border-modal);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.12);min-width:260px;padding:6px;z-index:1000;font-family:Space Grotesk,system-ui,sans-serif;display:none;opacity:0;transform:translateY(-4px);transition:opacity .12s,transform .12s}'
    + '.app-menu.open{display:block;opacity:1;transform:translateY(0)}'
    + '.app-menu-item{display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:6px;font-size:.88rem;color:var(--text-modal);cursor:pointer;transition:background .12s;border:none;background:none;width:100%;text-align:left;font-family:inherit}'
    + '.app-menu-item:hover:not(.disabled){background:var(--bg-modal-hover)}'
    + '.app-menu-item.disabled{opacity:.42;cursor:not-allowed}'
    + '.app-menu-item .ico{width:22px;text-align:center;flex-shrink:0;font-size:1rem}'
    + '.app-menu-item .lbl{flex:1;white-space:nowrap}'
    + '.app-menu-item .bad{font-size:.65rem;background:var(--bg-modal-accent);color:var(--text-modal-muted);padding:1px 7px;border-radius:3px;font-weight:600;letter-spacing:.02em}'
    + '.app-menu-sep{height:1px;background:var(--border-modal);margin:4px 6px}'
    /* Duo de cards "La carte / L'analyse" en tête de menu */
    + '.app-menu-hero{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:4px;margin-bottom:4px}'
    + '.app-menu-card{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:14px 8px;border-radius:8px;border:1px solid var(--border-modal);background:var(--bg-modal-hover);cursor:pointer;font-family:inherit;color:var(--text-modal);transition:background .12s,transform .12s,border-color .12s;min-height:78px;text-align:center}'
    + '.app-menu-card:hover:not(.is-current){background:var(--bg-modal-accent);border-color:var(--text-modal-muted)}'
    + '.app-menu-card:active:not(.is-current){transform:scale(0.97)}'
    + '.app-menu-card .ico{font-size:1.4rem;line-height:1}'
    + '.app-menu-card .lbl{font-size:.85rem;font-weight:700;letter-spacing:-0.2px}'
    + '.app-menu-card.is-current{background:var(--bg-active);border-color:var(--bg-active);color:var(--text-active);cursor:default}'
    + '.app-menu-card.is-current .ico{filter:none}';
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  const menu = document.createElement('div');
  menu.className = 'app-menu';
  menu.setAttribute('role', 'menu');
  function renderMenu(){
    // Duo de cards "La carte / L'analyse" en tête de menu — destinations principales
    const heroHtml = '<div class="app-menu-hero">'
      + '<button class="app-menu-card' + (_isCarte ? ' is-current' : '') + '" data-go="carte"'
      +   (_isCarte ? ' aria-current="page"' : '') + ' role="menuitem">'
      +   '<span class="ico" aria-hidden="true">🗺️</span>'
      +   '<span class="lbl">La carte</span>'
      + '</button>'
      + '<button class="app-menu-card' + (_isAnalyse ? ' is-current' : '') + '" data-go="analyse"'
      +   (_isAnalyse ? ' aria-current="page"' : '') + ' role="menuitem">'
      +   '<span class="ico" aria-hidden="true">📊</span>'
      +   '<span class="lbl">L’analyse</span>'
      + '</button>'
      + '</div>'
      + '<div class="app-menu-sep"></div>';
    const itemsHtml = ITEMS.map((it, i) => {
      if (it.sep) return '<div class="app-menu-sep"></div>';
      const r = resolveItem(it);
      return '<button class="app-menu-item' + (r.disabled ? ' disabled' : '') + '" data-i="' + i + '"'
        + (r.disabled ? ' disabled aria-disabled="true"' : '') + ' role="menuitem">'
        + '<span class="ico">' + r.ico + '</span>'
        + '<span class="lbl">' + r.label + '</span>'
        + (r.badge ? '<span class="bad">' + r.badge + '</span>' : '')
        + '</button>';
    }).join('');
    menu.innerHTML = heroHtml + itemsHtml;
    // Hooks sur les cards hero
    menu.querySelectorAll('.app-menu-card').forEach(el => {
      el.addEventListener('click', () => {
        if (el.classList.contains('is-current')) return;
        const dest = el.dataset.go;
        closeMenu();
        if (dest === 'carte')   location.href = '/LRVcarte.html';
        if (dest === 'analyse') location.href = '/LRVanalyse.html';
      });
    });
    menu.querySelectorAll('.app-menu-item').forEach(el => {
      el.addEventListener('click', () => {
        if (el.classList.contains('disabled')) return;
        const i = parseInt(el.dataset.i);
        const it = ITEMS[i];
        const r = resolveItem(it);
        closeMenu();
        if (r && typeof r.action === 'function') r.action();
      });
    });
  }
  renderMenu();
  document.body.appendChild(menu);
  const btn = document.getElementById('tb-logo-btn');
  if (!btn) return;
  function openMenu(){
    renderMenu(); // rafraîchit le label dynamique (Mode sombre / Mode clair)
    const r = btn.getBoundingClientRect();
    menu.style.left = r.left + 'px';
    menu.style.top  = (r.bottom + 6) + 'px';
    menu.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
  }
  function closeMenu(){
    menu.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
  }
  function toggleMenu(){ if (menu.classList.contains('open')) closeMenu(); else openMenu(); }
  btn.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); toggleMenu(); });
  document.addEventListener('click', e => {
    if (!menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) closeMenu();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && menu.classList.contains('open')) closeMenu();
  });
  window.addEventListener('resize', () => { if (menu.classList.contains('open')) openMenu(); });
}

// ───────────────────────────────────────────────────────────────
//  ÈRES CARTOGRAPHIQUES — calculées dynamiquement depuis BUREAU_INFO
// ───────────────────────────────────────────────────────────────
//  ERAS         = liste de toutes les ères présentes en base, triées chronologiquement
//                 (ex. ['1988','1993','1996','2004','2007','2010','2012','2015','2022','2026'])
//  CURRENT_ERA  = la plus récente (= découpage "actuellement en vigueur")
//
//  Pourquoi : avant, ces deux valeurs étaient codées en dur à plusieurs endroits.
//  Conséquence : l'ajout d'une nouvelle ère cartographique nécessitait de toucher
//  au code à plusieurs reprises. Maintenant, il suffit d'ajouter l'ère dans
//  BUREAU_INFO (donnees.js) et tout s'adapte automatiquement.
//
//  Pré-requis : shared.js DOIT être chargé APRÈS donnees.js (qui définit BUREAU_INFO).
//  Si BUREAU_INFO est vide ou absent, on retombe sur ['2026'] / '2026' en sécurité.
(function () {
  if (typeof BUREAU_INFO === 'undefined' || !BUREAU_INFO) {
    window.ERAS = ['2026'];
    window.CURRENT_ERA = '2026';
    return;
  }
  const keys = Object.keys(BUREAU_INFO).filter(k => /^\d{4}$/.test(k)).sort();
  window.ERAS = keys.length ? keys : ['2026'];
  window.CURRENT_ERA = window.ERAS[window.ERAS.length - 1];
})();

// ───────────────────────────────────────────────────────────────
//  ÈRES CANTON — calculées dynamiquement depuis CANTON_INFO
// ───────────────────────────────────────────────────────────────
//  ERAS_CANTON          = liste des ères canton présentes en base, triées
//                         (ex. ['1985','2015'] avec les données actuelles)
//  CURRENT_ERA_CANTON   = la plus récente (= découpage cantonal actif)
//
//  Conventions :
//   • CANTON_INFO[era].era_start = string année (= la clé era)
//   • CANTON_INFO[era].era_end   = string année dernière OU null si actif
//   • CANTON_INFO[era].cantons   = { id: { name, ... } }
//
//  Pré-requis : shared.js DOIT être chargé APRÈS donnees.js (qui définit CANTON_INFO).
//  Si CANTON_INFO est absent (vieille version de donnees.js) : on retombe sur
//  une ère unique "2015" avec les 3 cantons modernes, pour ne rien casser.
(function () {
  if (typeof CANTON_INFO === 'undefined' || !CANTON_INFO) {
    window.ERAS_CANTON = ['2015'];
    window.CURRENT_ERA_CANTON = '2015';
    return;
  }
  const keys = Object.keys(CANTON_INFO).filter(k => /^\d{4}$/.test(k)).sort();
  window.ERAS_CANTON = keys.length ? keys : ['2015'];
  window.CURRENT_ERA_CANTON = window.ERAS_CANTON[window.ERAS_CANTON.length - 1];
})();

// ───────────────────────────────────────────────────────────────
//  HELPERS CANTON
// ───────────────────────────────────────────────────────────────

// Retourne l'ère canton applicable à une ère bureau donnée.
// Règle : on prend la plus récente ère canton dont era_start ≤ era_bureau.
// Ex. era_bureau "1996" → era_canton "1985" (1985 ≤ 1996).
// Ex. era_bureau "2026" → era_canton "2015" (2015 ≤ 2026).
function getCantonEraForBureauEra(era_bureau) {
  if (!era_bureau || typeof CANTON_INFO === 'undefined') return window.CURRENT_ERA_CANTON;
  const eras = (window.ERAS_CANTON || []).slice().sort();
  // On itère du plus récent au plus ancien : la 1re ère ≤ era_bureau est la bonne.
  for (let i = eras.length - 1; i >= 0; i--) {
    if (eras[i] <= era_bureau) return eras[i];
  }
  return eras[0] || window.CURRENT_ERA_CANTON;
}

// Retourne l'ère canton applicable à une élection.
// Priorité : le champ ELECTIONS[label].my_canton s'il existe (explicite).
// Sinon : on dérive depuis ELECTIONS[label].my (l'ère bureau) via getCantonEraForBureauEra.
function getCantonEraForElection(electionLabel) {
  if (typeof ELECTIONS === 'undefined' || !ELECTIONS[electionLabel]) return window.CURRENT_ERA_CANTON;
  const e = ELECTIONS[electionLabel];
  if (e.my_canton) return String(e.my_canton);
  if (e.my) return getCantonEraForBureauEra(String(e.my));
  return window.CURRENT_ERA_CANTON;
}

// Retourne l'id canton d'un bureau pour une ère bureau donnée (ou null si non
// affecté — cas du bureau 0057 "Français de l'étranger" qui n'a pas de canton).
function getCantonOfBureau(bureau, era_bureau) {
  if (typeof BUREAU_INFO === 'undefined') return null;
  const era = era_bureau || window.CURRENT_ERA;
  const b = (BUREAU_INFO[era] || {})[bureau];
  return (b && b.c) ? String(b.c) : null;
}

// Retourne tous les bureaux appartenant à un canton pour une ère bureau donnée.
function getBureauxOfCanton(canton_id, era_bureau) {
  if (typeof BUREAU_INFO === 'undefined') return [];
  const era = era_bureau || window.CURRENT_ERA;
  const out = [];
  Object.entries(BUREAU_INFO[era] || {}).forEach(([bid, b]) => {
    if (b && String(b.c) === String(canton_id)) out.push(bid);
  });
  return out;
}

// Vrai si une ère canton est encore active une année donnée (ou en cours).
// Utilisé par l'analyse pour tronquer les courbes des cantons "morts".
function isCantonEraAlive(era_canton, year) {
  if (typeof CANTON_INFO === 'undefined' || !CANTON_INFO[era_canton]) return false;
  const info = CANTON_INFO[era_canton];
  const start = info.era_start ? parseInt(info.era_start, 10) : null;
  const end = info.era_end ? parseInt(info.era_end, 10) : null;
  const y = parseInt(year, 10);
  if (start && y < start) return false;
  if (end && y > end) return false;
  return true;
}

// Vrai si une élection est de type cantonal/départemental.
// Sécurité : utilise regex sur le label pour ne pas dépendre d'une convention
// spécifique (ex. ELECTIONS[label].scrutin_type). Accepte le singulier pour les
// partielles (ex. "Cantonale partielle 2002") qui ne portent que sur 1 canton.
function isCantonalElection(electionLabel) {
  if (!electionLabel) return false;
  return /^(Cantonale[s]?|Départementale[s]?)\b/i.test(electionLabel);
}

// Pour une élection cantonale dont le label se termine par "— La Rochelle-N",
// retourne le cid ("1", "2", "3", ...). Sinon null.
// Exemple : "Départementales 2015 — La Rochelle-1" → "1"
function getCantonOfElection(electionLabel) {
  if (!electionLabel) return null;
  const m = String(electionLabel).match(/—\s*La Rochelle-(\d+)\s*$/);
  return m ? m[1] : null;
}

// ───────────────────────────────────────────────────────────────
//  VALIDATION DES DONNÉES — warnings console au démarrage
// ───────────────────────────────────────────────────────────────
//  Détecte les incohérences silencieuses dans donnees.js qui pourraient
//  causer des bugs subtils (ex. élection sans `my` → fallback sur CURRENT_ERA
//  qui peut shifter dans le futur, ou `my` pointant sur une ère absente
//  de BUREAU_INFO → lookups vides). Affiche les problèmes en console au
//  premier chargement de la page.
//
//  Production : silencieux quand tout va bien. En cas de problème : un bloc
//  console.warn lisible avec la liste des entrées à corriger.
(function validateData() {
  if (typeof ELECTIONS === 'undefined' || !ELECTIONS) return;
  const validEras = new Set(window.ERAS || []);
  const warnings = [];

  Object.entries(ELECTIONS).forEach(([label, data]) => {
    if (!data) {
      warnings.push('ELECTION vide : "' + label + '"');
      return;
    }
    // Propriété `my` (year-era) manquante → fallback dangereux sur CURRENT_ERA
    if (data.my === undefined || data.my === null) {
      warnings.push('ELECTION sans `my` : "' + label
        + '" → fallback sur CURRENT_ERA (' + window.CURRENT_ERA
        + '). Ajouter la propriété `my` dans donnees.js.');
    } else if (!validEras.has(String(data.my))) {
      // `my` pointe sur une ère qui n'existe pas dans BUREAU_INFO
      warnings.push('ELECTION "' + label + '" pointe sur l\'ère "' + data.my
        + '" introuvable dans BUREAU_INFO. Vérifier l\'orthographe ou ajouter '
        + 'BUREAU_INFO["' + data.my + '"] dans donnees.js.');
    }
    // Aucun tour défini → la page ne pourra rien afficher
    if (!data.sheets || !Object.keys(data.sheets).length) {
      warnings.push('ELECTION "' + label + '" sans aucun tour (sheets vide).');
    }
  });

  if (warnings.length) {
    console.warn('━'.repeat(64));
    console.warn('La Rochelle Vote — Validation des données : ' + warnings.length + ' avertissement(s)');
    console.warn('━'.repeat(64));
    warnings.forEach(w => console.warn('  ⚠️  ' + w));
    console.warn('━'.repeat(64));
  }
})();

// ───────────────────────────────────────────────────────────────
//  PASTILLE "SOUTENIR" — sur toutes les pages sauf l'index
// ───────────────────────────────────────────────────────────────
//  Petit appel à contribution discret en bas à droite. Au clic, ouvre une
//  modal reprenant le texte et les liens Stripe de la section 7 d'apropos.html.
//  Sur mobile : encore plus discret (icône seule, opacité réduite).
//  Position élevée sur LRVcarte mobile (bottom:70px) pour ne pas chevaucher
//  la légende des modes carte.
(function setupSoutenirPill() {
  if (typeof document === 'undefined' || !document.body) {
    // body pas encore prêt → on attend DOMContentLoaded
    document.addEventListener('DOMContentLoaded', setupSoutenirPill);
    return;
  }
  // Skip uniquement sur la page d'accueil (qui a déjà son propre appel)
  const path = (location.pathname || '').toLowerCase();
  if (/(^\/?$)|(\/index\.html?$)/.test(path)) return;

  // Détection page carte (pour ajuster le positionnement mobile)
  const isCarte = /lrvcarte\.html?$/i.test(path);

  // CSS injecté une seule fois
  const css = `
#soutenir-pill {
  position: fixed;
  /* LRVcarte : au-dessus du footer (~24 px). Autres pages : marge standard */
  bottom: ${isCarte ? '32px' : '14px'};
  right: 14px;
  z-index: 100;
  display: inline-flex; align-items: center; gap: 5px;
  padding: 5px 10px;
  background: rgba(255,255,255,0.78);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  color: var(--text-chrome-muted, #6A6A6A);
  font-size: 0.72rem;
  font-weight: 500;
  border-radius: 999px;
  border: 1px solid rgba(0,0,0,0.06);
  box-shadow: 0 2px 8px rgba(0,0,0,0.06);
  cursor: pointer;
  font-family: inherit;
  opacity: 0.7;            /* discret par défaut */
  transition: opacity 0.18s, transform 0.15s, color 0.18s;
}
#soutenir-pill:hover {
  opacity: 1;
  color: var(--text-chrome, #1A1A1A);
  transform: translateY(-1px);
}
#soutenir-pill:active { transform: translateY(0); }
[data-theme="dark"] #soutenir-pill {
  background: rgba(40,40,40,0.78);
  color: var(--text-chrome-muted, #999);
  border-color: rgba(255,255,255,0.08);
}
@media (max-width: 720px) {
  /* Mobile : encore plus discret — icône seule, très petit, opacité basse */
  #soutenir-pill {
    bottom: ${isCarte ? '64px' : '12px'};
    right: 8px;
    padding: 5px;
    width: 28px; height: 28px;
    justify-content: center;
    opacity: 0.5;
    box-shadow: none;
    background: rgba(255,255,255,0.6);
  }
  #soutenir-pill:hover { opacity: 1; }
  #soutenir-pill .sp-text { display: none; }
  #soutenir-pill .sp-icon { font-size: 0.95rem; }
}

/* Modal */
#soutenir-modal {
  position: fixed; inset: 0; display: none; z-index: 10500;
  font-family: 'Space Grotesk','Segoe UI',system-ui,sans-serif;
}
#soutenir-modal.open { display: block; }
.ssm-overlay {
  position: absolute; inset: 0;
  background: rgba(0,0,0,0.45);
  opacity: 0; transition: opacity 0.18s;
}
#soutenir-modal.open .ssm-overlay { opacity: 1; }
.ssm-card {
  position: absolute; top: 50%; left: 50%;
  transform: translate(-50%, -50%) scale(0.96);
  background: var(--bg-modal, #fff);
  color: var(--text-modal, #1A1A1A);
  border-radius: 12px;
  width: 480px; max-width: calc(100vw - 32px);
  padding: 22px 24px 24px;
  box-shadow: 0 12px 40px rgba(0,0,0,0.28);
  opacity: 0; transition: opacity 0.18s, transform 0.18s;
}
#soutenir-modal.open .ssm-card { opacity: 1; transform: translate(-50%, -50%) scale(1); }
.ssm-card h3 { margin: 0 0 14px; font-size: 1.05rem; font-weight: 700; padding-right: 32px; }
.ssm-card p { margin: 0 0 12px; font-size: 0.92rem; line-height: 1.55; color: var(--text-modal-muted, #555); }
.ssm-actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 16px; }
.ssm-btn {
  flex: 1; min-width: 140px;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  padding: 11px 14px; border-radius: 8px;
  text-decoration: none; font-weight: 600; font-size: 0.9rem;
  letter-spacing: 0.01em;
  transition: filter 0.15s, transform 0.1s;
}
.ssm-btn:hover { filter: brightness(1.08); }
.ssm-btn:active { transform: translateY(1px); }
.ssm-btn.warm { background: var(--accent-warm, #c47a40); color: #fff; }
.ssm-btn.cool { background: var(--text-chrome, #1A1A1A); color: var(--bg-card, #fff); }
.ssm-close {
  position: absolute; top: 12px; right: 12px;
  background: rgba(0,0,0,0.06); border: none;
  width: 28px; height: 28px; border-radius: 6px;
  cursor: pointer; font-size: 1rem;
  color: var(--text-modal-muted, #555);
  display: flex; align-items: center; justify-content: center;
  font-family: inherit;
}
.ssm-close:hover { background: rgba(0,0,0,0.12); }
`;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // Pill
  const pill = document.createElement('button');
  pill.id = 'soutenir-pill';
  pill.type = 'button';
  pill.setAttribute('aria-label', 'Soutenir le projet');
  pill.innerHTML = '<span class="sp-icon" aria-hidden="true">💛</span><span class="sp-text">Soutenir</span>';
  document.body.appendChild(pill);

  // Modal — texte aligné sur la section 7 d'apropos.html
  const modal = document.createElement('div');
  modal.id = 'soutenir-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'ssm-title');
  modal.innerHTML = `
    <div class="ssm-overlay" aria-hidden="true"></div>
    <div class="ssm-card">
      <button class="ssm-close" type="button" aria-label="Fermer">&times;</button>
      <h3 id="ssm-title">Soutenir La Rochelle Vote</h3>
      <p><strong>La&nbsp;Rochelle&nbsp;Vote</strong> est entièrement bénévole et auto-financé. La compilation des archives électorales, la numérisation des cartes anciennes, le développement du site et la veille des nouveaux scrutins demandent un travail régulier — qui se poursuivra scrutin après scrutin.</p>
      <p>Si vous souhaitez soutenir le projet, afin d'en alléger le coût pour l'autrice, deux options&nbsp;: un don ponctuel ou un abonnement mensuel régulier.</p>
      <div class="ssm-actions">
        <a class="ssm-btn warm" href="https://buy.stripe.com/cNi9AU3IH3Vh6DZ2VM4ko00" target="_blank" rel="noopener">☕ Offrir un café</a>
        <a class="ssm-btn cool" href="https://buy.stripe.com/8x2cN6931fDZaUfbsi4ko01" target="_blank" rel="noopener">❤️ Soutien mensuel</a>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  // Bindings
  function open() { modal.classList.add('open'); document.body.style.overflow = 'hidden'; }
  function close() { modal.classList.remove('open'); document.body.style.overflow = ''; }
  pill.addEventListener('click', open);
  modal.querySelector('.ssm-overlay').addEventListener('click', close);
  modal.querySelector('.ssm-close').addEventListener('click', close);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && modal.classList.contains('open')) close();
  });
})();

// ───────────────────────────────────────────────────────────────
//  HELPERS PERSONS / CANDIDATURES (migration M4)
//  API uniformisée d'accès aux nouvelles structures (donnees.js).
//  Cohabite avec CAND_DATA tant que tous les call sites n'ont pas migré.
// ───────────────────────────────────────────────────────────────

// Retourne l'objet PERSON par son id (ex. "alain-bucherie") ou null.
function personById(pid) {
  return (typeof PERSONS !== 'undefined' && PERSONS[pid]) || null;
}

// Retourne l'objet CANDIDATURE par son id (ex. "alain-bucherie@cantonales-2004") ou null.
function candById(cid) {
  return (typeof CANDIDATURES !== 'undefined' && CANDIDATURES[cid]) || null;
}

// Retourne la candidature mergée avec l'identité de sa personne (ou des 2 membres
// pour un binôme). Champs identité (p/n/s) viennent de PERSONS, le reste de la
// CANDIDATURE. Pour un binôme, on ajoute `binome_members: [person1, person2]`.
function candFullInfo(cid) {
  const c = candById(cid);
  if (!c) return null;
  if (c.person) {
    const p = personById(c.person);
    if (p) return { p: p.p, n: p.n, s: p.s, ...c };
    return { ...c };
  }
  if (Array.isArray(c.binome) && c.binome.length === 2) {
    const m1 = personById(c.binome[0]);
    const m2 = personById(c.binome[1]);
    return { ...c, binome_members: [m1, m2] };
  }
  return { ...c };
}

// Toutes les candidatures (cand_id, candidature) d'une personne — y compris
// celles où elle apparaît comme membre d'un binôme. Triées chronologiquement
// via l'année extraite de l'élection (fallback 0 si pas d'année).
function candidaturesOfPerson(pid) {
  if (typeof CANDIDATURES === 'undefined') return [];
  const result = [];
  for (const cid of Object.keys(CANDIDATURES)) {
    const c = CANDIDATURES[cid];
    if (c.person === pid || (Array.isArray(c.binome) && c.binome.indexOf(pid) >= 0)) {
      result.push([cid, c]);
    }
  }
  result.sort((a, b) => {
    const ya = (a[1].election.match(/\d{4}/) || [0])[0];
    const yb = (b[1].election.match(/\d{4}/) || [0])[0];
    return parseInt(ya) - parseInt(yb);
  });
  return result;
}

// Toutes les candidatures d'une élection donnée.
function candidaturesOfElection(electionLabel) {
  if (typeof CANDIDATURES === 'undefined') return [];
  const result = [];
  for (const cid of Object.keys(CANDIDATURES)) {
    if (CANDIDATURES[cid].election === electionLabel) result.push([cid, CANDIDATURES[cid]]);
  }
  return result;
}
