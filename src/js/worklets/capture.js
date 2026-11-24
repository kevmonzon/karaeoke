/*
 * capture.js — AudioWorkletProcessor "capture" (M9, plan §5.17): hands the raw microphone signal to
 * the main thread for latency calibration.
 *
 * CONTRACT STUB written by the orchestrator. Lane B fills it.
 *
 * For every render quantum with input on input 0, posts { frame: currentFrame, samples: Float32Array }
 * (the channels mixed to mono; a fresh copy, transferred). `frame` is the AudioContext frame of the
 * quantum's first sample, so main-thread code converts it to the context's clock as frame / sampleRate.
 * Returns true (stays alive) until the port receives "stop". The node is created with
 * numberOfOutputs: 1 and pulled through a zero-gain GainNode, or the browser never runs it.
 *
 * Mono = the mean of the input's channels (so a stereo device keeps the level a mono one has).
 * Nothing is written to the output: it stays silent, and the zero gain after it is the second
 * guarantee that the raw microphone never reaches the speakers. Loaded through
 * AudioEngine.ensureWorkletModule (one addModule per context — a second registerProcessor of the
 * same name throws).
 */

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._stopped = false;
    this.port.onmessage = (e) => {
      if (e && e.data === "stop") this._stopped = true;
    };
  }

  process(inputs) {
    if (this._stopped) return false;                // let the node be collected
    const input = inputs && inputs[0];
    const first = input && input[0];
    if (!first || !first.length) return true;       // no input connected (yet): stay alive
    const n = first.length;
    const k = input.length;
    const mono = new Float32Array(n);
    for (let c = 0; c < k; c++) {
      const ch = input[c];
      if (!ch) continue;
      for (let i = 0; i < n; i++) mono[i] += ch[i];
    }
    if (k > 1) for (let i = 0; i < n; i++) mono[i] /= k;
    // currentFrame is the AudioWorkletGlobalScope's frame of this quantum's first sample.
    this.port.postMessage({ frame: currentFrame, samples: mono }, [mono.buffer]);
    return true;
  }
}

registerProcessor("capture", CaptureProcessor);
