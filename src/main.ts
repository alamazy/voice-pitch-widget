import { getCurrentWindow } from "@tauri-apps/api/window";

const noteEl = document.getElementById("note") as HTMLSpanElement;
const freqEl = document.getElementById("freq") as HTMLSpanElement;
const statusEl = document.getElementById("status") as HTMLDivElement;
const toggleBtn = document.getElementById("toggle-btn") as HTMLButtonElement;
const closeBtn = document.getElementById("close-btn") as HTMLButtonElement;

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
        autoGainControl: false,
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
      } else {
        freqEl.textContent = "-- Hz";
        noteEl.textContent = "--";
      }
    };

    source.connect(workletNode);
    // Pas besoin de connecter workletNode à audioContext.destination :
    // on ne fait qu'analyser, pas de sortie audio (évite le larsen).

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
