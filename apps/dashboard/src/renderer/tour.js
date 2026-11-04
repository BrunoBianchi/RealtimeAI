// Cue dashboard — guided tours (popover + highlight), built on driver.js
// (vendor/driver, MIT).
//
// A tour is a list of steps. A step may name a route (the tour navigates
// there first), an element (selector or function; a missing one is skipped)
// and the popover text, in English like the rest of the UI (translated with
// Cue.t from the catalogs).
//
// First run: "welcome" starts once the app is unlocked, and each page's own
// tour starts the first time the page is opened. What was seen is kept in
// dashboard_profile.json (tours_seen), so a fresh install starts from zero.
// The ? button in the top bar replays the tour of the current page;
// Settings > General can reset them all.
'use strict';

(function () {
  const C = window.Cue;
  const S = C.state;
  const api = window.rtai;

  const card = (slug) => `[data-card="${slug}"]`;
  const tour = (id) => `[data-tour="${id}"]`;
  const nav = (id) => `#sideNav [data-to="${id}"]`;

  // ------------------------------------------------------------- tours --
  // steps(m) is called when the tour starts with the current mode:
  // m.local (no account, own keys) and m.running (copilot live). An
  // `optional` step only exists once there is data (it is skipped before).
  const TOURS = {
    welcome: {
      steps: (m) => [
        { title: 'Welcome to Cue', text: 'A one-minute tour of the app. Leave at any time and replay it from the ? button in the top bar.' },
        { element: '#btnNewSession', title: 'Create a session', text: 'A session is one interview: the role, the company, the job description and your files. The copilot reads all of it before every answer.', side: 'right' },
        { element: nav('sessions'), title: 'Sessions', text: 'Your interviews, upcoming and past, and how prepared each one is.', side: 'right' },
        { element: nav('files'), title: 'Files', text: 'Your resume, job descriptions and portfolio. Attach them to a session so answers are about your real experience.', side: 'right' },
        { element: nav('questions'), title: 'Question bank', text: 'Questions detected in your sessions, by company and category, to review before the next one.', side: 'right' },
        { element: nav('live'), title: 'Live', text: 'Follow the interview in real time: transcript, suggested answers and a chat with the copilot.', side: 'right' },
        { element: '#engineStatusPill', title: 'Copilot status', text: '“Ready” means transcription and AI are set up. “Set up” means a key is missing.', side: 'bottom' },
        { element: '#btnStealthChip', title: 'Hidden from captures', text: 'Keeps this window and the floating panel out of screen sharing and recordings. Shortcut: Ctrl+Alt+S.', side: 'bottom' },
        { element: '#searchTrigger', title: 'Search', text: 'Find sessions, files, questions and actions. Shortcut: Ctrl+K.', side: 'bottom' },
        { element: '#sidebarUsage', title: m.local ? 'PRO features' : 'Plan and usage', text: m.local ? 'What Cue PRO adds to local mode: cloud backup, sync across devices, Google Calendar and faster answers.' : 'Minutes used this month and when the plan renews.', side: 'right' },
        { element: nav('settings'), title: 'Next: set up the copilot', text: 'The setup guide walks through keys, audio and privacy, one screen at a time.', side: 'right', next: 'Start setup', then: () => start('setup') }
      ]
    },

    setup: {
      steps: (m) => [
        { route: 'settings/general', element: card('appearance'), title: 'Theme and language', text: 'Dark, light or the Windows theme. The interface language follows Windows by default; change it here.' },
        m.local
          ? { route: 'settings/account', element: card('local-mode'), title: 'Local mode', text: 'No account and no server: transcription and answers use your own keys, with a 500 ms wait before each answer.' }
          : { route: 'settings/account', element: card('where-the-ai-runs'), title: 'Where the AI runs', text: 'Cue servers need no keys. “My keys” uses your own provider keys instead.' },
        { route: 'settings/ai', element: card('api-keys'), title: 'API keys', text: m.local ? 'Required in local mode: a Deepgram key for transcription and one AI key (OpenRouter is the simplest). Windows encrypts them on this computer.' : 'Only needed with “My keys”: a Deepgram key for transcription and one AI key. Windows encrypts them on this computer.' },
        { route: 'settings/ai', element: card('answer-model'), title: 'Answer model', text: 'Fast has the lowest latency and suits most interviews. Ultra reasons more for system design and code.' },
        { route: 'settings/ai', element: card('behavior'), title: 'How it answers', text: 'Automatic suggestions, the language answers are written in and how long they are.' },
        { route: 'settings/audio', element: card('capture'), title: 'Audio capture', text: 'Your microphone is “You”; the system audio, what you hear in the call, is the interviewer. Pick the devices and check the microphone level.' },
        { route: 'settings/audio', element: card('transcription'), title: 'Interview language', text: 'Set the language the interviewer speaks so questions are recognized correctly.' },
        { route: 'settings/privacy', element: card('this-window'), title: 'Privacy', text: 'Hide this window and the floating panel from screen sharing and recordings.' },
        { route: 'settings/overlay', element: card('hud-size'), title: 'Floating panel', text: 'The panel (HUD) that shows answers over your meeting. Set its size here.' },
        { route: 'settings/shortcuts', element: card('during-the-interview-hud'), title: 'Shortcuts', text: 'Worth learning: Ctrl+Alt+Enter answers now and Alt+H hides everything at once.' },
        { route: 'home', title: 'All set', text: 'Create your first session and attach your resume: the copilot only answers from what you give it.', next: 'Create session', then: () => C.openModal('new-session') }
      ]
    },

    session: {
      steps: (m) => [
        { element: tour('session-actions'), title: 'This session', text: 'Edit the details, set the interview date and go live from here.', side: 'bottom' },
        { element: tour('session-prep'), title: 'Preparation', text: 'How ready the copilot is. Each item you complete gives it more context.' },
        { element: tour('session-context'), title: 'Job context', text: 'Paste the job description, research the company automatically and add instructions for the copilot.' },
        { element: tour('session-files'), title: 'Linked files', text: 'Attach your resume and other material. Answers use only what is in them, so nothing is invented.' },
        { element: tour('session-answers'), title: 'Answer style', text: 'The playbook (structure and length), the answer language, the coding language and the stage of the process.' },
        { element: tour('session-memory'), title: 'Copilot memory', text: 'After a session, save a debrief: strengths and what to improve, used in the next one.' }
      ]
    },

    live: {
      steps: (m) => (m.running
        ? [
            { element: tour('live-transcript'), title: 'Live transcript', text: 'What you and the interviewer say, as it is recognized.' },
            { element: tour('live-answer'), title: 'Suggested answer', text: 'Appears when the interviewer asks a question. Use “Answer now” to ask for one right away.' },
            { element: '#liveChat', title: 'Chat', text: 'Ask the copilot anything during the call, for example how to explain a project.', side: 'top' }
          ]
        : [
            { element: tour('live-start'), title: 'Go live', text: 'Pick the session and start. The floating panel opens over your meeting.' },
            { element: tour('live-checks'), title: 'Before you start', text: 'Transcription, AI, microphone and system audio must all be ok. Click a missing item to fix it.' },
            { element: tour('live-shortcuts'), title: 'Panel shortcuts', text: 'Control the floating panel without leaving the call.' }
          ])
    },

    files: {
      steps: (m) => [
        { element: tour('files-drop'), title: 'Add files', text: 'Drag PDF, DOCX, TXT or Markdown here. The text is extracted on this computer and linked to a session.' },
        { element: tour('files-table'), title: 'Your files', text: 'Each file, its type and the session it belongs to. “Indexed” means the copilot can read it.' }
      ]
    },

    questions: {
      steps: (m) => [
        { element: tour('questions-source'), title: 'Question bank', text: 'Fills up by itself: at the end of each recorded session, the interviewer questions are added here. Sharing them anonymized is up to you.' },
        { element: tour('questions-filters'), optional: true, title: 'Find a question', text: 'Questions from your sessions, grouped by company and category. Filter them and review before the next interview.' }
      ]
    }
  };

  // Which tour a page starts with the first time it is opened.
  const PAGE_TOUR = { home: 'welcome', session: 'session', live: 'live', files: 'files', questions: 'questions', settings: 'setup' };

  // ----------------------------------------------------------- runtime --
  const lib = () => (window.driver && window.driver.js && window.driver.js.driver) || null;
  let active = null; // { id, steps, index, driver }

  function seen() {
    return (S.profile && S.profile.tours_seen) || {};
  }

  function markSeen(id) {
    const next = { ...seen(), [id]: true };
    S.profile = { ...(S.profile || {}), tours_seen: next };
    C.guard(() => api.saveProfile({ tours_seen: next }));
  }

  function currentRoute() {
    return String(location.hash || '').replace(/^#\/?/, '') || 'home';
  }

  function find(target) {
    if (!target) return null;
    try {
      return typeof target === 'function' ? target() : document.querySelector(target);
    } catch (_e) {
      return null;
    }
  }

  // Waits for a page to render after navigating (the router runs on hashchange).
  function waitFor(target, ms = 900) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      (function poll() {
        const el = find(target);
        if (el || Date.now() - t0 > ms) return resolve(el);
        setTimeout(poll, 40);
      })();
    });
  }

  async function show(index, dir = 1) {
    if (!active) return;
    const { steps } = active;
    if (index < 0) index = 0;
    if (index >= steps.length) return finish(true);
    const st = steps[index];
    if (st.route && currentRoute() !== st.route) C.navigate(st.route);
    const el = st.element ? await waitFor(st.element) : null;
    if (!active) return;
    if (st.element && !el) return show(index + dir, dir); // not on this screen: skip
    active.index = index;
    const last = index === steps.length - 1;
    active.driver.highlight({
      element: el || undefined,
      popover: {
        title: C.t(st.title),
        description: C.t(st.text),
        side: st.side,
        align: 'start',
        showButtons: ['next', 'previous', 'close'],
        disableButtons: index === 0 ? ['previous'] : [],
        showProgress: steps.length > 1,
        progressText: `${index + 1} / ${steps.length}`,
        nextBtnText: C.t(st.next || (last ? 'Done' : 'Next')),
        prevBtnText: C.t('Back'),
        doneBtnText: C.t(st.next || 'Done'),
        onNextClick: () => {
          if (st.then) {
            finish(true);
            st.then();
          } else {
            show(index + 1, 1);
          }
        },
        onPrevClick: () => show(index - 1, -1),
        onCloseClick: () => finish(true)
      }
    });
  }

  function finish(markAsSeen) {
    if (!active) return;
    const { id, driver } = active;
    active = null;
    if (markAsSeen) markSeen(id);
    try {
      driver.destroy();
    } catch (_e) { /* already gone */ }
  }

  function mode() {
    return { local: Boolean(C.localMode()), running: Boolean(S.overlayStatus && S.overlayStatus.running) };
  }

  function start(id) {
    const make = lib();
    const def = TOURS[id];
    if (!make || !def || C.isLocked()) return false;
    if (active) finish(false);
    const steps = def.steps(mode()).filter(Boolean);
    if (!steps.length) return false;
    active = {
      id,
      steps,
      index: 0,
      driver: make({
        animate: true,
        smoothScroll: true,
        allowClose: true,
        overlayOpacity: 0.55,
        stagePadding: 6,
        stageRadius: 10,
        popoverClass: 'cue-tour',
        // Esc or a click outside ends the tour like the close button.
        onDestroyStarted: () => finish(true)
      })
    };
    show(0, 1);
    return true;
  }

  // The tour of the page on screen (? button in the top bar).
  function startForPage() {
    const id = PAGE_TOUR[S.route.view] || 'welcome';
    if (id === 'session' && S.route.view !== 'session') return start('welcome');
    return start(id);
  }

  // First run: welcome once, then each page's tour the first time it opens.
  let pending = null;
  function maybeAutoStart() {
    clearTimeout(pending);
    if (active || C.isLocked() || !lib()) return;
    if (document.querySelector('#modalRoot .modal')) return;
    const s = seen();
    const id = !s.welcome ? 'welcome' : PAGE_TOUR[S.route.view];
    if (!id || s[id] || id === 'setup') return; // setup runs from welcome or on request
    pending = setTimeout(() => {
      if (!active && !C.isLocked() && !seen()[id]) start(id);
    }, 500);
  }

  C.tours = TOURS;
  C.startTour = start;
  C.tourActive = () => (active ? active.id : null);
  C.onViewRendered = maybeAutoStart;

  C.actions['start-tour'] = () => startForPage();
  C.actions['start-setup-tour'] = () => start('setup');
  C.actions['tour-reset'] = async () => {
    S.profile = { ...(S.profile || {}), tours_seen: {} };
    await C.guard(() => api.saveProfile({ tours_seen: {} }));
    C.navigate('home');
    start('welcome');
  };

  // Every popover text and button label, for the translation coverage check.
  C.tourStrings = () => {
    const out = new Set(['Next', 'Back', 'Done']);
    const modes = [false, true].flatMap((local) => [false, true].map((running) => ({ local, running })));
    for (const def of Object.values(TOURS)) {
      for (const st of modes.flatMap((m) => def.steps(m)).filter(Boolean)) {
        out.add(st.title);
        out.add(st.text);
        if (st.next) out.add(st.next);
      }
    }
    return [...out];
  };

})();
