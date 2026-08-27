# Voice Pitch Widget

Widget desktop (Tauri) toujours au premier plan, qui détecte en temps réel la fréquence fondamentale (F0) de la voix captée par le microphone et affiche la note correspondante avec visualisation spectrogramme.

## Démo navigateur

### --> [Accès à la démonstration live dans votre navigateur](https://alamazy.github.io/voice-pitch-widget/) <--

## Fonctionnalités

### 🎤 Détection de pitch en temps réel
- **Algorithme ACF2+** : Autocorrélation pour estimation précise de la fréquence fondamentale
- **Plage d'analyse** : 50-450 Hz (gamme vocale complète)
- **Affichage** : Fréquence en Hz + nom de la note (Do, Ré, Mi, etc.) avec octave
- **Lissage** : Filtre médian sur 5 valeurs pour stabiliser l'affichage
- **Démarrage automatique** : L'analyse commence dès l'ouverture de l'application

### 📊 Visualisation spectrogramme
- **Graphique temps-fréquence** : Spectrogramme coloré avec courbe de pitch superposée
- **Haute résolution** : FFT rapide 16384 échantillons (~2.93 Hz par bin de fréquence)
- **Palette de couleurs** : Dégradé bleu → cyan → vert → jaune → rouge selon l'intensité
- **Historique** : 30 secondes de données en continu
- **Clic interactif** : Cliquer sur la fréquence affiche le graphique, cliquer sur le graphique revient à la vue principale

### 🎚️ Réglages personnalisables
- **Sensibilité (RMS)** : Niveau sonore minimum pour détecter un signal (0.0001-0.1)
- **Cut (Peak %)** : Ratio de trimming des bords silencieux (5-50%)
- **Gamme cible Min/Max** : Définir une plage de fréquences d'entraînement
  - Indicateurs visuels : ↓ rouge si en dessous, ↑ rouge si au-dessus
  - Blocage intelligent : Les sliders ne peuvent pas se croiser
- **Presets rapides** :
  - ♂ **Homme** : 75-150 Hz (voix masculine typique)
  - ♀ **Femme** : 175-275 Hz (voix féminine typique)
- **Sauvegarde automatique** : Tous les réglages sont persistants (localStorage)

### 🪟 Interface adaptative
- **3 vues distinctes** :
  - **Principale** (240×160) : Affichage de la fréquence et note
  - **Réglages** (270×180) : Paramètres ajustables en temps réel
  - **Graphique** (240×320) : Spectrogramme avec historique 30s
- **Fenêtre flottante** : Toujours au premier plan, transparente, déplaçable
- **Sans décoration** : Interface épurée sans barre de titre système
- **Redimensionnement dynamique** : La fenêtre s'adapte automatiquement à la vue

## Architecture

- **Frontend** : TypeScript + Vite, vanilla JS (pas de framework UI)
- **Analyse audio** : 
  - `AudioWorklet` (`public/pitch-processor.js`) dans un thread audio dédié
  - Autocorrélation (ACF2+) pour détection de pitch
  - FFT rapide pour calcul du spectre dans la gamme vocale
  - Fenêtrage Hann pour réduire les artefacts spectraux
- **Visualisation** : Canvas 2D avec animation requestAnimationFrame
- **Fenêtre** : Tauri v2, configuration `alwaysOnTop`, `transparent`, `resizable`
- **Backend Rust** : Minimal, permissions pour redimensionnement dynamique

## Prérequis

1. **Node.js** ≥ 18
2. **Rust** (via [rustup](https://rustup.rs/))
3. Dépendances système Tauri selon l'OS (WebView2 sur Windows, webkit2gtk sur Linux, rien de spécial sur macOS) : voir la [doc officielle des prérequis](https://tauri.app/start/prerequisites/).

## Installation

```bash
npm install
```

## Lancer en développement

```bash
npm run tauri dev
```

Compile le binaire Rust, lance Vite sur `localhost:5173`, et ouvre le widget. L'analyse audio démarre automatiquement après autorisation du micro.

## Build de production

```bash
npm run tauri build
```

## Version navigateur (GitHub Pages)

En plus du build Tauri, le même code fonctionne comme simple page web (sans installation), utile pour tester ou partager rapidement le widget.

- **Détection automatique** : `main.ts` détecte si l'app tourne dans un webview Tauri (présence de `window.__TAURI_INTERNALS__`). En dehors de Tauri, les appels spécifiques (redimensionnement de fenêtre, fermeture) sont désactivés/adaptés, et la page bascule dans un mode `body.web-mode` (widget centré à taille fixe au lieu de remplir toute la fenêtre).
- **Build web** : `npm run build` génère un `dist/` 100% statique et portable (base d'assets relative), utilisable tel quel dans n'importe quel navigateur ou hébergement statique.
- **Déploiement automatique** : le workflow [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml) build le projet et le publie sur GitHub Pages à chaque push sur `main`.

## Utilisation

1. **Au démarrage** : Autoriser l'accès au microphone
2. **Vue principale** : Observer la fréquence et la note détectées
3. **Réglages** : Cliquer sur ⚙ pour ajuster sensibilité et gamme cible
4. **Graphique** : Cliquer sur la fréquence pour voir le spectrogramme
5. **Presets** : Utiliser ♂/♀ pour configurer rapidement une gamme typique
6. **Effacer** : Bouton pour vider l'historique du graphique
7. **Déplacer** : Glisser la fenêtre en cliquant sur le fond

## Points techniques

#### Windows WebView2
L'application nécessite WebView2 Runtime. La configuration `fixedRuntime` nécessite le téléchargement préalable de WebView2 fixed version sur le site de Microsoft https://developer.microsoft.com/en-us/microsoft-edge/webview2/#download-section puis la décompresser avec la commande suivante: `Expand .\Microsoft.WebView2.FixedVersionRuntime.128.0.2739.42.x64.cab -F:* ./src-tauri`

#### macOS
L'accès au micro nécessite `NSMicrophoneUsageDescription` dans `Info.plist` (géré automatiquement par Tauri 2.x)

#### Précision
L'autocorrélation donne de bons résultats sur voix propre, peut se tromper d'octave sur signaux bruités

## Pistes d'évolution

- [ ] Ajouter algorithme YIN ou MPM pour précision accrue
- [ ] Raccourci clavier global pour afficher/masquer (plugin `tauri-plugin-global-shortcut`)
