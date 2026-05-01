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
//  TRI DES ÉLECTIONS — priorité par type
//  Pour départager des élections de la même année.
//  Exceptions chronologiques :
//   • Européennes 2024 (juin) précèdent Législatives 2024 (juillet)
//   • Régionales 2004 (mars) précèdent Européennes 2004 (juin)
// ───────────────────────────────────────────────────────────────
function elecTypePriority(label) {
  if (label.startsWith('Européennes 2024')) return 1.5;
  if (label.startsWith('Régionales 2004'))  return 3.5;
  if (label.startsWith('Présidentielle')) return 1;
  if (label.startsWith('Législatives'))  return 2;
  if (label.startsWith('Municipales'))   return 3;
  if (label.startsWith('Européennes'))   return 4;
  if (label.startsWith('Régionales'))    return 5;
  if (label.startsWith('Référendum'))    return 6;
  return 9;
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
  const ITEMS = [
    { ico: '🏠', label: 'Accueil', action: () => location.href = 'index.html' },
    { sep: true },
    tourItem,
    { ico: '📐', label: 'Méthodologie & sources', action: () => location.href = 'methodologie.html' },
    { ico: '📤', label: 'Partager cette vue',     action: () => { if (window.openShareModal) window.openShareModal(); } },
    { sep: true },
    { dynamic: 'theme', action: toggleTheme },
    { sep: true },
    { ico: '📂', label: 'À propos', action: () => location.href = 'apropos.html' }
  ];
  function resolveItem(it){
    if (it.dynamic === 'theme') {
      return { ico: isDark() ? '☀️' : '🌙', label: isDark() ? 'Mode clair' : 'Mode sombre', action: it.action };
    }
    return it;
  }
  const css = '.app-menu{position:fixed;background:var(--bg-modal);border:1px solid var(--border-modal);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.12);min-width:240px;padding:6px;z-index:1000;font-family:Space Grotesk,system-ui,sans-serif;display:none;opacity:0;transform:translateY(-4px);transition:opacity .12s,transform .12s}'
    + '.app-menu.open{display:block;opacity:1;transform:translateY(0)}'
    + '.app-menu-item{display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:6px;font-size:.88rem;color:var(--text-modal);cursor:pointer;transition:background .12s;border:none;background:none;width:100%;text-align:left;font-family:inherit}'
    + '.app-menu-item:hover:not(.disabled){background:var(--bg-modal-hover)}'
    + '.app-menu-item.disabled{opacity:.42;cursor:not-allowed}'
    + '.app-menu-item .ico{width:22px;text-align:center;flex-shrink:0;font-size:1rem}'
    + '.app-menu-item .lbl{flex:1;white-space:nowrap}'
    + '.app-menu-item .bad{font-size:.65rem;background:var(--bg-modal-accent);color:var(--text-modal-muted);padding:1px 7px;border-radius:3px;font-weight:600;letter-spacing:.02em}'
    + '.app-menu-sep{height:1px;background:var(--border-modal);margin:4px 6px}';
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  const menu = document.createElement('div');
  menu.className = 'app-menu';
  menu.setAttribute('role', 'menu');
  function renderMenu(){
    menu.innerHTML = ITEMS.map((it, i) => {
      if (it.sep) return '<div class="app-menu-sep"></div>';
      const r = resolveItem(it);
      return '<button class="app-menu-item' + (r.disabled ? ' disabled' : '') + '" data-i="' + i + '"'
        + (r.disabled ? ' disabled aria-disabled="true"' : '') + ' role="menuitem">'
        + '<span class="ico">' + r.ico + '</span>'
        + '<span class="lbl">' + r.label + '</span>'
        + (r.badge ? '<span class="bad">' + r.badge + '</span>' : '')
        + '</button>';
    }).join('');
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
