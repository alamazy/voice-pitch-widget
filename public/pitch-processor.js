// AudioWorkletProcessor exécuté dans le thread audio temps réel.
// Accumule les échantillons dans une fenêtre glissante, applique une
// autocorrélation pour estimer F0, et une FFT pour le spectrogramme.
// Volontairement dépendance-free : pas besoin de bundler une lib ici.

// -----------------------------------------------------------------------
// FFT radix-2 Cooley-Tukey, itérative, in-place.
// Complexité O(N log N), contre O(N * nombreDeBins) pour une DFT directe
// bin par bin. Les tables (bit-reversal + twiddle factors) sont
// précalculées une seule fois à la construction du processor et
// réutilisées à chaque frame, pour ne rien recalculer dans le chemin
// temps réel (critique sur le thread audio, qui ne tolère aucun
// dépassement de budget sous peine de glitchs sonores).
// -----------------------------------------------------------------------

/** Précalcule la table de bit-reversal et les facteurs de rotation (twiddles). */
function buildFFTTables(size) {
  const bits = Math.log2(size);
  if (!Number.isInteger(bits)) {
    throw new Error("La taille FFT doit être une puissance de 2");
  }

  const bitReverse = new Uint32Array(size);
  for (let i = 0; i < size; i++) {
    let rev = 0;
    let x = i;
    for (let b = 0; b < bits; b++) {
      rev = (rev << 1) | (x & 1);
      x >>= 1;
    }
    bitReverse[i] = rev;
  }

  const cosTable = new Float32Array(size / 2);
  const sinTable = new Float32Array(size / 2);
  for (let i = 0; i < size / 2; i++) {
    const angle = (-2 * Math.PI * i) / size;
    cosTable[i] = Math.cos(angle);
    sinTable[i] = Math.sin(angle);
  }

  return { bits, bitReverse, cosTable, sinTable };
}

/**
 * FFT radix-2 in-place sur des tableaux real/imag de même taille (doit
 * être une puissance de 2). Résultat écrit directement dans real/imag.
 */
function fftInPlace(real, imag, tables) {
  const { bits, bitReverse, cosTable, sinTable } = tables;
  const size = real.length;

  // Réordonnancement bit-reversal (permutation préalable requise par
  // l'algorithme de Cooley-Tukey en version itérative).
  for (let i = 0; i < size; i++) {
    const j = bitReverse[i];
    if (j > i) {
      let tmp = real[i];
      real[i] = real[j];
      real[j] = tmp;
      tmp = imag[i];
      imag[i] = imag[j];
      imag[j] = tmp;
    }
  }

  // Papillons (butterflies), étage par étage : log2(size) étages, chacun
  // en O(size), soit O(size log size) au total.
  for (let stage = 1; stage <= bits; stage++) {
    const stageSize = 1 << stage;
    const halfStage = stageSize >> 1;
    const twiddleStep = size / stageSize;

    for (let start = 0; start < size; start += stageSize) {
      for (let k = 0; k < halfStage; k++) {
        const twiddleIndex = k * twiddleStep;
        const cos = cosTable[twiddleIndex];
        const sin = sinTable[twiddleIndex];

        const evenIndex = start + k;
        const oddIndex = start + k + halfStage;

        const oddReal = real[oddIndex];
        const oddImag = imag[oddIndex];

        const tRe = oddReal * cos - oddImag * sin;
        const tIm = oddReal * sin + oddImag * cos;

        real[oddIndex] = real[evenIndex] - tRe;
        imag[oddIndex] = imag[evenIndex] - tIm;
        real[evenIndex] += tRe;
        imag[evenIndex] += tIm;
      }
    }
  }
}

class PitchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // Taille de la fenêtre d'analyse. Doit rester une puissance de 2
    // (contrainte de la FFT radix-2). 8192 échantillons @48kHz donne une
    // résolution de sampleRate/8192 ≈ 5.86 Hz par bin, largement de quoi
    // distinguer des notes vocales adjacentes.
    this.bufferSize = 8192;
    this.buffer = new Float32Array(this.bufferSize);
    this.writeIndex = 0;

    // Buffers réutilisés à chaque frame pour la FFT, alloués une seule
    // fois (éviter toute allocation dans process()/computeSpectrum(),
    // qui déclencherait le garbage collector sur le thread audio et
    // provoquerait des coupures sonores).
    this.fftReal = new Float32Array(this.bufferSize);
    this.fftImag = new Float32Array(this.bufferSize);
    this.fftTables = buildFFTTables(this.bufferSize);

    // Fenêtre de Hann précalculée une seule fois (évite un cos() par
    // échantillon à chaque frame).
    this.hannWindow = new Float32Array(this.bufferSize);
    for (let i = 0; i < this.bufferSize; i++) {
      this.hannWindow[i] =
        0.5 * (1 - Math.cos((2 * Math.PI * i) / this.bufferSize));
    }

    // Plage de fréquences utile pour le spectrogramme (voix humaine).
    // Bins précalculés une fois : `sampleRate` est une constante globale
    // du AudioWorkletGlobalScope, disponible dès le constructeur.
    const freqPerBin = sampleRate / this.bufferSize;
    this.spectrumMinBin = Math.max(1, Math.floor(50 / freqPerBin));
    this.spectrumMaxBin = Math.min(
      this.bufferSize / 2 - 1,
      Math.ceil(450 / freqPerBin)
    );

    // Seuils configurables en live depuis l'UI (voir onmessage plus bas).
    // rmsThreshold : niveau sonore minimum pour considérer qu'il y a un
    //   signal (et pas juste du bruit de fond / silence).
    // peakThreshold : ratio (0-1) du pic du buffer utilisé pour "trimmer"
    //   les bords silencieux avant l'autocorrélation.
    this.rmsThreshold = 0.05;
    this.peakThreshold = 0.25;

    // On ne recalcule pas à chaque bloc de 128 échantillons (coûteux
    // et inutile) : on lance l'analyse toutes les N frames.
    this.framesSinceAnalysis = 0;
    this.analysisIntervalFrames = 8; // ~toutes les 8*128 = 1024 échantillons

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

  /**
   * Calcule le spectre de magnitudes via une vraie FFT radix-2, puis
   * n'extrait que la plage vocale utile (50-450 Hz) pour le spectrogramme.
   * Remplace l'ancienne DFT directe bin-par-bin : même résultat, mais en
   * O(N log N) au lieu de O(N * nombreDeBins), donc largement plus rapide
   * — la marge gagnée permettrait par exemple d'augmenter bufferSize pour
   * une résolution encore plus fine si besoin, sans re-complexifier ici.
   */
  computeSpectrum(buffer, sampleRate) {
    const fftSize = this.bufferSize;

    // Fenêtrage de Hann (réduit les artefacts de fuite spectrale) +
    // remise à zéro de la partie imaginaire, dans les buffers réutilisés.
    for (let i = 0; i < fftSize; i++) {
      this.fftReal[i] = buffer[i] * this.hannWindow[i];
      this.fftImag[i] = 0;
    }

    fftInPlace(this.fftReal, this.fftImag, this.fftTables);

    const minBin = this.spectrumMinBin;
    const maxBin = this.spectrumMaxBin;
    const numBins = maxBin - minBin + 1;

    const spectrum = new Float32Array(numBins);
    for (let i = 0; i < numBins; i++) {
      const bin = minBin + i;
      const magnitude =
        Math.sqrt(
          this.fftReal[bin] * this.fftReal[bin] +
            this.fftImag[bin] * this.fftImag[bin]
        ) / fftSize;
      // Amplification et limitation (mise à l'échelle empirique pour un
      // rendu lisible dans le spectrogramme, comme dans la version précédente).
      spectrum[i] = Math.max(0, Math.min(1, magnitude * 10));
    }

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
      const spectrum = this.computeSpectrum(ordered, sampleRate);

      this.port.postMessage({ frequency, spectrum: Array.from(spectrum) });
    }

    return true; // garde le processor actif
  }
}

registerProcessor("pitch-processor", PitchProcessor);