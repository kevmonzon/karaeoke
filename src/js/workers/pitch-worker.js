/*
 * pitch-worker.js — runs pitch detection off the main thread.
 *
 * mic.js posts { buf: Float32Array, rate } on a timer; we reply with the detected frequency
 * in Hz (or -1 if silent/unvoiced). A dedicated Worker thread (rather than an AudioWorklet)
 * because the estimator is O(n·τmax) and would blow the audio thread's ~2.7 ms deadline.
 *
 * This is a MODULE worker: the estimator itself lives in ../pitch-yin.js so it can be unit
 * tested in node without a browser. Keep the message shape as-is — mic.js's median filter and
 * hold logic sit on top of the raw Hz.
 */

import { yinPitch } from "../pitch-yin.js";

self.onmessage = (e) => {
  const { buf, rate } = e.data;
  self.postMessage(yinPitch(buf, rate));
};
