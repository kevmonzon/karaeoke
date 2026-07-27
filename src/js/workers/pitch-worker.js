/*
 * pitch-worker.js — a classic Web Worker that runs the (heavy, O(n²))
 * autocorrelation pitch detection off the main thread.
 *
 * mic.js posts { buf: Float32Array, rate } on a timer; we reply with the detected
 * frequency in Hz (or -1 if unvoiced/too quiet). Running here keeps the rAF loop
 * responsive; a dedicated worker thread also avoids the audio-thread deadline that
 * an AudioWorklet would impose.
 */

self.onmessage = (e) => {
  const { buf, rate } = e.data;
  self.postMessage(detectHz(buf, rate));
};

function detectHz(buf, sampleRate) {
  const SIZE = buf.length;
  let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.005) return -1; // silence (~-46 dBFS; low enough to catch soft singing)

  let r1 = 0, r2 = SIZE - 1;
  const thres = 0.2;
  for (let i = 0; i < SIZE / 2; i++) if (Math.abs(buf[i]) < thres) { r1 = i; break; }
  for (let i = 1; i < SIZE / 2; i++) if (Math.abs(buf[SIZE - i]) < thres) { r2 = SIZE - i; break; }
  const b = buf.slice(r1, r2);
  const n = b.length;
  if (n < 8) return -1;

  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n - i; j++) c[i] += b[j] * b[j + i];

  let d = 0;
  while (d < n - 1 && c[d] > c[d + 1]) d++;
  let maxval = -1, maxpos = -1;
  for (let i = d; i < n; i++) if (c[i] > maxval) { maxval = c[i]; maxpos = i; }
  let T0 = maxpos;
  if (T0 <= 0) return -1;

  const x1 = c[T0 - 1] || 0, x2 = c[T0], x3 = c[T0 + 1] || 0;
  const a = (x1 + x3 - 2 * x2) / 2, bb = (x3 - x1) / 2;
  if (a) T0 = T0 - bb / (2 * a);

  const hz = sampleRate / T0;
  return hz > 50 && hz < 1500 ? hz : -1;
}
