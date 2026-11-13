(function mockTiming() {
  // Keep this module in sync with Browser/Home/src/lib/mockTiming.js.
  // Final transcript segments can arrive after a pause inside the same answer.
  const COMPLETE_PAUSE_MS = 3600;
  const THINKING_PAUSE_MS = 5300;
  const COMPLETE_HOLD_MS = 1000;
  const THINKING_HOLD_MS = 1200;
  const FINALIZE_WAIT_MS = 800;
  // A few words are more often the start of an answer than all of it.
  const SHORT_ANSWER_WORDS = 10;

  function createVoiceAnswer({
    onDraft, onSubmit, finalize, setTimer = setTimeout, clearTimer = clearTimeout,
  }) {
    let final = '';
    let interim = '';
    let auto = true;
    let timer;
    let flushing = false;
    let suspended = false;
    let complete = false;
    let submitted = null;
    const draft = () => [final, interim].filter(Boolean).join(' ');

    function suspend() {
      clearTimer(timer);
      flushing = false;
      suspended = true;
    }

    function take() {
      const answer = draft();
      suspend();
      final = interim = '';
      complete = false;
      submitted = null;
      onDraft('');
      return answer;
    }

    function submit(hold = 0) {
      const segments = { final, interim };
      const answer = take();
      if (hold) submitted = segments;
      if (answer) onSubmit(answer, hold);
    }

    function arm() {
      clearTimer(timer);
      if (suspended || !auto || !draft()) return;
      const settled = complete && draft().split(/\s+/u).length >= SHORT_ANSWER_WORDS;
      const hold = settled ? COMPLETE_HOLD_MS : THINKING_HOLD_MS;
      timer = setTimer(() => submit(hold), settled ? COMPLETE_PAUSE_MS : THINKING_PAUSE_MS);
    }

    function receive(message) {
      if (message.from_finalize && !flushing) return;
      if (message.type === 'SpeechStarted') {
        suspended = false;
        complete = false;
        if (!flushing) arm();
        return;
      }
      const text = message.channel?.alternatives?.[0]?.transcript?.trim();
      if (text) {
        suspended = false;
        if (message.is_final) {
          final = [final, text].filter(Boolean).join(' ');
          interim = '';
        } else {
          interim = text;
        }
        complete = Boolean(message.is_final && message.speech_final && /[.!?。！？]["'”’)]*$/u.test(text));
        onDraft(draft());
      }
      if (flushing && message.from_finalize) submit();
      else if (!flushing && text) arm();
    }

    function finishAnswer() {
      if (flushing || !draft()) return;
      clearTimer(timer);
      flushing = true;
      try {
        if (finalize()) {
          timer = setTimer(() => submit(), FINALIZE_WAIT_MS);
          return;
        }
      } catch {
        // The socket closed between the ready-state check and sending Finalize.
      }
      submit();
    }

    function restore() {
      if (!submitted) return;
      ({ final, interim } = submitted);
      submitted = null;
      complete = false;
      onDraft(draft());
    }

    function setAuto(enabled) {
      auto = enabled;
      if (!flushing) arm();
    }

    return { receive, draft, finishAnswer, suspend, take, restore, setAuto };
  }

  window.Cue.createVoiceAnswer = createVoiceAnswer;
})();
