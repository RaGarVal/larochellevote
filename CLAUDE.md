# CLAUDE.md — La Rochelle Vote

Notes pour les sessions Claude Code. Convention : commentaires et UX en français.

---

## 🗂️ Architecture du projet

| Fichier | Rôle |
|---|---|
| `index.html` | Home avec KPI animés (calculés dynamiquement depuis les données) |
| `LRVcarte.html` | Page carte interactive (Leaflet) |
| `LRVanalyse.html` | Page d'analyse statistique (courbes, blocs, familles) |
| `apropos.html`, `methodologie.html` | Pages éditoriales |
| `donnees.js` | **Single source of truth** : ELECTIONS, BUREAU_INFO, CAND_DATA, PARTI_NAMES, BLOC_CONFIG, BLOC_LEGACY, REDECOUPAGES (~1 MB) |
| `geodata.js` | GeoJSON des bureaux par ère cartographique |
| `shared.js` | Helpers communs (ERAS, CURRENT_ERA dynamiques, `isReferendum`, etc.) |
| `editeur_candidats.html` | Éditeur des mappings candidat / parti (utilisé en local) |
| `daily-capture.js` | Génère le tweet quotidien (Puppeteer + capture image) |
| `post-bluesky.js` | Publie sur Bluesky |
| `candidats_blocs.xlsx` | Source Excel des mappings (fournie par le user) |

## 🔑 Conventions de données

### Format `donnees.js`
- `ELECTIONS[<Nom>].sheets[<Tour>][<NumBureau>]` = `{ a, i, e, bn, c, w }`
  - `a` = abstention % | `i` = inscrits | `e` = exprimés | `bn` = blancs+nuls (entier)
  - `c` = **VOIX ENTIÈRES** par candidat (un IIFE en fin de `donnees.js` convertit en `bd.c = pct` et sauvegarde dans `bd._voix` au chargement)
  - `w` = gagnant déclaré (string unique, même en cas d'ex-aequo)
- Tours : `'T1'`, `'T2'`, `'TU'` (tour unique pour Européennes / Régionales 1998 / Référendums)
- Ères cartographiques : clés à 4 chiffres dans `BUREAU_INFO` (`'1988'`, `'1993'`, `'1996'`, `'2004'`, `'2007'`, `'2010'`, `'2012'`, `'2015'`, `'2022'`, `'2026'`)
- `CURRENT_ERA` et `ERAS` calculés dynamiquement dans `shared.js` — **jamais hardcoder une année**.

### `CAND_DATA` — lookup à 3 niveaux
La fonction `candInfo(name)` dans LRVcarte essaie dans cet ordre :
1. `CAND_DATA["Nom|Election|Tour"]` (override le plus spécifique)
2. `CAND_DATA["Nom|Election"]`
3. `CAND_DATA["Nom"]` (générique)

**⚠️ Pièges** : la plupart des autres call sites n'utilisent que 2 niveaux (sans `|Tour`). Donc pour un override par élection, préférer le format `|Election` (sans tour) sauf si on veut vraiment distinguer T1/T2.

### `CAND_DATA[<clé>]` complet
`{ p: prénom, n: nom, b: bloc (G/C/D/EXD/?), t: [familles], c: couleur hex, pa: code parti, bk: clé fine (exg/grg/g/eco/c/d/ds/exd/?), al: alliances }`

### Bureau `0057`
Bureau non-géographique (Français de l'étranger / détenus). Exclu de la plupart des calculs via `NON_GEO = new Set(['0057'])`.

---

## ➕ Procédure complète : Ajouter une élection

### Étape 0 — Pré-requis
Demander à l'utilisateur :
- **Nom officiel** de l'élection (convention `<Type> <Année>` : Présidentielle, Législatives, Municipales, Régionales, Européennes, Référendum).
- **Date(s)** des tours.
- **Type de scrutin** (TU / T1+T2).
- **Excel** de saisie (chemin local). Format attendu :
  - Colonnes 1-7 : `Num | Nom officiel | Dénomination | Quartier | Canton | BN% | Abst%`
  - Colonnes %_cand (N candidats) — **non fiables** (Excel a tendance à mal trier ces colonnes)
  - Colonnes voix_cand (N candidats) — **source de vérité**
  - Colonnes Totaux gauche/droite/écolos (souvent buggées, ignorer)
  - Colonnes finales : `Inscrits | Votants | Abstention | Blancs+nuls | Exprimés`

### Étape 1 — Lire et valider l'Excel
Script Python avec `openpyxl` (déjà disponible). Pour chaque bureau :
- Extraire voix col 30+ (ou équivalent selon position des colonnes voix)
- `sum_voix` doit égaler `exprimés_déclaré`. **Sinon flag** → demander au user de corriger l'Excel.
- Recalculer pct = voix/exprimés × 100 (ignorer les % de l'Excel).
- Détecter les nouveaux candidats (clés inexistantes dans `CAND_DATA`) et nouveaux partis (inexistants dans `PARTI_NAMES`).

Choisir l'**ère cartographique** : prendre celle qui matche le nombre de bureaux de l'Excel, parmi les clés `\d{4}` de `BUREAU_INFO`. Ou se caler sur une élection voisine déjà présente.

### Étape 2 — Injection initiale (Étape A)
Patcher `donnees.js` via un script Python (`patch_const_object` avec regex sur les const top-level) :

1. **`ELECTIONS["<Nom>"]`** :
   ```js
   { "my": "<ère>", "sheets": { "TU": { "0001": { "a":..., "i":..., "e":..., "bn":..., "c": { "Cand1": <voix>, ... }, "w": "<gagnant>" } } } }
   ```
   ⚠️ `c` en **VOIX ENTIÈRES** (pas pct). L'IIFE en fin de donnees.js fait la conversion.

2. **`CAND_DATA[<clé>]` minimal** pour chaque nouveau candidat :
   ```js
   { "n": "<Nom>", "pa": "<code parti>" }
   ```
   Laisser vides `p`, `b`, `bk`, `c`, `t`, `al` — l'utilisateur les remplira via l'éditeur.

3. **`PARTI_NAMES[<code>] = ""`** pour chaque nouveau parti (placeholder).

4. **Overrides éventuels** : ex. `CAND_DATA["Le Pen FN|Européennes 1994"]` complet si la clé générique pointe vers un autre individu.

### Étape 3 — User édite via `editeur_candidats.html`
1. Ouvrir `editeur_candidats.html` en local (sert depuis le système de fichier).
2. Onglet **Partis** : trouver les nouveaux partis (marqués `(non défini)`), remplir nom + couleur.
3. Onglet **Candidats** : filtre `Tous blocs > ?` pour voir les nouveaux candidats avec `b=?`. Pour chacun : prénom, bloc (via `bk`), couleur, familles `t`, alliances `al`.
4. Cliquer **Exporter →**, copier le contenu, le coller dans le chat.

### Étape 4 — Appliquer les corrections (Étape C)
Script Python qui applique :
- `CAND_CORRECTIONS` → assign sur `CAND_DATA[k]`
- `BK_CORRECTIONS` → set `bk` + dériver `b` via `BLOC_LEGACY`
- `PARTI_CORRECTIONS` → assign sur `PARTI_NAMES`

**Cleanup à faire** : si l'user a renommé un parti placeholder (ex. créé `LV` mais aussi `Verts` reste comme placeholder vide), supprimer les placeholders devenus orphelins. Vérifier avec un grep que plus aucun candidat ne référence le placeholder avant suppression.

### Étape 5 — Mises à jour statiques
- **`LRVcarte.html`** : ajouter `<option value="<Nom>">...</option>` dans le bon `<optgroup>` du dropdown élections (autour de la ligne 1515).
- **`LRVcarte.html`** : ajouter le nom dans `const HAS_TU = new Set([...])` si l'élection est à tour unique (autour de la ligne 1672).
- **`daily-capture.js`** : vérifier que `DATES["<Nom>"]` existe (autour de la ligne 171).
- **`index.html`, `LRVcarte.html`, `LRVanalyse.html`** : mettre à jour le nombre d'élections dans la description JSON-LD (`"N élections et 2 référendums organisés..."`).
- **`methodologie.html`** : retirer de la phrase "Depuis 1988, il manque..." si applicable.

### Étape 6 — Sanity checks
Script Node qui charge donnees.js et vérifie :
- Top 5 ville cohérent avec ce que l'user attend.
- Toutes les couleurs résolues (pas de `#bbbbbb` gris) — utiliser le fallback `getPartiColor` mentalement.
- Aucun candidat ne référence un parti inexistant (orphelin).
- L'élection apparaît bien dans `Object.keys(ELECTIONS)`.

**Test visuel** : ouvrir `LRVcarte.html#election=<NomEncodé>` localement et vérifier carte + dropdown + tooltip + fiche bureau + minimap globale.

---

## 🐛 Pièges connus

### Format `bd.c` voix vs pct
**À l'écriture** dans `donnees.js` : VOIX entières.
**Au runtime** après l'IIFE : pct floats + `_voix` en sauvegarde.
Si on stocke par erreur en pct, l'IIFE re-divise → valeurs aberrantes. Symptôme : sommes des c par bureau = 20% au lieu de 100%.

### Excel : colonnes % désynchronisées
Le fichier xlsx standard a un bug : les colonnes % (cols 8-26 typiquement) ont été triées par valeur sans que les headers le soient → l'association cand↔pct est cassée. **Toujours utiliser les colonnes voix** (cols 30-48) et recalculer les pct.

### Bureaux avec écart voix ≠ exprimés
Pas rare en saisie manuelle. Lister les bureaux concernés et demander à l'user de corriger l'Excel.

### Hachures ex-aequo
- Géré automatiquement par `tieCandidatesForBureau()` (basé sur `_voix` entiers).
- SVG `<pattern>` injecté dans `<svg id="lrv-tie-patterns">` (host global au body, partagé entre toutes les maps Leaflet).
- Côté légende : chaque candidat à égalité compte +1, signalé par `▤` avec tooltip.
- **Export image (canvas)** : Canvas2D ne lit pas `url(#tie-...)`. `drawCarteVisual()` détecte le préfixe `url(#tie-` dans `style.fillColor` et le traduit en `CanvasPattern` via `getCanvasTiePattern()` (tile pré-rendu + `pattern.setTransform(new DOMMatrix().rotate(45))`). Si tu ajoutes une nouvelle visu canvas qui utilise `featureStyle`, applique la même traduction.

### Candidat sans couleur propre
Fallback automatique via `getPartiColor(pa)` : on hérite de la couleur du 1er candidat connu du même parti. Si aucun candidat du parti n'a de couleur → gris `#bbbbbb`. À éviter en demandant à l'user de définir une couleur via l'éditeur.

### Éditeur : bug de propagation couleur parti (corrigé)
Avant : la propagation sautait les candidats sans couleur (`r.c !== oldColor` était toujours vrai). Corrigé en `r.c && r.c !== oldColor` pour ne sauter que les vrais overrides.

### Override `|Election|Tour` non vu par tous les call sites
Si tu mets `CAND_DATA["X|Election|TU"]`, seule `candInfo()` (LRVcarte) le trouve. Toutes les autres lectures n'inspectent que `|Election`. Pour les TU, préférer `CAND_DATA["X|Election"]` (sans tour).

### `daily-capture.js` cascade > 280 chars
Le script choisit un niveau (carte/bureau/quartier/global), et si le texte dépasse 280 chars, il cascade vers un niveau plus large. La variable `niveauFinal` capture ce niveau réel. **Toujours utiliser `niveauFinal`** (pas `niveau`) pour :
- L'URL de capture (`urlNiveau = niveauFinal.replace(' (forcé)', '')`)
- Le selector de fallback screenshot

### `cityWinner` vs `carteSubject` (daily-capture)
- `cityWinner` = TOUJOURS le vrai gagnant ville (`cityData.ranked[0]`), utilisé par les canvas `global_*`.
- `carteSubject` = sujet du canva `carte_*` (peut être un candidat tiré pondéré en mode `subCarte='candidat'`).
- Ne pas mélanger : sinon une cascade carte/candidat → global affiche "X arrive en tête" pour un non-gagnant.

### Résolution du hash `#bureau=XXXX`
Dans LRVcarte ligne 4366, priorité au match direct `numStr(f) === bid` AVANT le mapping `b2026 === bid`. Sinon les liens daily-capture vers une élection ancienne ouvrent le mauvais bureau (renuméroté en 2026).

---

## 📋 Quick commands

```bash
# Tester daily-capture en local (sans publier)
LOCAL=1 node daily-capture.js

# Forcer un tirage spécifique
LOCAL=1 FORCE_NIVEAU=bureau FORCE_ELECTION="Législatives 2012" FORCE_TOUR=T1 FORCE_BUREAU=0003 node daily-capture.js

# Régénérer les icônes PWA
node tools/generate-pwa-icons.js
```

---

## 🧠 Préférences de travail (rappel)

- **Toujours demander avant de coder** quand le user pose une question ouverte (cf. retours session sur le "demande mon avis avant de coder").
- **Commenter en français** dans le code.
- **Respecter le style** existant (compact JSON inline dans donnees.js, etc.).
- **Sanity check après chaque modif data** : top ville, somme exprimés, candidats orphelins.
- **Ne pas auto-corriger** les typos visibles dans les exports de l'éditeur sans demander (cf. épisode Gluckstein "Daviel" → "Daniel" : le user a finalement validé "Daniel" mais avait re-tapé "Daviel" entre temps).
