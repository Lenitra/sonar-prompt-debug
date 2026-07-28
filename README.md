# SonarQube → Prompt IA

Extension Firefox et Safari qui condense les issues SonarQube de la page courante en un prompt prêt à coller dans une IA (Claude, ChatGPT, Claude Code…).

## Comment ça marche

L'extension ne scrape pas le DOM de SonarQube (interface React fragile). À la place :

1. Tu ouvres la page **Issues** de ton projet SonarQube (auto-hébergé ou SonarCloud), avec les filtres de ton choix.
2. Le popup injecte un script dans l'onglet actif (`activeTab` + `scripting`) qui appelle l'API officielle `…/api/issues/search` **en same-origin** : ta session SonarQube déjà ouverte est réutilisée, aucun token à configurer.
3. Les filtres de l'URL de la page (sévérité, type, branche, nouveau code…) sont recopiés vers l'API, avec pagination (500 par page).
4. Les issues sont condensées (regroupées par règle ou par fichier, messages dédupliqués) et insérées dans un template de prompt personnalisable.

Aucune donnée ne quitte ton navigateur : les seules requêtes partent vers ton instance SonarQube.

## Créer les zips

```powershell
.\scripts\build.ps1
```

Produit dans `web-ext-artifacts/` :

- `sonarqube_prompt_ia-<version>.zip` — pour Firefox (chargement temporaire ou signature AMO) ;
- `sonarqube_prompt_ia-safari-<version>.zip` — ressources prêtes pour le convertisseur Safari d'Xcode (manifest sans les clés spécifiques à Firefox).

## Installation — Firefox

### Test rapide (chargement temporaire)

1. Ouvre `about:debugging#/runtime/this-firefox` dans Firefox.
2. Clique sur **« Charger un module complémentaire temporaire… »**.
3. Sélectionne le fichier `manifest.json` de ce dossier.

L'extension disparaît au redémarrage de Firefox (c'est le fonctionnement normal du chargement temporaire).

### En développement (rechargement auto)

```bash
npm install --global web-ext
web-ext run
```

### Installation permanente

Firefox exige une signature pour une installation permanente :

- **Signature Mozilla (recommandé)** : créer un compte sur [addons.mozilla.org](https://addons.mozilla.org), puis `web-ext sign --api-key=… --api-secret=… --channel=unlisted`. Le `.xpi` signé s'installe définitivement.
- **Sans signature** : uniquement sur Firefox Developer Edition / Nightly / ESR, en passant `xpinstall.signatures.required` à `false` dans `about:config`.

## Installation — Safari (macOS, Safari 16.4+)

Safari ne charge pas de zip directement : Apple impose d'envelopper toute extension web dans une application native, construite avec **Xcode sur macOS**. Le zip Safari contient les ressources prêtes pour cette conversion.

1. Sur un Mac (Xcode 14+ installé), dézippe `sonarqube_prompt_ia-safari-<version>.zip` puis lance :

   ```bash
   xcrun safari-web-extension-converter chemin/du/dossier-dezippe \
     --app-name "SonarQube Prompt IA" \
     --bundle-identifier com.esos.sonar2prompt \
     --macos-only
   ```

2. Ouvre le projet Xcode généré et lance l'app (`⌘R`). L'app enregistre l'extension auprès de Safari.
3. Dans Safari : **Réglages → Avancés** → coche « Afficher les fonctionnalités pour les développeurs web », puis menu **Développement → « Autoriser les extensions non signées »** (à refaire à chaque redémarrage de Safari).
4. **Réglages → Extensions** → active « SonarQube Prompt IA ».
5. Sur la page SonarQube, clique sur l'icône de l'extension et autorise l'accès au site quand Safari le demande.

Pour distribuer sans Xcode sur chaque poste (App Store ou notarisation Developer ID), un compte Apple Developer est nécessaire.

Compatibilité : l'extension utilise l'API `browser.*` (native dans Safari) et `browser.scripting.executeScript`, disponible depuis Safari 16.4.

## Utilisation

1. Va sur la page **Issues** de ton projet (ex. `https://sonar.exemple.com/project/issues?id=mon-projet&resolved=false`). Applique les filtres voulus dans l'interface SonarQube.
2. Clique sur l'icône de l'extension.
3. Ajuste les options si besoin, puis **« Générer le prompt »**.
4. **« Copier »** et colle le prompt dans ton IA.

Fonctionne aussi depuis la page d'accueil d'un projet (dashboard) : toutes les issues ouvertes du projet sont alors prises.

## Options

| Option | Effet |
|---|---|
| **Regroupement** | *Par règle* : une section par règle, message mutualisé quand il est identique — le plus condensé. *Par fichier* : pratique pour corriger fichier par fichier. |
| **Nombre max d'issues** | Plafond de récupération (défaut 500, max 10 000). Si le total dépasse, une note l'indique dans le prompt. |
| **Reprendre les filtres de la page** | Recopie les paramètres de l'URL (sévérités, types, branche, période « nouveau code »…) vers l'API. Décoché : toutes les issues ouvertes du projet (branche/PR conservées). |
| **Template du prompt** | Personnalisable, persisté. Placeholders : `{{PROJECT}}`, `{{COUNT}}`, `{{TOTAL}}`, `{{ISSUES}}`. |

## Limites connues

- L'API SonarQube plafonne à **10 000 issues** par recherche : affine les filtres au-delà.
- Les **Security Hotspots** ne sont pas inclus (API séparée `api/hotspots/search`).
- Il faut être **connecté** à SonarQube dans l'onglet (ou que le projet soit public).
- Les paramètres d'URL purement « UI » sans équivalent API (ex. `myIssues`) sont ignorés par le serveur : le résultat peut alors être plus large que l'affichage.

## Structure

```
manifest.json        Manifest V3 (Firefox ≥ 140 ; le zip Safari retire les clés Firefox)
popup/popup.html     Interface du popup
popup/popup.css      Styles (thème clair/sombre automatique)
popup/popup.js       Logique : lecture de l'URL, appel API injecté, condensation, template
icons/icon.svg       Source du design de l'icône
icons/icon-*.png     Icônes générées (48/96/128/256)
tools/gen-icons.mjs  Régénère les PNG (node tools/gen-icons.mjs)
scripts/build.ps1    Génère les deux zips dans web-ext-artifacts/
```

## Pistes d'amélioration

- Inclure la description des règles (`api/rules/show`, un appel par règle distincte).
- Inclure un extrait de code par issue (`api/sources/issue_snippets`) — attention au volume de tokens.
- Mode « URL + token » pour générer un prompt sans ouvrir la page SonarQube.
- Support des Security Hotspots.
- Découpage automatique en plusieurs prompts quand l'estimation de tokens dépasse un seuil.
