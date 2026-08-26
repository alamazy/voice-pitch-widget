# Voice Pitch Widget

Widget desktop (Tauri) toujours au premier plan, qui détecte en direct
la fréquence fondamentale (F0) de la voix captée par le micro et affiche
la note correspondante.

## Architecture

- **Frontend** : TypeScript + Vite, aucun framework UI (facilement remplaçable
  par React/Svelte/etc. si besoin).
- **Analyse audio** : `AudioWorklet` (`public/pitch-processor.js`) qui tourne
  dans le thread audio temps réel du navigateur/webview. Algorithme
  d'autocorrélation (méthode ACF2+), volontairement sans dépendance externe.
  Aucune modification du son n'est effectuée : uniquement de l'analyse.
- **Fenêtre** : Tauri v2, configurée en `alwaysOnTop`, sans décorations,
  transparente, non redimensionnable (`src-tauri/tauri.conf.json`).
- **Backend Rust** : réduit au strict minimum (aucune commande custom pour
  l'instant). Tout le travail se fait côté frontend.

## Prérequis

1. **Node.js** ≥ 18
2. **Rust** (via [rustup](https://rustup.rs/))
3. Dépendances système Tauri selon l'OS (WebView2 sur Windows, webkit2gtk
   sur Linux, rien de spécial sur macOS) : voir la
   [doc officielle des prérequis](https://tauri.app/start/prerequisites/).

## Installation

```bash
npm install
```

## Lancer en développement

```bash
npm run tauri dev
```

Ça compile le binaire Rust, lance Vite sur `localhost:5173`, et ouvre le
widget. Cliquer sur "Démarrer" déclenchera la demande de permission micro.

## Build de production

```bash
npm run tauri build
```

⚠️ Avant un vrai build, il faut fournir des icônes valides dans
`src-tauri/icons/` (référencées dans `tauri.conf.json`). Le plus simple :

```bash
npx tauri icon chemin/vers/un-logo.png
```

## Points d'attention

- **macOS** : l'accès au micro nécessite une entrée
  `NSMicrophoneUsageDescription` dans l'`Info.plist` généré par Tauri.
  À ajouter via la configuration `bundle.macOS` si ce n'est pas déjà
  géré automatiquement par ta version de Tauri — sinon la demande de
  permission micro échouera silencieusement.
- **Précision de l'algo** : l'autocorrélation simple donne de bons
  résultats sur une voix propre, mais peut se tromper d'octave sur des
  voix très graves ou un signal bruité. Pour aller plus loin : implémenter
  YIN complet (avec la étape de "cumulative mean normalized difference"),
  ou intégrer `pitchy` (implémentation MPM) compilée pour tourner dans
  le worklet.
- **Lissage** : un simple filtre médian sur 5 valeurs est appliqué côté
  main thread pour stabiliser l'affichage. À ajuster selon le ressenti.
- **Déplacer le widget** : la zone `data-tauri-drag-region` permet de
  glisser la fenêtre n'importe où sur l'écran (elle n'a pas de barre de
  titre).

## Pistes d'évolution

- Ajouter un mode "cible" (ex: afficher l'écart par rapport à une note
  de référence, utile pour du chant).
- Exposer un raccourci clavier global (plugin `tauri-plugin-global-shortcut`)
  pour afficher/masquer le widget sans cliquer dessus.
- Sauvegarder l'historique du pitch pendant une session (graphique en live).
