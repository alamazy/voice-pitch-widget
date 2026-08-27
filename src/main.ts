import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";

// Présent uniquement quand l'app tourne dans un webview Tauri (injecté par
// le runtime natif) : absent dans un simple onglet de navigateur, ce qui
// permet de désactiver proprement les fonctionnalités liées à la fenêtre
// (redimensionnement, fermeture...) sur la version GitHub Pages.
const isTauri = "__TAURI_INTERNALS__" in window;
if (!isTauri) {
  document.body.classList.add("web-mode");
}

const noteEl = document.getElementById("note") as HTMLSpanElement;
const freqEl = document.getElementById("freq") as HTMLSpanElement;
const statusEl = document.getElementById("status") as HTMLDivElement;
const toggleBtn = document.getElementById("toggle-btn") as HTMLButtonElement;
const closeBtn = document.getElementById("close-btn") as HTMLButtonElement;
const compactBtn = document.getElementById("compact-btn") as HTMLButtonElement;
const settingsBtn = document.getElementById("settings-btn") as HTMLButtonElement;
const mainView = document.getElementById("main-view") as HTMLElement;
const settingsView = document.getElementById("settings-view") as HTMLElement;
const graphView = document.getElementById("graph-view") as HTMLElement;
const clearHistoryBtn = document.getElementById("clear-history-btn") as HTMLButtonElement;
const pitchCanvas = document.getElementById("pitch-canvas") as HTMLCanvasElement;
const rmsSlider = document.getElementById("rms-slider") as HTMLInputElement;
const rmsValueEl = document.getElementById("rms-value") as HTMLSpanElement;
const peakSlider = document.getElementById("peak-slider") as HTMLInputElement;
const peakValueEl = document.getElementById("peak-value") as HTMLSpanElement;
const minFreqSlider = document.getElementById("min-freq-slider") as HTMLInputElement;
const minFreqValueEl = document.getElementById("min-freq-value") as HTMLSpanElement;
const maxFreqSlider = document.getElementById("max-freq-slider") as HTMLInputElement;
const maxFreqValueEl = document.getElementById("max-freq-value") as HTMLSpanElement;
const presetMaleBtn = document.getElementById("preset-male-btn") as HTMLButtonElement;
const presetFemaleBtn = document.getElementById("preset-female-btn") as HTMLButtonElement;
const sourceSelect = document.getElementById("source-select") as HTMLSelectElement;

const SETTINGS_STORAGE_KEY = "voice-pitch-widget:thresholds";

// Configuration réelle du pitch-processor, récupérée dynamiquement via le
// message "get-config" (voir startListening) plutôt que dupliquée en dur
// ici. Reste `null` tant qu'elle n'a pas encore été reçue (ex: avant le
// tout premier démarrage de l'écoute).
interface ProcessorConfig {
  sampleRate: number;
  bufferSize: number;
  pitchWindowSize: number;
  freqPerBin: number;
  spectrumMinFreq: number;
  spectrumMaxFreq: number;
  spectrumMinBin: number;
  spectrumMaxBin: number;
  numSpectrumBins: number;
  spectrumStartFreq: number;
  spectrumEndFreq: number;
}
let processorConfig: ProcessorConfig | null = null;

// Historique des fréquences pour le graphique spectral
interface PitchDataPoint {
  timestamp: number;
  frequency: number;
  spectrum?: number[]; // Données spectrales pour le spectrogramme
}
const pitchHistory: PitchDataPoint[] = [];
const MAX_HISTORY_DURATION = 30000; // 30 secondes d'historique

// data-tauri-drag-region sur <main> intercepte le mousedown de TOUS ses
// enfants pour initier le déplacement de la fenêtre — y compris sur des
// boutons/sliders, ce qui avale le clic avant qu'il n'atteigne son propre
// handler. On stoppe explicitement la propagation sur chaque élément
// interactif pour que le drag ne se déclenche que sur le fond du widget.
function preventDragOnInteractiveElements() {
  const interactiveSelectors = [
    "#close-btn",
    "#compact-btn",
    "#settings-btn",
    "#toggle-btn",
    "#rms-slider",
    "#peak-slider",
    "#min-freq-slider",
    "#max-freq-slider",
    "#preset-male-btn",
    "#preset-female-btn",
    "#clear-history-btn",
    "#pitch-canvas",
    "#freq",
    "#source-select",
  ];
  for (const selector of interactiveSelectors) {
    const el = document.querySelector(selector);
    el?.addEventListener("mousedown", (event) => {
      event.stopPropagation();
    });
  }
}
preventDragOnInteractiveElements();

interface Thresholds {
  rmsThreshold: number;
  peakThreshold: number;
  minFreq: number;
  maxFreq: number;
}

const DEFAULT_THRESHOLDS: Thresholds = {
  rmsThreshold: 0.05,
  peakThreshold: 0.2,
  minFreq: 50,
  maxFreq: 450,
};

/** Charge les seuils sauvegardés localement, ou renvoie les valeurs par défaut. */
function loadThresholds(): Thresholds {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_THRESHOLDS };
    const parsed = JSON.parse(raw);
    return {
      rmsThreshold: typeof parsed.rmsThreshold === "number" ? parsed.rmsThreshold : DEFAULT_THRESHOLDS.rmsThreshold,
      peakThreshold: typeof parsed.peakThreshold === "number" ? parsed.peakThreshold : DEFAULT_THRESHOLDS.peakThreshold,
      minFreq: typeof parsed.minFreq === "number" ? parsed.minFreq : DEFAULT_THRESHOLDS.minFreq,
      maxFreq: typeof parsed.maxFreq === "number" ? parsed.maxFreq : DEFAULT_THRESHOLDS.maxFreq,
    };
  } catch {
    return { ...DEFAULT_THRESHOLDS };
  }
}

function saveThresholds(thresholds: Thresholds) {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(thresholds));
}

let currentThresholds = loadThresholds();
rmsSlider.value = String(currentThresholds.rmsThreshold);
peakSlider.value = String(currentThresholds.peakThreshold);
minFreqSlider.value = String(currentThresholds.minFreq);
maxFreqSlider.value = String(currentThresholds.maxFreq);
rmsValueEl.textContent = currentThresholds.rmsThreshold.toFixed(4);
peakValueEl.textContent = `${Math.round(currentThresholds.peakThreshold * 100)}%`;
minFreqValueEl.textContent = String(currentThresholds.minFreq);
maxFreqValueEl.textContent = String(currentThresholds.maxFreq);

const NOTE_NAMES = [
  "Do",
  "Do#",
  "Ré",
  "Ré#",
  "Mi",
  "Fa",
  "Fa#",
  "Sol",
  "Sol#",
  "La",
  "La#",
  "Si",
];

/** Convertit une fréquence (Hz) en nom de note + octave, ex: "La3". */
function frequencyToNote(frequency: number): string {
  // A4 = 440 Hz = référence MIDI 69.
  const midi = 69 + 12 * Math.log2(frequency / 440);
  const rounded = Math.round(midi);
  const noteIndex = ((rounded % 12) + 12) % 12;
  const octave = Math.floor(rounded / 12) - 1;
  return `${NOTE_NAMES[noteIndex]}${octave}`;
}

/** Petit lissage pour éviter que l'affichage saute dans tous les sens. */
class MedianSmoother {
  private history: number[] = [];
  constructor(private size = 5) {}

  push(value: number): number {
    this.history.push(value);
    if (this.history.length > this.size) this.history.shift();
    const sorted = [...this.history].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  reset() {
    this.history = [];
  }
}

let audioContext: AudioContext | null = null;
let mediaStream: MediaStream | null = null;
let workletNode: AudioWorkletNode | null = null;
let isRunning = false;
const smoother = new MedianSmoother(5);

const SOURCE_STORAGE_KEY = "voice-pitch-widget:source-device-id";

/** Charge le deviceId sauvegardé, ou "" (périphérique par défaut) si aucun. */
function loadSelectedDeviceId(): string {
  try {
    return localStorage.getItem(SOURCE_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveSelectedDeviceId(deviceId: string) {
  localStorage.setItem(SOURCE_STORAGE_KEY, deviceId);
}

let selectedDeviceId = loadSelectedDeviceId();

/**
 * Remplit le <select> avec les micros disponibles. Les labels ne sont
 * lisibles ("Microphone USB", etc.) qu'une fois la permission micro déjà
 * accordée au moins une fois — avant ça, le navigateur renvoie des labels
 * vides par mesure de vie privée. On appelle donc cette fonction à la fois
 * au chargement (labels probablement vides tant que rien n'a démarré) et
 * juste après le premier getUserMedia réussi (labels alors disponibles).
 */
async function refreshAudioSources() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === "audioinput");

    const previousValue = sourceSelect.value;
    sourceSelect.innerHTML = "";

    const defaultOption = document.createElement("option");
    defaultOption.value = "";
    defaultOption.textContent = "Microphone par défaut";
    sourceSelect.appendChild(defaultOption);

    inputs.forEach((device, index) => {
      const option = document.createElement("option");
      option.value = device.deviceId;
      option.textContent = device.label || `Microphone ${index + 1}`;
      sourceSelect.appendChild(option);
    });

    // Restaure la sélection précédente si le périphérique existe toujours,
    // sinon retombe sur le choix sauvegardé, sinon sur la valeur par défaut.
    const candidateValue = previousValue || selectedDeviceId;
    const stillExists = inputs.some((d) => d.deviceId === candidateValue);
    sourceSelect.value = stillExists ? candidateValue : "";
  } catch (err) {
    console.error("Impossible d'énumérer les périphériques audio :", err);
  }
}

// Rafraîchit automatiquement la liste si un micro est branché/débranché
// pendant que l'app tourne (ex: casque USB connecté en cours d'usage).
navigator.mediaDevices.addEventListener("devicechange", () => {
  void refreshAudioSources();
});

void refreshAudioSources();

async function startListening() {
  try {
    console.log("Starting audio analysis...");
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        // Activé : l'AGC ajuste le volume d'entrée mais ne modifie pas la
        // fréquence du signal, donc n'introduit aucun biais sur la mesure
        // de pitch. Ça aide beaucoup à détecter une voix à volume normal
        // sans avoir à chanter/parler fort.
        autoGainControl: true,
        // Si l'utilisateur a choisi un micro spécifique dans les réglages,
        // on le demande explicitement. Chaîne vide = laisser le navigateur/
        // OS choisir le périphérique par défaut.
        ...(selectedDeviceId
          ? { deviceId: { exact: selectedDeviceId } }
          : {}),
      },
    });
    console.log("Microphone access granted");

    // Les labels des périphériques ne sont lisibles qu'une fois la
    // permission accordée : on rafraîchit la liste maintenant pour que le
    // <select> affiche de vrais noms au lieu de "Microphone 1", "Microphone 2"...
    void refreshAudioSources();

    audioContext = new AudioContext();
    console.log("AudioContext created, sample rate:", audioContext.sampleRate);
    
    console.log("Loading AudioWorklet module...");
    // BASE_URL respecte le sous-chemin de déploiement (ex: GitHub Pages
    // sert le site sous /nom-repo/) au lieu d'un chemin absolu figé.
    await audioContext.audioWorklet.addModule(`${import.meta.env.BASE_URL}pitch-processor.js`);
    console.log("AudioWorklet module loaded");

    const source = audioContext.createMediaStreamSource(mediaStream);
    workletNode = new AudioWorkletNode(audioContext, "pitch-processor");
    console.log("AudioWorkletNode created");

    workletNode.port.onmessage = (event: MessageEvent<{ type?: string; frequency?: number; spectrum?: number[]; [key: string]: unknown }>) => {
      const data = event.data;

      // Réponse à notre demande "get-config" : on la stocke et on
      // s'arrête là, ce n'est pas une mesure de fréquence.
      if (data.type === "config") {
        processorConfig = data as unknown as ProcessorConfig;
        console.log("Configuration reçue du processor :", processorConfig);
        return;
      }

      const { frequency, spectrum } = data;
      if (typeof frequency !== "number") return;
      const now = Date.now();
      
      if (frequency > 0) {
        const smoothed = smoother.push(frequency);
        
        // Vérifier si la fréquence est dans la gamme cible définie
        let freqText = `${smoothed.toFixed(1)} Hz`;
        if (smoothed < currentThresholds.minFreq) {
          freqText = `↓ ${freqText}`;
          freqEl.classList.add("out-of-range");
        } else if (smoothed > currentThresholds.maxFreq) {
          freqText = `↑ ${freqText}`;
          freqEl.classList.add("out-of-range");
        } else {
          freqEl.classList.remove("out-of-range");
        }
        
        freqEl.textContent = freqText;
        noteEl.textContent = frequencyToNote(smoothed);
        // Signal actif : on retire l'indice visuel "figé" s'il était présent.
        noteEl.classList.remove("held");
        freqEl.classList.remove("held");
        
        // Ajouter à l'historique avec la fréquence lissée
        if (spectrum) {
          pitchHistory.push({ timestamp: now, frequency: smoothed, spectrum });
        }
      } else {
        // Pas de voix détectée : enregistrer quand même le spectre avec frequency = -1
        if (spectrum) {
          pitchHistory.push({ timestamp: now, frequency: -1, spectrum });
        }
        
        // On NE touche PAS au texte affiché, la dernière note/fréquence reste visible.
        // On réinitialise juste le lissage pour ne pas biaiser la prochaine détection
        // avec des valeurs devenues obsolètes, et on ajoute un indice visuel discret
        // (opacité réduite) pour signaler que la valeur est "en pause".
        smoother.reset();
        noteEl.classList.add("held");
        freqEl.classList.add("held");
      }
      
      // Nettoyer l'historique ancien
      while (pitchHistory.length > 0 && pitchHistory[0].timestamp < now - MAX_HISTORY_DURATION) {
        pitchHistory.shift();
      }
    };

    source.connect(workletNode);
    // Pas besoin de connecter workletNode à audioContext.destination :
    // on ne fait qu'analyser, pas de sortie audio (évite le larsen).

    // Synchronise le worklet avec les seuils actuellement réglés dans l'UI
    // (au cas où ils diffèrent des valeurs par défaut codées dans le processor).
    workletNode.port.postMessage({
      type: "update-thresholds",
      rmsThreshold: currentThresholds.rmsThreshold,
      peakThreshold: currentThresholds.peakThreshold,
    });

    // Récupère la configuration réelle du processor (tailles de buffer,
    // plage spectrale, sampleRate...) au lieu de la deviner/dupliquer en
    // dur côté UI. La réponse arrive de façon asynchrone via le handler
    // onmessage ci-dessus (voir le cas data.type === "config").
    workletNode.port.postMessage({ type: "get-config" });

    // Le nouveau worklet démarre avec le spectrogramme désactivé par
    // défaut (voir pitch-processor.js) : si l'utilisateur redémarre
    // l'écoute (stop/start) alors qu'il est déjà sur la vue graphique,
    // il faut resynchroniser explicitement, sinon le calcul resterait
    // désactivé sans que l'UI ne s'en aperçoive.
    workletNode.port.postMessage({
      type: "set-spectrogram-enabled",
      enabled: currentView === View.Graph,
    });

    setMicActive(true);
    toggleBtn.textContent = "Arrêter";
    statusEl.textContent = "";
    console.log("Listening started successfully!");
  } catch (err) {
    // Si le micro précédemment choisi a été débranché/n'existe plus, on
    // retombe sur le périphérique par défaut plutôt que de bloquer
    // complètement l'application.
    if (
      err instanceof OverconstrainedError ||
      (err instanceof Error && err.name === "OverconstrainedError")
    ) {
      console.warn(
        "Périphérique audio sélectionné introuvable, retour au micro par défaut."
      );
      selectedDeviceId = "";
      saveSelectedDeviceId("");
      sourceSelect.value = "";
      statusEl.textContent = "Micro précédent introuvable, réessaie";
      return;
    }
    console.error("Impossible d'accéder au micro :", err);
    statusEl.textContent = "Erreur d'accès au micro";
  }
}

function stopListening() {
  workletNode?.disconnect();
  workletNode = null;

  mediaStream?.getTracks().forEach((track) => track.stop());
  mediaStream = null;

  audioContext?.close();
  audioContext = null;

  smoother.reset();
  setMicActive(false);
  toggleBtn.textContent = "Démarrer";
  statusEl.textContent = "Micro inactif";
  freqEl.textContent = "-- Hz";
  noteEl.textContent = "--";
}

function drawPitchGraph() {
  const ctx = pitchCanvas.getContext("2d");
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = pitchCanvas.getBoundingClientRect();
  pitchCanvas.width = rect.width * dpr;
  pitchCanvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const width = rect.width;
  const height = rect.height;

  // Fond
  ctx.fillStyle = "rgba(20, 20, 24, 0.95)";
  ctx.fillRect(0, 0, width, height);

  if (pitchHistory.length < 2) {
    ctx.fillStyle = "#888";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Pas encore de données...", width / 2, height / 2);
    return;
  }

  // Limites de fréquence pour l'affichage du spectrogramme : dérivées de
  // la config réelle du processor (spectrumStartFreq/spectrumEndFreq,
  // alignées exactement sur les bins renvoyés), avec un repli sur les
  // valeurs nominales 50-450 Hz UNIQUEMENT si la config n'a pas encore
  // été reçue (ex: graphique ouvert avant le tout premier démarrage).
  const minFreq = processorConfig?.spectrumStartFreq ?? 50;
  const maxFreq = processorConfig?.spectrumEndFreq ?? 450;

  const now = Date.now();
  const timeRange = MAX_HISTORY_DURATION; // Fenêtre fixe de 30 secondes

  // Résolution fréquentielle du spectrogramme et fréquence du premier bin
  // renvoyé par le processor : lues depuis processorConfig plutôt que
  // recalculées à partir de constantes dupliquées ici (fftSize,
  // sampleRate...). Repli sur les mêmes valeurs par défaut que le
  // processor si la config n'est pas encore disponible.
  const freqPerBin = processorConfig?.freqPerBin ?? 48000 / 16384;
  const spectrumMinFreq = processorConfig?.spectrumStartFreq ?? 50;

  for (const point of pitchHistory) {
    if (!point.spectrum || point.spectrum.length === 0) continue;
    
    const x = ((point.timestamp - (now - timeRange)) / timeRange) * width;
    
    // Chaque bin du spectre correspond à une fréquence précise
    for (let i = 0; i < point.spectrum.length; i++) {
      const freq = spectrumMinFreq + i * freqPerBin;
      
      // Ne dessiner que dans la plage visible (normalement tout devrait l'être)
      if (freq < minFreq || freq > maxFreq) continue;
      
      const intensity = point.spectrum[i];
      
      // Sauter les intensités très faibles pour ne pas surcharger
      if (intensity < 0.01) continue;
      
      // Calculer la position Y et la hauteur pour ce bin
      const freqStart = freq;
      const freqEnd = freq + freqPerBin;
      const yStart = height - ((freqEnd - minFreq) / (maxFreq - minFreq)) * height;
      const yEnd = height - ((freqStart - minFreq) / (maxFreq - minFreq)) * height;
      const binHeight = Math.max(0.5, yEnd - yStart);
      
      // Palette de couleurs : bleu -> cyan -> vert -> jaune -> rouge
      let r, g, b;
      if (intensity < 0.25) {
        // Bleu à cyan
        const t = intensity / 0.25;
        r = 0;
        g = Math.floor(t * 128);
        b = Math.floor(128 + t * 127);
      } else if (intensity < 0.5) {
        // Cyan à vert
        const t = (intensity - 0.25) / 0.25;
        r = 0;
        g = Math.floor(128 + t * 127);
        b = Math.floor(255 - t * 255);
      } else if (intensity < 0.75) {
        // Vert à jaune
        const t = (intensity - 0.5) / 0.25;
        r = Math.floor(t * 255);
        g = 255;
        b = 0;
      } else {
        // Jaune à rouge
        const t = (intensity - 0.75) / 0.25;
        r = 255;
        g = Math.floor(255 - t * 255);
        b = 0;
      }
      
      // Opacité basée sur l'intensité pour un meilleur rendu
      const alpha = Math.min(0.9, 0.2 + intensity * 0.7);
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
      
      // Dessiner une bande verticale pour ce bin (très fine avec haute résolution)
      ctx.fillRect(x - 0.75, yStart, 1.5, binHeight);
    }
  }

  // Axes et grille
  ctx.strokeStyle = "rgba(255, 255, 255, 0.1)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= 5; i++) {
    const y = (i / 5) * height;
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();

  // Étiquettes de fréquence
  ctx.fillStyle = "#666";
  ctx.font = "9px sans-serif";
  ctx.textAlign = "right";
  for (let i = 0; i <= 5; i++) {
    const freq = maxFreq - (i / 5) * (maxFreq - minFreq);
    const y = (i / 5) * height;
    ctx.fillText(`${Math.round(freq)} Hz`, width - 4, y + 3);
  }

  // Dessiner la courbe de pitch (uniquement pour les fréquences détectées)
  const maxGap = 500; // Briser la ligne si gap > 500ms entre deux points
  const validPoints = pitchHistory.filter(p => p.frequency > 0);

  if (validPoints.length > 0) {
    // Contour blanc pour meilleure visibilité sur le spectrogramme
    ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
    ctx.lineWidth = 4;

    let firstPoint = true;
    for (let i = 0; i < validPoints.length; i++) {
      const point = validPoints[i];
      const x = ((point.timestamp - (now - timeRange)) / timeRange) * width;
      const y = height - ((point.frequency - minFreq) / (maxFreq - minFreq)) * height;

      if (firstPoint) {
        ctx.beginPath();
        ctx.moveTo(x, y);
        firstPoint = false;
      } else {
        const prevPoint = validPoints[i - 1];
        const timeDiff = point.timestamp - prevPoint.timestamp;
        
        if (timeDiff > maxGap) {
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }
    }
    ctx.stroke();

    // Courbe principale en bleu
    ctx.strokeStyle = "#4c8dff";
    ctx.lineWidth = 2;

    firstPoint = true;
    for (let i = 0; i < validPoints.length; i++) {
      const point = validPoints[i];
      const x = ((point.timestamp - (now - timeRange)) / timeRange) * width;
      const y = height - ((point.frequency - minFreq) / (maxFreq - minFreq)) * height;

      if (firstPoint) {
        ctx.beginPath();
        ctx.moveTo(x, y);
        firstPoint = false;
      } else {
        const prevPoint = validPoints[i - 1];
        const timeDiff = point.timestamp - prevPoint.timestamp;
        
        if (timeDiff > maxGap) {
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }
    }
    ctx.stroke();

    // Points
    ctx.fillStyle = "#4c8dff";
    for (const point of validPoints) {
      const x = ((point.timestamp - (now - timeRange)) / timeRange) * width;
      const y = height - ((point.frequency - minFreq) / (maxFreq - minFreq)) * height;
      ctx.beginPath();
      ctx.arc(x, y, 2, 0, 2 * Math.PI);
      ctx.fill();
    }
  }
}

let graphAnimationId: number | null = null;

const widgetEl = document.querySelector(".widget") as HTMLElement;

/**
 * Met à jour isRunning et reflète l'état sur le widget via la classe
 * "mic-inactive". Utilisée par le mode compact (voir style.css) pour
 * substituer la fréquence par le bouton de démarrage quand le micro est
 * coupé, dans le même emplacement du rang flex.
 */
function setMicActive(active: boolean) {
  isRunning = active;
  widgetEl.classList.toggle("mic-inactive", !active);
}

// État initial : micro inactif au chargement.
widgetEl.classList.add("mic-inactive");

/**
 * Redimensionne la fenêtre native Tauri, ou (en mode navigateur, où il n'y
 * a pas de fenêtre à redimensionner) applique directement la taille au
 * conteneur du widget dans la page.
 */
async function applyWidgetSize(width: number, height: number) {
  if (isTauri) {
    await getCurrentWindow().setSize(new LogicalSize(width, height));
  } else {
    widgetEl.style.width = `${width}px`;
    widgetEl.style.height = `${height}px`;
  }
}

// Enum pour les différentes vues. Compact est une vue à part entière (et
// non un flag orthogonal) : ça évite d'avoir deux états à garder
// synchronisés, et centralise toute la logique de taille/visibilité au
// même endroit dans showView().
enum View {
  Main = "main",
  Settings = "settings",
  Graph = "graph",
  Compact = "compact",
}

let currentView: View = View.Main;

// Taille de fenêtre associée à chaque vue — une seule table à modifier
// pour ajuster n'importe quelle taille, plutôt que des valeurs éparpillées
// dans chaque branche du switch ci-dessous.
const VIEW_SIZES: Record<View, { width: number; height: number }> = {
  [View.Main]: { width: 240, height: 140 },
  [View.Settings]: { width: 270, height: 180 },
  [View.Graph]: { width: 240, height: 320 },
  [View.Compact]: { width: 175, height: 46 },
};

async function showView(view: View) {
  // Arrêter l'animation du graphique si elle tourne
  if (graphAnimationId !== null) {
    cancelAnimationFrame(graphAnimationId);
    graphAnimationId = null;
  }

  // Le calcul du spectrogramme (FFT) dans le worklet est coûteux : on ne
  // l'active que lorsque la vue graphique est effectivement affichée, et
  // on le désactive dès qu'on la quitte, quelle que soit la vue de
  // destination.
  workletNode?.port.postMessage({
    type: "set-spectrogram-enabled",
    enabled: view === View.Graph,
  });

  // Masquer toutes les vues. Main et Compact partagent le même balisage
  // (#main-view) : seule la classe "compact" sur le widget change la
  // densité d'affichage via CSS (voir style.css, .widget.compact ...).
  mainView.classList.add("hidden");
  settingsView.classList.add("hidden");
  graphView.classList.add("hidden");
  widgetEl.classList.toggle("compact", view === View.Compact);

  // État du bouton compact mis à jour de façon universelle (pas dans le
  // switch ci-dessous) : sinon, en quittant Compact directement vers
  // Graph ou Settings (ex: clic sur la fréquence en mode compact), le
  // bouton restait affiché comme "actif" (⇲) alors qu'on n'est plus en
  // mode compact.
  compactBtn.classList.toggle("active", view === View.Compact);
  compactBtn.textContent = view === View.Compact ? "⇲" : "⇱";
  compactBtn.title =
    view === View.Compact ? "Quitter le mode compact" : "Mode compact";

  try {
    const { width, height } = VIEW_SIZES[view];
    await applyWidgetSize(width, height);

    switch (view) {
      case View.Main:
      case View.Compact:
        mainView.classList.remove("hidden");
        settingsBtn.classList.remove("active");
        break;

      case View.Settings:
        settingsView.classList.remove("hidden");
        settingsBtn.classList.add("active");
        break;

      case View.Graph:
        graphView.classList.remove("hidden");
        settingsBtn.classList.remove("active");
        // Attendre un peu pour que le DOM se mette à jour
        await new Promise(resolve => setTimeout(resolve, 100));
        // Démarrer l'animation du graphique
        const animate = () => {
          drawPitchGraph();
          graphAnimationId = requestAnimationFrame(animate);
        };
        animate();
        break;
    }
    
    currentView = view;
  } catch (err) {
    console.error("Erreur de changement de vue :", err);
  }
}

async function showGraphView() {
  await showView(View.Graph);
}

// Fermer le graphique ramène toujours à la vue principale normale (jamais
// au mode compact), quelle que soit la vue d'où on venait avant d'ouvrir
// le graphique — comportement volontairement simple, sans mémorisation
// d'une "vue précédente".
async function hideGraphView() {
  await showView(View.Main);
}

toggleBtn.addEventListener("click", () => {
  if (isRunning) {
    stopListening();
  } else {
    void startListening();
  }
});

closeBtn.addEventListener("click", () => {
  stopListening();
  // Pas de fenêtre native à fermer côté navigateur : on se contente de
  // couper le micro (voir stopListening ci-dessus).
  if (isTauri) {
    void getCurrentWindow().close();
  }
});

compactBtn.addEventListener("click", () => {
  void showView(currentView === View.Compact ? View.Main : View.Compact);
});

settingsBtn.addEventListener("click", () => {
  if (currentView === View.Settings) {
    // Si on est déjà dans les réglages, retourner à la vue principale
    void showView(View.Main);
  } else {
    // Sinon, afficher les réglages
    void showView(View.Settings);
  }
});

rmsSlider.addEventListener("input", () => {
  const value = parseFloat(rmsSlider.value);
  currentThresholds = { ...currentThresholds, rmsThreshold: value };
  rmsValueEl.textContent = value.toFixed(4);
  saveThresholds(currentThresholds);
  // Envoi en live : si le worklet tourne déjà, le changement s'applique
  // immédiatement, sans redémarrer l'écoute.
  workletNode?.port.postMessage({
    type: "update-thresholds",
    rmsThreshold: value,
  });
});

peakSlider.addEventListener("input", () => {
  const value = parseFloat(peakSlider.value);
  currentThresholds = { ...currentThresholds, peakThreshold: value };
  peakValueEl.textContent = `${Math.round(value * 100)}%`;
  saveThresholds(currentThresholds);
  workletNode?.port.postMessage({
    type: "update-thresholds",
    peakThreshold: value,
  });
});

minFreqSlider.addEventListener("input", () => {
  let value = parseFloat(minFreqSlider.value);
  // Empêcher min de dépasser max
  if (value > currentThresholds.maxFreq) {
    value = currentThresholds.maxFreq;
    minFreqSlider.value = String(value);
  }
  currentThresholds = { ...currentThresholds, minFreq: value };
  minFreqValueEl.textContent = String(value);
  saveThresholds(currentThresholds);
  // Utilisé uniquement pour l'affichage rouge, pas envoyé au worklet
});

maxFreqSlider.addEventListener("input", () => {
  let value = parseFloat(maxFreqSlider.value);
  // Empêcher max de descendre en dessous de min
  if (value < currentThresholds.minFreq) {
    value = currentThresholds.minFreq;
    maxFreqSlider.value = String(value);
  }
  currentThresholds = { ...currentThresholds, maxFreq: value };
  maxFreqValueEl.textContent = String(value);
  saveThresholds(currentThresholds);
  // Utilisé uniquement pour l'affichage rouge, pas envoyé au worklet
});

// Presets homme/femme
presetMaleBtn.addEventListener("click", () => {
  const minFreq = 75;
  const maxFreq = 150;
  currentThresholds = { ...currentThresholds, minFreq, maxFreq };
  minFreqSlider.value = String(minFreq);
  maxFreqSlider.value = String(maxFreq);
  minFreqValueEl.textContent = String(minFreq);
  maxFreqValueEl.textContent = String(maxFreq);
  saveThresholds(currentThresholds);
});

presetFemaleBtn.addEventListener("click", () => {
  const minFreq = 175;
  const maxFreq = 275;
  currentThresholds = { ...currentThresholds, minFreq, maxFreq };
  minFreqSlider.value = String(minFreq);
  maxFreqSlider.value = String(maxFreq);
  minFreqValueEl.textContent = String(minFreq);
  maxFreqValueEl.textContent = String(maxFreq);
  saveThresholds(currentThresholds);
});

sourceSelect.addEventListener("change", () => {
  selectedDeviceId = sourceSelect.value;
  saveSelectedDeviceId(selectedDeviceId);

  // Si l'écoute est déjà en cours, redémarre le pipeline audio pour
  // basculer immédiatement sur le nouveau périphérique, plutôt que
  // d'attendre le prochain clic sur "Démarrer".
  if (isRunning) {
    stopListening();
    void startListening();
  }
});

// Clic sur la fréquence pour afficher le graphique
freqEl.addEventListener("click", () => {
  void showGraphView();
});

// Clic sur le canvas pour retourner à la vue principale
pitchCanvas.addEventListener("click", () => {
  void hideGraphView();
});

// Bouton pour effacer l'historique
clearHistoryBtn.addEventListener("click", () => {
  pitchHistory.length = 0;
  drawPitchGraph();
});

// Démarrer automatiquement l'analyse audio à l'ouverture de l'application
void startListening();