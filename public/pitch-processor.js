// AudioWorkletProcessor exécuté dans le thread audio temps réel.
// Accumule les échantillons dans une fenêtre glissante, puis applique
// une autocorrélation (méthode "ACF2+") pour estimer F0.
// Volontairement dépendance-free : pas besoin de bundler une lib ici.

class PitchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // Taille de la fenêtre d'analyse agrandie pour la FFT haute résolution
    this.bufferSize = 8192;
    this.buffer = new Float32Array(this.bufferSize);
    this.writeIndex = 0;

    // Seuils configurables en live depuis l'UI (voir onmessage plus bas).
    // rmsThreshold : niveau sonore minimum pour considérer qu'il y a un
    //   signal (et pas juste du bruit de fond / silence).
    // peakThreshold : ratio (0-1) du pic du buffer utilisé pour "trimmer"
    //   les bords silencieux avant l'autocorrélation.
    this.rmsThreshold = 0.01;
    this.peakThreshold = 0.2;

    // On ne recalcule pas à chaque bloc de 128 échantillons (coûteux
    // et inutile) : on lance l'analyse toutes les N frames.
    this.framesSinceAnalysis = 0;
    this.analysisIntervalFrames = 8; // ~toutes les 8*128 = 1024 échantillons (plus espacé pour FFT lourde)

    // Permet à l'UI (main.ts) d'ajuster les seuils en live, sans recharger
    // le worklet. Message attendu :
    // { type: "update-thresholds", rmsThreshold, peakThreshold }
    this.port.onmessage = (event) => {
      const data = event.data;
      if (data && data.type === "update-thresholds") {
        if (typeof data.rmsThreshold === "number") {
          this.rmsThreshold = data.rmsThreshold;
        }
        if (typeof data.peakThreshold === "number") {
          this.peakThreshold = data.peakThreshold;
        }
      }
    };
  }

  // Autocorrélation normalisée + recherche du premier pic significatif.
  // Retourne la fréquence en Hz, ou -1 si aucun pitch fiable détecté.
  autoCorrelate(buffer, sampleRate) {
    const size = buffer.length;

    // RMS : on ignore le silence / bruit de fond trop faible.
    let rms = 0;
    let peak = 0;
    for (let i = 0; i < size; i++) {
      const abs = Math.abs(buffer[i]);
      rms += buffer[i] * buffer[i];
      if (abs > peak) peak = abs;
    }
    rms = Math.sqrt(rms / size);
    if (rms < this.rmsThreshold) return -1;

    // Recherche des bornes utiles du signal (trim silence de bord).
    // Le seuil est RELATIF au pic du buffer plutôt qu'une valeur absolue :
    // un seuil fixe supposerait un signal proche du maximum théorique
    // (1.0), ce qui exigerait de crier pour le dépasser.
    let start = 0;
    let end = size - 1;
    const threshold = Math.max(peak * this.peakThreshold, 0.001);
    while (start < size / 2 && Math.abs(buffer[start]) < threshold) start++;
    while (end > size / 2 && Math.abs(buffer[end]) < threshold) end--;

    const trimmed = buffer.slice(start, end + 1);
    const n = trimmed.length;
    if (n < 512) return -1;

    const c = new Float32Array(n);
    for (let lag = 0; lag < n; lag++) {
      let sum = 0;
      for (let i = 0; i < n - lag; i++) {
        sum += trimmed[i] * trimmed[i + lag];
      }
      c[lag] = sum;
    }

    // On cherche le premier minimum local après lag=0, puis le maximum
    // qui suit : c'est la signature classique d'une périodicité.
    let d = 0;
    while (d < n - 1 && c[d] > c[d + 1]) d++;

    let maxVal = -1;
    let maxPos = -1;
    for (let i = d; i < n; i++) {
      if (c[i] > maxVal) {
        maxVal = c[i];
        maxPos = i;
      }
    }

    if (maxPos <= 0) return -1;

    // Interpolation parabolique autour du pic pour affiner la précision.
    let period = maxPos;
    const x0 = maxPos < 1 ? maxPos : maxPos - 1;
    const x2 = maxPos + 1 < n ? maxPos + 1 : maxPos;
    if (x0 !== maxPos && x2 !== maxPos) {
      const a = c[x0];
      const b = c[maxPos];
      const cc = c[x2];
      const denom = a - 2 * b + cc;
      if (denom !== 0) {
        period = maxPos + (0.5 * (a - cc)) / denom;
      }
    }

    const frequency = sampleRate / period;

    // Filtre plage vocale plausible (élargie pour couvrir voix graves/aiguës).
    if (frequency < 50 || frequency > 1000) return -1;

    return frequency;
  }

  // Calcule le spectre de magnitudes (optimisé) pour le spectrogramme
  computeSpectrum(buffer, sampleRate) {
    const fftSize = 8192; // Taille FFT très grande pour excellente résolution
    const freqPerBin = sampleRate / fftSize; // ~5.86 Hz par bin
    
    // Calculer uniquement les bins dans la plage vocale (50-450 Hz)
    const minFreq = 50;
    const maxFreq = 450;
    const minBin = Math.floor(minFreq / freqPerBin);
    const maxBin = Math.ceil(maxFreq / freqPerBin);
    const numBins = maxBin - minBin + 1;
    
    // Fenêtre de Hann pour réduire les artefacts
    const windowed = new Float32Array(fftSize);
    for (let i = 0; i < fftSize; i++) {
      const window = 0.5 * (1 - Math.cos(2 * Math.PI * i / fftSize));
      windowed[i] = buffer[i] * window;
    }
    
    // FFT simplifiée - calcul des magnitudes uniquement pour les bins d'intérêt
    const spectrum = new Float32Array(numBins);
    
    for (let i = 0; i < numBins; i++) {
      const bin = minBin + i;
      const freq = bin * freqPerBin;
      let real = 0;
      let imag = 0;
      
      for (let j = 0; j < fftSize; j++) {
        const angle = -2 * Math.PI * freq * j / sampleRate;
        real += windowed[j] * Math.cos(angle);
        imag += windowed[j] * Math.sin(angle);
      }
      
      // Magnitude normalisée (log scale pour meilleure visualisation)
      const magnitude = Math.sqrt(real * real + imag * imag) / fftSize;
      spectrum[i] = Math.max(0, Math.min(1, magnitude * 10)); // Amplification et limitation
    }
    
    return spectrum;
    return spectrum;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const channel = input[0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      this.buffer[this.writeIndex] = channel[i];
      this.writeIndex = (this.writeIndex + 1) % this.bufferSize;
    }

    this.framesSinceAnalysis++;
    if (this.framesSinceAnalysis >= this.analysisIntervalFrames) {
      this.framesSinceAnalysis = 0;

      // Réordonne le buffer circulaire en ordre chronologique avant analyse.
      const ordered = new Float32Array(this.bufferSize);
      for (let i = 0; i < this.bufferSize; i++) {
        ordered[i] = this.buffer[(this.writeIndex + i) % this.bufferSize];
      }

      const frequency = this.autoCorrelate(ordered, sampleRate);
      
      // Calculer le spectre pour le spectrogramme
      const spectrum = this.computeSpectrum(ordered, sampleRate);
      
      this.port.postMessage({ frequency, spectrum: Array.from(spectrum) });
    }

    return true; // garde le processor actif
  }
}

registerProcessor("pitch-processor", PitchProcessor);