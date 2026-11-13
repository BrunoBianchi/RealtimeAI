(function mockRecording() {
  // Keep this module in sync with Browser/Home/src/lib/mockRecording.js.
  // The recording of a voice mock interview: each answer is cut from the same
  // 16 kHz PCM16 the transcription receives and kept as a WAV file; each
  // interviewer turn keeps the MP3 sentences that were played. Nothing here
  // leaves the device.
  const SAMPLE_RATE = 16000;
  // Longest answer kept (about 19 MB of WAV).
  const MAX_ANSWER_S = 600;
  // Less speech than this is not an answer worth playing.
  const MIN_SPEECH_S = 0.4;
  // RMS of a block, as a fraction of full scale, under which it is silence.
  const SILENCE_RMS = 0.012;
  // Silence kept before and after the speech.
  const PAD_MS = 400;

  // Collects the microphone blocks of the answer being given. take() hands
  // them over when the answer is sent; restore() puts them back when the answer
  // turns out to go on.
  function createAnswerRecorder({ sampleRate = SAMPLE_RATE, maxSeconds = MAX_ANSWER_S } = {}) {
    let blocks = [];
    let samples = 0;
    const limit = sampleRate * maxSeconds;
    function push(chunk) {
      const pcm = new Int16Array(chunk instanceof Int16Array ? chunk : new Int16Array(chunk));
      if (!pcm.length || samples + pcm.length > limit) return;
      blocks.push(pcm);
      samples += pcm.length;
    }
    function take() {
      const out = blocks;
      blocks = [];
      samples = 0;
      return out;
    }
    function restore(earlier) {
      if (!earlier || !earlier.length) return;
      blocks = [...earlier, ...blocks];
      samples = blocks.reduce((n, b) => n + b.length, 0);
    }
    return { push, take, restore, seconds: () => samples / sampleRate };
  }

  function rms(block) {
    let sum = 0;
    for (let i = 0; i < block.length; i += 1) sum += block[i] * block[i];
    return block.length ? Math.sqrt(sum / block.length) / 32768 : 0;
  }

  // The blocks from a little before the first sound to a little after the last.
  function trimSilence(blocks, sampleRate = SAMPLE_RATE) {
    const loud = blocks.map((b) => rms(b) >= SILENCE_RMS);
    const first = loud.indexOf(true);
    if (first < 0) return [];
    const last = loud.lastIndexOf(true);
    const size = blocks[first].length || 1;
    const pad = Math.ceil((sampleRate * PAD_MS) / 1000 / size);
    return blocks.slice(Math.max(0, first - pad), last + pad + 1);
  }

  // 16-bit mono WAV bytes, or null with too little audio.
  function encodeWav(blocks, sampleRate = SAMPLE_RATE) {
    const total = blocks.reduce((n, b) => n + b.length, 0);
    if (total < sampleRate * MIN_SPEECH_S) return null;
    const out = new Uint8Array(44 + total * 2);
    const view = new DataView(out.buffer);
    const ascii = (at, s) => { for (let i = 0; i < s.length; i += 1) out[at + i] = s.charCodeAt(i); };
    ascii(0, 'RIFF');
    view.setUint32(4, 36 + total * 2, true);
    ascii(8, 'WAVE');
    ascii(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    ascii(36, 'data');
    view.setUint32(40, total * 2, true);
    let at = 44;
    for (const b of blocks) {
      for (let i = 0; i < b.length; i += 1, at += 2) view.setInt16(at, b[i], true);
    }
    return out;
  }

  // The answer as WAV bytes without the silence around it, or null.
  function answerAudio(blocks, sampleRate = SAMPLE_RATE) {
    return encodeWav(trimSilence(blocks, sampleRate), sampleRate);
  }

  function wavSeconds(bytes, sampleRate = SAMPLE_RATE) {
    return bytes && bytes.length > 44 ? Math.round(((bytes.length - 44) / 2 / sampleRate) * 10) / 10 : 0;
  }

  // The messages a turn added, from the transcript's length before it: the
  // answer gets the answer's recording, the interviewer's reply the sentences.
  function addedTurns(messages, before) {
    return messages.slice(before).map((m, n) => ({ i: before + n, role: m.role }));
  }

  // Interviewer turns and answers in order: each question with the answer that
  // followed it. `audio` lists the recorded messages as {i, role}.
  function recordingPairs(messages, audio = []) {
    const has = new Set(audio.map((a) => `${a.role}:${a.i}`));
    const pairs = [];
    messages.forEach((m, i) => {
      const clip = has.has(`${m.role}:${i}`);
      if (m.role === 'assistant') pairs.push({ question: { i, text: m.content, audio: clip }, answer: null });
      else if (pairs.length && !pairs[pairs.length - 1].answer) pairs[pairs.length - 1].answer = { i, text: m.content, audio: clip };
      else pairs.push({ question: null, answer: { i, text: m.content, audio: clip } });
    });
    return pairs;
  }

  window.Cue.mockRecording = { SAMPLE_RATE, createAnswerRecorder, trimSilence, encodeWav, answerAudio, wavSeconds, addedTurns, recordingPairs };
})();
