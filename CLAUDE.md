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
| `scrutins/*.html` | **Pages scrutin statiques** (générées) — une par scrutin/canton, vitrines SEO Google + partage social |
| `scrutins/share/*.png` | Images OG (1200×630, ~100 KB) — vraies vignettes LRVcarte (carte choroplèthe + fiche) générées via Puppeteer |
| `tools/build-scrutins.js` | Générateur des pages `/scrutins/` + `sitemap.xml` (ré-exécuter après modif de `donnees.js`) |
| `tools/check-scrutins.js` | Sanity check des pages `/scrutins/` (winners cohérents, pas d'`undefined`) |
| `tools/generate-scrutin-og-images.js` | Génère les vignettes OG via Puppeteer + `window.composeFiche` (à relancer si rendu LRVcarte évolue) |

## 🔑 Conventions de données

### ⚠️ PRINCIPE FONDAMENTAL : **la base de tout, c'est les voix entières**

Tous les calculs, agrégations, affichages et tests d'égalité partent des **voix entières** (`bd._voix[cand_id]`). Jamais d'une somme de pourcentages, jamais d'une reconstitution `pct × exprimés / 100`. C'est une règle absolue, indépendante de la couche d'affichage.

Pourquoi : les pourcentages stockés dans `bd.c` (après l'IIFE de chargement) sont des floats arrondis, et toute somme/multiplication propage des erreurs. Un cumul sur un canton/quartier/ville peut décaler le total d'1 voix (« Moulinier 782 » au lieu de 781 réel — bug observé en 2026, cf. commit `6ef7e15`).

**Règles pratiques** :
- Source de vérité runtime = `bd._voix[cid]` (entier, posé par l'IIFE de `donnees.js`). Le `bd.c[cid]` (pct) reste pour l'affichage rapide bureau-par-bureau et le rendu carte.
- **Agrégations** (canton, quartier, ville) : sommer `bd._voix[cid]` à travers les bureaux. JAMAIS sommer `bd.c[cid] * bd.e / 100`.
- **Pourcentages agrégés** : `sum_voix / sum_exprimés × 100`, puis arrondi à 1 décimale pour l'affichage. Pas l'inverse.
- **Affichage des voix** : si on a un `data._voix[cid]` dérivé (= entier exact), l'utiliser direct. Le fallback `Math.round(pct × e / 100)` n'est toléré que pour les anciennes données sans `_voix` (legacy).
- **Tests d'égalité (ex-aequo)** : `tieCandidatesForBureau()` utilise `_voix` et pas `c` — déjà documenté ailleurs. Idem partout où une comparaison stricte est requise.

Si tu touches au code des fiches (bureau, quartier, canton, ville) ou aux agrégats des sidebars, vérifie en lecture **d'abord** d'où viennent les voix : depuis `_voix` ou reconstituées ? Si reconstituées, c'est probablement un bug.

### Format `donnees.js`
- `ELECTIONS[<Nom>].sheets[<Tour>][<NumBureau>]` = `{ a, i, e, bn, c, w }`
  - `a` = abstention % | `i` = inscrits | `e` = exprimés | `bn` = blancs+nuls (entier)
  - `c` = **VOIX ENTIÈRES** par candidat (un IIFE en fin de `donnees.js` convertit en `bd.c = pct` et sauvegarde dans `bd._voix` au chargement)
  - `w` = gagnant déclaré (string unique, même en cas d'ex-aequo)
- Tours : `'T1'`, `'T2'`, `'TU'` (tour unique pour Européennes / Régionales 1998 / Référendums)
- Ères cartographiques : clés à 4 chiffres dans `BUREAU_INFO` (`'1988'`, `'1993'`, `'1996'`, `'2004'`, `'2007'`, `'2010'`, `'2012'`, `'2015'`, `'2022'`, `'2026'`)
- `CURRENT_ERA` et `ERAS` calculés dynamiquement dans `shared.js` — **jamais hardcoder une année**.

### Modèle de données — PERSONS + CANDIDATURES + CAND_DATA (post-migration M4/M5)
Trois tables liées dans `donnees.js`, plus de lookup à 3 niveaux ni d'overrides `|Election|Tour`.

- **`PERSONS[<person_id>]`** = identité immuable, format `{ p: prénom, n: nom, s: "F"/"H"/"" }`.
  - `person_id` = slug nom-prénom (ex. `"marylise-fleuret-pagnoux"`).
- **`CANDIDATURES[<cand_id>]`** = variante par scrutin (1 personne ou 1 binôme).
  - `cand_id` = `<person_id>@<slug-election>` (ex. `"alain-rousset@regionales-2015"`) pour les individuels.
  - Binôme paritaire : `<pid1>+<pid2>@<slug-election>` (ex. `"dominique-guego+marie-nedellec@departementales-2021"`).
- **`CAND_DATA`** = miroir de CANDIDATURES (mêmes clés), utilisé par les call sites historiques.
  Les sheets ELECTIONS référencent les `cand_id` directement (`bd.c["alain-rousset@regionales-2015"] = pct`).

### `CANDIDATURES[<cid>]` complet
- **Individuelle** : `{ p, n, s, person: <pid>, election: "Régionales 2015", pa: code parti, bk, b, t: [familles], al: alliances, c: couleur hex?, tour_specific? }`
- **Binôme** : `{ election, binome: [pid1, pid2], binome_partis: [pa1, pa2], pa: dérivé, bk, b, t, al?, tour_specific? }`
  Pas de `p`, `n`, `s` propres au binôme — ils sont dans PERSONS via les `pid` du couple.

### Valeurs autorisées
- **`bk`** (clé fine) : `{ exg, g, c, d, exd, divers }` (6 valeurs). `divers` = ancien `?`, renommé pour clarté UX.
- **`b`** (bloc parent) : `{ G, C, D, EXD, ? }`. Dérivé de `bk` via `BLOC_LEGACY` au chargement par le wizard d'import / par l'éditeur.
- **`s`** : `"F"`, `"H"`, ou `""` (non renseigné — toléré pour les profils historiques anciens).

### Binômes paritaires (Cantonales/Départementales 2015+)
- Une seule entrée CANDIDATURES, clé `<pid1>+<pid2>@<elec>`.
- **`binome_partis: [pa1, pa2]`** = source de vérité pour les partis individuels. L'ordre suit l'ordre de `binome`.
- **`pa`** est **dérivé automatiquement** depuis `binome_partis` au chargement (IIFE en fin de `donnees.js` + helper `derivePaForBinome` dans `shared.js`). Plus jamais de stockage divergent.
  - Règle de dérivation :
    - Homogène (pa1 = pa2) → `pa1`
    - DV* + vrai parti → vrai parti seul (le DV* éliminé)
    - 2 vrais partis distincts → `"paF+paH"` (femme devant si sexes connus)
    - 2 divers distincts → idem `"paF+paH"`

### Règle paritaire — la candidate prime sur la carte
Pour les binômes, quand il faut choisir UNE couleur unique sur la carte (pas bicolor) :
- **Couleur** : parti de la candidate F par défaut. Exception : si F est DV* et H un vrai parti, on prend H (lisibilité politique).
- **Label combiné** "PA_F+PA_H" : femme devant.
- Helpers dans LRVcarte : `_femaleIdxOfBinome(ci)`, `_orderedBinomePartis(name)`, `colorOfCandidate(name)`.

### Bicolorisation pour binôme à "2 vrais partis"
- Helper `isDiversParti(pa)` : `/^DV/i.test(pa)`
- Helper `binomePartiColors(name)` : retourne `[c1, c2]` ou `null` (homogène, non-binôme, ou mixte vrai+divers).
  Convention : un binôme `pa1 + pa2` est dit "à 2 vrais partis" ssi **aucun des 2** ne commence par `DV`. L'ordre [c1, c2] suit `_orderedBinomePartis` → **femme devant** (post mai 2026).
- Helper `dotBackground(name)` : retourne `linear-gradient(135deg, c1 50%, c2 50%)` ou couleur unie via `colorOfCandidate`.
- **Sites bicolorisés** : dot/carré légende, tag tooltip carte, tag listes leaders (sidebar bureau/quartier/canton), barres de progression, fond winner duel (grand bloc → diagonale visible), bordure loser duel (2 ::before/::after halves verticales), voile fiche desktop (5 sail-rows haut + 5 bas), voile fiche mobile (gradient bar 6px), topbar fiche (::after horizontal), titrailles canton/bureau sidebar (2 ::before/::after halves), border-image NON utilisé (rend mal sur bordures fines)
- **Carte choroplèthe** : reste en couleur unie (par décision UX, pas de bicolor sur les polygones bureaux). La couleur unique appliquée est celle de `colorOfCandidate(winner)` qui suit la règle paritaire.

### Overrides par tour (`tour_specific`)
Pour les candidatures à 2 tours dont certains champs changent entre T1 et T2 (typiquement `al` — alliance élargie pour le ballottage) :
```js
CANDIDATURES["alain-rousset@regionales-2015"] = {
  ..., al: "PRG, PCF",                       // valeur par défaut (= T1)
  tour_specific: { T2: { al: "PRG, PCF, EELV" } }  // override T2
}
```
Au runtime, `candInfo(name)` dans LRVcarte applique `Object.assign(merged, c.tour_specific[currentSheet])` pour le tour courant. Côté éditeur, la cellule "Alliance" d'une candidature multi-tour propose un toggle `↔ T2` qui split en 2 champs T1/T2 (puis `×` pour révoquer l'override).

### Bureau `0057`
Bureau non-géographique (Français de l'étranger / détenus). Exclu de la plupart des calculs via `NON_GEO = new Set(['0057'])`.

### Cantons (cf. roadmap cantonales/départementales)
- **`BUREAU_INFO[era][bureau].c`** : id canton du bureau pour cette ère (string `"1"` à `"9"` selon ère).
- **`CANTON_INFO[era_canton]`** : 2 ères actuellement présentes :
  - `"1985"` (era_start `"1985"`, era_end `"2014"`) : 9 cantons (couvre 1988-2014).
  - `"2015"` (era_start `"2015"`, era_end `null`) : 3 cantons modernes.
  - Pas de données < 1988 → ères canton `"1973"` et `"1982"` non encore peuplées.
- **`fmtCanton(c)`** dans LRVcarte : retourne `"La Rochelle-" + c` (convention nom = numéro).
- **Helpers shared.js** :
  - `ERAS_CANTON` / `CURRENT_ERA_CANTON` (dynamiques)
  - `getCantonEraForBureauEra(era_bureau)` — règle "la plus récente ère canton ≤ era_bureau"
  - `getCantonEraForElection(label)` — utilise `ELECTIONS[label].my_canton` si présent, sinon inférence
  - `getCantonOfBureau(bureau, era)` / `getBureauxOfCanton(canton_id, era)`
  - `isCantonEraAlive(era_canton, year)` — true si year ∈ [era_start, era_end]. Sert à tronquer les courbes des cantons disparus en mode analyse.
  - `isCantonalElection(label)` — regex sur `Cantonales|Départementales`.
  - `getCantonOfElection(label)` — extrait le cid depuis un label `"Départementales YYYY — La Rochelle-N"` → `"N"`. Retourne `null` si le label n'a pas ce suffixe.
- **`CANTON_CORRESPONDANCES["2015:<cid>"][era]`** : pour chaque canton moderne (1/2/3), la liste des bureaux historiques agrégés rétroactivement à l'ère donnée. Permet d'afficher les courbes "canton moderne" pour les élections antérieures à 2015. Inféré automatiquement (5 cas ambigus résolus au majoritaire), corrigeable via la modal d'édition de LRVanalyse (mode admin → niveau Canton → bouton "Vérifier les correspondances"). Un bureau peut appartenir à plusieurs cantons simultanément (comptage entier dans chacun, comme les quartiers partagés `"A/B"`).
- **Convention analyse** : on met en avant les 3 cantons modernes (ère 2015) qui agrègent rétroactivement toutes les élections, mais on garde l'accès aux 9 cantons historiques (ère 1985) avec leur courbe tronquée à 2014.
- **Convention carte** : fidèle à l'historique. Une cantonale 1988 affiche les cantons de l'ère 1985 ; une départementale 2026 affiche les 3 cantons modernes.

### Élections cantonales / départementales (multi-circonscription)
Les Départementales (et anciennes Cantonales) sont enregistrées comme **une seule entrée** ELECTIONS avec une structure `par_canton` :
```js
ELECTIONS["Départementales 2015"] = {
  my: "2015",
  my_canton: "2015",
  par_canton: {
    "1": { sheets: { T1: { "0001": {...}, ... }, T2: {...} } },
    "2": { sheets: { ... } },
    "3": { sheets: { ... } }
  }
}
```
Un IIFE en queue de `donnees.js` (avant celui de conversion voix→pct) "applatit" `par_canton[cid].sheets` dans `el.sheets` au chargement. Le reste du code lit `el.sheets[tour][bureau]` comme pour une élection normale — chaque bureau ne figure que dans le canton auquel il appartient, donc pas de collision.

- **Détection** via `isCantonalElection(label)` (regex `^(Cantonales|Départementales)\b`).
- **`getCantonOfElection(label)`** : retourne le cid si le label contient `— La Rochelle-N` (format legacy multi-entrées), sinon `null` (format `par_canton` actuel).
- **Fiche globale ville désactivée** : `openGlobalOverlay` / `refreshOverlayIfOpen` redirigent automatiquement vers `selectCantonFromList(cid)` avec cid déterminé par : (1) suffix label si présent, sinon (2) canton du `currentFeature`, sinon (3) fallback canton 1.
- **LRVanalyse — niveau Ville** : `getVilleData` exclut les élections cantonales.
- **LRVanalyse — niveau Canton** : `getCantonData` lit `el.sheets` (fusionnée) en filtrant par les bureaux dont `BUREAU_INFO[era].c === cid`. Pour le format legacy à suffix, on vérifie aussi que `getCantonOfElection(label) === cid`.
- **HAS_T2** : la départementale (label sans suffix) est dans `HAS_T2`.
- **Daily-capture** : `electionScrutin` retourne `'departementales'`, `electionEmoji` retourne 🧩, `DATES` contient une seule entrée.
- **Tweet** : pour une élection cantonale, le niveau "global" doit logiquement basculer en "canton" (à surveiller, non-bloquant tant que les sheets sont vides).

---

## ➕ Procédure complète : Ajouter une élection

> ⚠️ **Section à actualiser** : décrit l'ancien flow pré-migration (clés `CAND_DATA["Nom Parti"]`, overrides `|Election`). Depuis M4/M5, les clés sont des **`cand_id`** au format `<pid>@<slug-election>`. Le wizard **"Nouvelle élection"** dans `editeur_candidats.html` (bouton ➕ dans le header) gère désormais l'injection initiale (paste JSON → validation → export). Les étapes ci-dessous restent indicatives pour l'esprit général (Excel, sanity checks, mises à jour statiques).

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

**⚠️ PIÈGE MAJEUR — modifier ELECTIONS via Node** : ne JAMAIS faire `require('donnees.js')` puis `JSON.stringify(ELECTIONS)` pour réécrire le fichier — le require exécute l'IIFE de conversion qui transforme les voix en pct, et la sérialisation persiste les PCT comme si c'étaient des voix. Au prochain reload, l'IIFE re-divise → toutes les valeurs sont écrasées par des microscores ~0.01%. Toujours éditer le source en **mode textuel** (regex / Edit avec contexte exact / insertion ciblée) sans passer par require().

### Excel : colonnes % désynchronisées
Le fichier xlsx standard a un bug : les colonnes % (cols 8-26 typiquement) ont été triées par valeur sans que les headers le soient → l'association cand↔pct est cassée. **Toujours utiliser les colonnes voix** (cols 30-48) et recalculer les pct.

### Bureaux avec écart voix ≠ exprimés
Pas rare en saisie manuelle. Lister les bureaux concernés et demander à l'user de corriger l'Excel.
**Cas non résoluble** (ex. Régionales 1992 bureau 0007) : si l'user ne peut pas corriger, convention adoptée → on force `bn=0` et `e = somme(voix)`. Cela garde la cohérence interne (somme c = 100 % par bureau) au prix d'une légère imprécision sur les blancs/nuls de ce bureau. Documenter le cas en commentaire pour qu'une meilleure source puisse corriger plus tard.

### Renommage d'ère cartographique
Si une élection plus ancienne arrive et qu'elle utilise EXACTEMENT le même découpage qu'une ère existante (mêmes bureaux, noms, quartiers) → renommer l'ère vers l'année la plus ancienne. Ex. l'ère "1993" est devenue "1992" quand on a ajouté les Régionales 1992 (qui utilisaient déjà le découpage 1993). Endroits à patcher :
- `donnees.js` : `BUREAU_INFO[ancien]` → `[nouveau]`, `BUREAU_CORRESPONDANCES["…"][ancien]` → `[nouveau]`, `REDECOUPAGES["…|ancien"]` → `["…|nouveau"]`, `ELECTIONS[*].my === ancien` → `nouveau`.
- `geodata.js` : `MAPS_DATA[ancien]` → `[nouveau]`.
- `LRVanalyse.html` : notices textuelles "avant <ancien>" → "avant <nouveau>".
- Vérifier qu'aucun autre code ne hardcode l'ancienne année (`ERAS` / `CURRENT_ERA` sont dynamiques donc s'adaptent tout seuls).

### Hachures ex-aequo
- Géré automatiquement par `tieCandidatesForBureau()` (basé sur `_voix` entiers).
- SVG `<pattern>` injecté dans `<svg id="lrv-tie-patterns">` (host global au body, partagé entre toutes les maps Leaflet).
- Côté légende : chaque candidat à égalité compte +1, signalé par `▤` avec tooltip.
- **Export image (canvas)** : Canvas2D ne lit pas `url(#tie-...)`. `drawCarteVisual()` détecte le préfixe `url(#tie-` dans `style.fillColor` et le traduit en `CanvasPattern` via `getCanvasTiePattern()` (tile pré-rendu + `pattern.setTransform(new DOMMatrix().rotate(45))`). Si tu ajoutes une nouvelle visu canvas qui utilise `featureStyle`, applique la même traduction.

### Candidat sans couleur propre
Fallback automatique via `getPartiColor(pa)` : on hérite de la couleur du 1er candidat connu du même parti. Si aucun candidat du parti n'a de couleur → gris `#bbbbbb`. À éviter en demandant à l'user de définir une couleur via l'éditeur.

### Éditeur : bug de propagation couleur parti (corrigé)
Avant : la propagation sautait les candidats sans couleur (`r.c !== oldColor` était toujours vrai). Corrigé en `r.c && r.c !== oldColor` pour ne sauter que les vrais overrides.

### Overrides par tour : utiliser `tour_specific`, pas la clé `|Election|Tour`
**Obsolète depuis M5** : le format `CAND_DATA["X|Election|Tour"]` (lookup 3 niveaux) a été supprimé. Pour varier un champ entre T1 et T2 (typiquement `al`), utiliser `tour_specific` sur l'unique entrée CANDIDATURES de la candidature. Voir la section "Overrides par tour" plus haut.

### Format ancien `<cid>-t1` / `<cid>-t2` : ne plus utiliser
Pendant la migration M3, certaines candidatures avaient été dédoublées (`segolene-royal@presidentielle-2007-t1` + `-t2`) au lieu d'utiliser `tour_specific`. Cleanup effectué en mai 2026 (3 candidatures fusionnées : Ferreira Lég. 2017, Royal Présidentielle 2007, Royal Régionales 2010). Si une nouvelle dette apparaît, vérifier `grep "-t[12]" donnees.js` et fusionner via le pattern documenté dans le commit `2353be9`.

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

# Régénérer toutes les pages scrutin statiques (62 fichiers + sitemap.xml)
node tools/build-scrutins.js

# Régénérer une seule page (debug)
node tools/build-scrutins.js --only presidentielle-2022

# Sanity check des pages scrutin (à lancer après build)
node tools/check-scrutins.js

# Régénérer toutes les images OG (1200×630) — nécessite un serveur HTTP local
python3 -m http.server 8765 &
node tools/generate-scrutin-og-images.js

# Régénérer une seule image OG (debug)
node tools/generate-scrutin-og-images.js --only presidentielle-2022
```

## 📄 Pages scrutin statiques (`/scrutins/`)

Ces pages sont des **vitrines SEO**, complètement isolées du parcours utilisateur normal du site :
- Pas de lien depuis LRVcarte / LRVanalyse / index vers `/scrutins/…`
- Pas de lien depuis `/scrutins/…` vers d'autres pages `/scrutins/…` sauf le triptych de voisins (scrutins du même type, précédent et suivant)
- Cmd+K et la navigation principale continuent de pointer vers `LRVcarte.html#election=…`
- Les pages `/scrutins/` ramènent vers la carte interactive et l'analyse via leur CTA principal

**Quand les régénérer** : après toute modification de `donnees.js` qui change un agrégat ville/quartier/canton (ajout d'élection, correction de saisie, refonte des candidatures). Le script lit aussi `geodata.js` et `shared.js`. Pas besoin de régénérer si on ne touche que les pages éditoriales (méthodo, à propos, etc.).

**Couverture** :
- 1 page par élection classique (Présidentielle, Législatives, Municipales, Européennes, Régionales, Référendum)
- 1 page par canton pour les cantonales / départementales (3 pages pour Départementales 2021, 4 pour Cantonales 2008, etc.)
- T1 + T2 sur la même page avec sections distinctes
- Total actuel : 62 pages

**Avertissements canton hors LR** : les cantons 5, 8, 9 de l'ère 1985 comprenaient des communes hors La Rochelle. Reproduit comme bandeau jaune sur les pages cantons concernées.

**Limites connues** :
- Pas d'image OG dédiée par scrutin (utilise `share.png` générique pour l'instant). À enrichir via `daily-capture.js` (FORCE_NIVEAU=global) si on veut des vignettes spécifiques pour le partage social.
- La table `DATES` est dupliquée entre `daily-capture.js` et `tools/build-scrutins.js` — à factoriser le jour où on touche aux deux.
- Le triptych voisins pour les cantonales : si la série change (A ↔ B) ou si on passe aux départementales (cid 1-3) depuis une cantonale (cid 1-9), le lien voisin est omis pour éviter un mismatch (au lieu de pointer vers un canton incompatible).


---

## 🧠 Préférences de travail (rappel)

- **Toujours demander avant de coder** quand le user pose une question ouverte (cf. retours session sur le "demande mon avis avant de coder").
- **Commenter en français** dans le code.
- **Respecter le style** existant (compact JSON inline dans donnees.js, etc.).
- **Sanity check après chaque modif data** : top ville, somme exprimés, candidats orphelins.
- **Ne pas auto-corriger** les typos visibles dans les exports de l'éditeur sans demander (cf. épisode Gluckstein "Daviel" → "Daniel" : le user a finalement validé "Daniel" mais avait re-tapé "Daviel" entre temps).
