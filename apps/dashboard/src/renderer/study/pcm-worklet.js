// LipCue.com audio worklet: microphone (and shared meeting audio) to PCM16.
//
// Runs on the audio thread. Each 128-frame render block is written into a
// fixed 640-frame accumulator (40 ms at 16 kHz); when it is full, the buffer
// is transferred to the page (port.postMessage(buf, [buf])), which sends it to
// the transcription socket. With 2 channels the samples are interleaved
// (channel 0 = you, channel 1 = the others). No network calls here.
//
// processorOptions: { channels: 1 | 2, frames?: number }

class Pcm16Processor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.channels = o.channels === 2 ? 2 : 1;
    this.frames = o.frames > 0 ? o.frames : 640;
    this.buf = new Int16Array(this.frames * this.channels);
    this.at = 0; // frames written into buf
  }

  process(inputs) {
    const input = (inputs && inputs[0]) || [];
    const ch = this.channels;
    const n = input[0] ? input[0].length : 128;
    for (let i = 0; i < n; i += 1) {
      const base = this.at * ch;
      for (let c = 0; c < ch; c += 1) {
        const data = input[c] || (ch === 2 && c === 1 ? null : input[0]);
        let v = data ? data[i] : 0;
        v = v > 1 ? 1 : v < -1 ? -1 : v;
        this.buf[base + c] = v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
      }
      this.at += 1;
      if (this.at === this.frames) {
        const out = this.buf.buffer;
        this.port.postMessage(out, [out]);
        this.buf = new Int16Array(this.frames * ch);
        this.at = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm16', Pcm16Processor);
