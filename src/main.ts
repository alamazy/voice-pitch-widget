import { getCurrentWindow } from "@tauri-apps/api/window";

const noteEl = document.getElementById("note") as HTMLSpanElement;
const freqEl = document.getElementById("freq") as HTMLSpanElement;
const statusEl = document.getElementById("status") as HTMLDivElement;
const toggleBtn = document.getElementById("toggle-btn") as HTMLButtonElement;
const closeBtn = document.getElementById("close-btn") as HTMLButtonElement;
const settingsBtn = document.getElementById("settings-btn") as HTMLButtonElement;
const mainView = document.getElementById("main-view") as HTMLElement;
const settingsView = document.getElementById("settings-view") as HTMLElement;
const rmsSlider = document.getElementById("rms-slider") as HTMLInputElement;
const rmsValueEl = document.getElementById("rms-value") as HTMLSpanElement;
const peakSlider = document.getElementById("peak-slider") as HTMLInputElement;
const peakValueEl = document.getElementById("peak-value") as HTMLSpanElement;

const SETTINGS_STORAGE_KEY = "voice-pitch-widget:thresholds";

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
}

const DEFAULT_THRESHOLDS: Thresholds = {
  rmsThreshold: 0.001,
  peakThreshold: 0.2,
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
rmsValueEl.textContent = currentThresholds.rmsThreshold.toFixed(4);
peakValueEl.textContent = `${Math.round(currentThresholds.peakThreshold * 100)}%`;

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

    workletNode.port.onmessage = (event: MessageEvent<{ frequency: number }>) => {
      const { frequency } = event.data;
      if (frequency > 0) {
        const smoothed = smoother.push(frequency);
        freqEl.textContent = `${smoothed.toFixed(1)} Hz`;
        noteEl.textContent = frequencyToNote(smoothed);
        // Signal actif : on retire l'indice visuel "figé" s'il était présent.
        noteEl.classList.remove("held");
        freqEl.classList.remove("held");
      } else {
        // Pas de voix détectée : on NE touche PAS au texte affiché, la
        // dernière note/fréquence reste visible. On réinitialise juste le
        // lissage pour ne pas biaiser la prochaine détection avec des
        // valeurs devenues obsolètes, et on ajoute un indice visuel discret
        // (opacité réduite) pour signaler que la valeur est "en pause".
        smoother.reset();
        noteEl.classList.add("held");
        freqEl.classList.add("held");
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
  const isOpen = !settingsView.classList.contains("hidden");
  if (isOpen) {
    settingsView.classList.add("hidden");
    mainView.classList.remove("hidden");
    settingsBtn.classList.remove("active");
  } else {
    mainView.classList.add("hidden");
    settingsView.classList.remove("hidden");
    settingsBtn.classList.add("active");
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