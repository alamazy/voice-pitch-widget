import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";

const noteEl = document.getElementById("note") as HTMLSpanElement;
const freqEl = document.getElementById("freq") as HTMLSpanElement;
const statusEl = document.getElementById("status") as HTMLDivElement;
const toggleBtn = document.getElementById("toggle-btn") as HTMLButtonElement;
const closeBtn = document.getElementById("close-btn") as HTMLButtonElement;
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

const SETTINGS_STORAGE_KEY = "voice-pitch-widget:thresholds";

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

async function startListening() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        // Activé : l'AGC ajuste le volume d'entrée mais ne modifie pas la
        // fréquence du signal, donc n'introduit aucun biais sur la mesure
        // de pitch. Ça aide beaucoup à détecter une voix à volume normal
        // sans avoir à chanter/parler fort.
        autoGainControl: true,
      },
    });

    audioContext = new AudioContext();
    await audioContext.audioWorklet.addModule("/pitch-processor.js");

    const source = audioContext.createMediaStreamSource(mediaStream);
    workletNode = new AudioWorkletNode(audioContext, "pitch-processor");

    workletNode.port.onmessage = (event: MessageEvent<{ frequency: number; spectrum?: number[] }>) => {
      const { frequency, spectrum } = event.data;
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

    isRunning = true;
    toggleBtn.textContent = "Arrêter";
    statusEl.textContent = "Écoute en cours…";
  } catch (err) {
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
  isRunning = false;
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

  // Limites de fréquence fixes pour l'affichage du spectrogramme (toujours 50-450)
  const minFreq = 50;
  const maxFreq = 450;

  const now = Date.now();
  const timeRange = MAX_HISTORY_DURATION; // Fenêtre fixe de 30 secondes

  // Dessiner le spectrogramme en arrière-plan
  const fftSize = 8192; // Doit correspondre à la taille FFT du worklet
  const sampleRate = 48000; // Estimation du sample rate
  const freqPerBin = sampleRate / fftSize; // ~5.86 Hz par bin
  
  // Le spectre retourné commence à 50 Hz
  const spectrumMinFreq = 50;
  
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

// Enum pour les différentes vues
enum View {
  Main = "main",
  Settings = "settings",
  Graph = "graph",
}

let currentView: View = View.Main;

async function showView(view: View) {
  // Arrêter l'animation du graphique si elle tourne
  if (graphAnimationId !== null) {
    cancelAnimationFrame(graphAnimationId);
    graphAnimationId = null;
  }

  // Masquer toutes les vues
  mainView.classList.add("hidden");
  settingsView.classList.add("hidden");
  graphView.classList.add("hidden");

  // Afficher la vue demandée et redimensionner
  const window = getCurrentWindow();
  
  try {
    switch (view) {
      case View.Main:
        mainView.classList.remove("hidden");
        settingsBtn.classList.remove("active");
        await window.setSize(new LogicalSize(240, 160));
        break;
        
      case View.Settings:
        settingsView.classList.remove("hidden");
        settingsBtn.classList.add("active");
        await window.setSize(new LogicalSize(270, 180));
        break;
        
      case View.Graph:
        graphView.classList.remove("hidden");
        settingsBtn.classList.remove("active");
        await window.setSize(new LogicalSize(240, 320));
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
  void getCurrentWindow().close();
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