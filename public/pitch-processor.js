// AudioWorkletProcessor exécuté dans le thread audio temps réel.
// Accumule les échantillons dans une fenêtre glissante, puis applique
// une autocorrélation (méthode "ACF2+") pour estimer F0.
// Volontairement dépendance-free : pas besoin de bundler une lib ici.

class PitchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // Taille de la fenêtre d'analyse. 2048 échantillons à 44.1/48kHz
    // couvre largement les fondamentales vocales (~65-1000 Hz).
    this.bufferSize = 2048;
    this.buffer = new Float32Array(this.bufferSize);
    this.writeIndex = 0;

    // On ne recalcule pas à chaque bloc de 128 échantillons (coûteux
    // et inutile) : on lance l'analyse toutes les N frames.
    this.framesSinceAnalysis = 0;
    this.analysisIntervalFrames = 4; // ~toutes les 4*128 = 512 échantillons
  }

  // Autocorrélation normalisée + recherche du premier pic significatif.
  // Retourne la fréquence en Hz, ou -1 si aucun pitch fiable détecté.
  autoCorrelate(buffer, sampleRate) {
    const size = buffer.length;

    // RMS : on ignore le silence / bruit de fond trop faible.
    let rms = 0;
    for (let i = 0; i < size; i++) rms += buffer[i] * buffer[i];
    rms = Math.sqrt(rms / size);
    if (rms < 0.01) return -1;

    // Recherche des bornes utiles du signal (trim silence de bord).
    let start = 0;
    let end = size - 1;
    const threshold = 0.2;
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
      this.port.postMessage({ frequency });
    }

    return true; // garde le processor actif
  }
}

registerProcessor("pitch-processor", PitchProcessor);
