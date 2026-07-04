// AudioWorklet: downsample the mic to 16 kHz mono and post 1280-sample (80 ms)
// float32 frames to the main thread, which feeds them to the openWakeWord
// pipeline. Linear resampling from the context rate (usually 48 kHz).
class MicDownsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000; // e.g. 48000/16000 = 3
    this.pos = 0;                    // fractional read position into the input
    this.frame = new Float32Array(1280);
    this.n = 0;
    this._tail = 0;                  // last sample of the previous block (for interpolation)
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || !ch.length) return true;
    // resample this block into 16 kHz samples, accumulate into 1280-frames
    let p = this.pos;
    while (p < ch.length) {
      const i = Math.floor(p);
      const frac = p - i;
      const a = i > 0 ? ch[i - 1] : this._tail;
      const b = ch[i];
      this.frame[this.n++] = a + (b - a) * frac;
      if (this.n === 1280) {
        this.port.postMessage(this.frame.slice(0)); // copy — worklet reuses the buffer
        this.n = 0;
      }
      p += this.ratio;
    }
    this.pos = p - ch.length; // carry the fractional offset into the next block
    this._tail = ch[ch.length - 1];
    return true;
  }
}
registerProcessor("mic-downsampler", MicDownsampler);
