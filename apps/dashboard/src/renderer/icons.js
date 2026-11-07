// Line icons for the dashboard (24px grid, 1.6 stroke, round caps). Inline
// SVG so the app works offline and icons inherit currentColor.
(function () {
  const P = {
    waveform: '<path d="M3 12h2M7 8v8M11 4v16M15 7v10M19 10v4M21 12h0"/>',
    lipcue: '<path d="M3.7 5.7C3.7 3.8 5.2 2.3 7 2.3h9.8c1.8 0 3.3 1.5 3.3 3.4v7.3c0 1.9-1.5 3.4-3.3 3.4h-6L6.7 20v-3.7H7c-1.8 0-3.3-1.5-3.3-3.4V5.7z" stroke="currentColor" stroke-width="1.6"/><path d="M8.2 8.8v2M11.5 7v5.7" stroke="var(--text-strong, #fff)" stroke-width="1.7"/><path d="M14.8 8.2v3.3M18.2 6.2v7.3" stroke="currentColor" stroke-width="1.7"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    square: '<rect x="5" y="5" width="14" height="14" rx="1.5"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    code: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>',
    shuffle: '<path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>',
    share: '<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="m8.2 10.8 7.6-4.4M8.2 13.2l7.6 4.4"/>',
    gift: '<rect x="3.5" y="8" width="17" height="4" rx="1"/><path d="M5 12v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8M12 8v13M12 8S10.5 3.5 8 3.5a2.2 2.2 0 0 0 0 4.5zM12 8s1.5-4.5 4-4.5a2.2 2.2 0 0 1 0 4.5z"/>',
    house: '<path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z"/>',
    stack: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
    history: '<path d="M3 12a9 9 0 1 0 2.6-6.4L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    question: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 0 1 4.9.7c0 1.7-2.4 2.2-2.4 3.8"/><path d="M12 17h.01"/>',
    broadcast: '<circle cx="12" cy="12" r="2"/><path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 15.5a5 5 0 0 0 0-7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 18.4a9 9 0 0 0 0-12.8"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    'magnifying-glass': '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    'dots-three': '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M21.5 20a6.5 6.5 0 0 0-3.8-5.9"/>',
    bell: '<path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
    video: '<rect x="3" y="6.5" width="13" height="11" rx="2"/><path d="m16 10.5 5-3v9l-5-3"/>',
    play: '<path d="M7 4.5v15l12-7.5z"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    'caret-right': '<path d="m9 6 6 6-6 6"/>',
    'caret-left': '<path d="m15 6-6 6 6 6"/>',
    'caret-down': '<path d="m6 9 6 6 6-6"/>',
    'caret-up': '<path d="m6 15 6-6 6 6"/>',
    'arrow-left': '<path d="M19 12H5M11 6l-6 6 6 6"/>',
    'arrow-right': '<path d="M5 12h14M13 6l6 6-6 6"/>',
    'arrow-up-right': '<path d="M7 17 17 7M8 7h9v9"/>',
    download: '<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>',
    upload: '<path d="M12 20V9M7 13.5l5-5 5 5M5 4h14"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
    'check-circle': '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    'text-align-left': '<path d="M4 6h16M4 10h10M4 14h16M4 18h10"/>',
    cloud: '<path d="M7 18.5h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.6 9.1 4.75 4.75 0 0 0 7 18.5z"/>',
    'arrows-clockwise': '<path d="M20 8a8 8 0 0 0-14.3-2.5L4 7.5"/><path d="M4 3.5v4h4"/><path d="M4 16a8 8 0 0 0 14.3 2.5l1.7-2"/><path d="M20 20.5v-4h-4"/>',
    sparkle: '<path d="M12 3.5 13.8 10l6.2 2-6.2 2L12 20.5 10.2 14 4 12l6.2-2z"/>',
    'file-text': '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    'file-pdf': '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M8.5 16.5v-4h1.2a1.1 1.1 0 0 1 0 2.2H8.5M12.5 12.5v4h.8a2 2 0 0 0 0-4zM16.5 16.5v-4h1.6M16.5 14.5h1.2"/>',
    'file-code': '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M10 12.5l-2 2 2 2M14 12.5l2 2-2 2"/>',
    briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8.5 7V5.5A1.5 1.5 0 0 1 10 4h4a1.5 1.5 0 0 1 1.5 1.5V7M3 12.5h18"/>',
    bookmark: '<path d="M6.5 3.5h11v17L12 16.5l-5.5 4z"/>',
    microphone: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
    'microphone-slash': '<path d="M15 9.5V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 4.6 2.5M5.5 11a6.5 6.5 0 0 0 10.3 5.3M18.4 12.5a6.6 6.6 0 0 0 .1-1.5M12 17.5V21M3 3l18 18"/>',
    speaker: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11"/>',
    'speaker-slash': '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/>',
    'thumbs-up': '<path d="M7.5 10.5V20H4.5v-9.5zM7.5 10.5l4-7.5a2 2 0 0 1 2 2.3l-.6 3.7h5.6a2 2 0 0 1 2 2.4l-1.4 7a2 2 0 0 1-2 1.6H7.5"/>',
    'thumbs-down': '<path d="M7.5 13.5V4H4.5v9.5zM7.5 13.5l4 7.5a2 2 0 0 0 2-2.3l-.6-3.7h5.6a2 2 0 0 0 2-2.4l-1.4-7A2 2 0 0 0 17.1 4H7.5"/>',
    'shield-check': '<path d="M12 3 4.5 6v5.5c0 4.4 3.1 8.2 7.5 9.5 4.4-1.3 7.5-5.1 7.5-9.5V6z"/><path d="m9 12 2 2 4-4"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
    'eye-slash': '<path d="M10.6 5.6A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16.4 16.4 0 0 1-2.6 3.4M6.6 6.7C3.9 8.4 2.5 12 2.5 12s3.5 6.5 9.5 6.5a9 9 0 0 0 4.4-1.1M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18"/>',
    flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 7M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7"/>',
    pencil: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    chat: '<path d="M4 5.5h16v11H9l-5 4z"/>',
    send: '<path d="M4 12 20 4l-6 16-3-7z"/><path d="m11 13 9-9"/>',
    lightning: '<path d="M13 3 5 13.5h6L10 21l8-10.5h-6z"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8.5-8.5M16 7l2.5 2.5M14 9l2 2"/>',
    keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M8 14h8"/>',
    'credit-card': '<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="M3 10h18M7 15h3"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.5h.01"/>',
    warning: '<path d="M12 4 2.5 20h19z"/><path d="M12 10v4.5M12 17.5h.01"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
    copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2"/><path d="M15.5 8.5V5a1.5 1.5 0 0 0-1.5-1.5H5A1.5 1.5 0 0 0 3.5 5v9A1.5 1.5 0 0 0 5 15.5h3.5"/>',
    moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
    monitor: '<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M8.5 20h7M12 16.5V20"/>',
    cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9.5 9.5h5v5h-5zM9 2.5V6M15 2.5V6M9 18v3.5M15 18v3.5M2.5 9H6M2.5 15H6M18 9h3.5M18 15h3.5"/>',
    sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
    chart: '<path d="M4 4v16h16"/><path d="m7.5 14.5 3.5-4 3 3 5-6"/>',
    lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
    'lock-open': '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 7.7-1.5"/>',
    'sign-out': '<path d="M15 4h3.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H15M10 16.5 14.5 12 10 7.5M14.5 12H4"/>',
    robot: '<rect x="4.5" y="8" width="15" height="11" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01M9.5 16.5h5"/>',
    note: '<path d="M5 4h14v11l-5 5H5z"/><path d="M14 20v-5h5M8.5 9h7M8.5 12.5h4"/>',
    image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="m20.5 16-5-5-9 8.5"/>',
    camera: '<path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.3l1.5-2.5h5.4L16.2 7h2.3A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><circle cx="12" cy="13" r="3.5"/>',
    scroll: '<path d="M8 4h10a2 2 0 0 1 2 2v1h-4M8 4a2 2 0 0 0-2 2v12a2 2 0 0 1-2 2h11a2 2 0 0 0 2-2V7M8 4a2 2 0 0 1 2 2v0M9.5 10h5M9.5 14h5"/>',
    arrows: '<path d="M7 7h11l-3-3M17 17H6l3 3"/>',
    'list-checks': '<path d="m4 6.5 1.5 1.5L8.5 5M4 12.5 5.5 14l3-3M4 18.5 5.5 20l3-3M11.5 7h8.5M11.5 13h8.5M11.5 19h8.5"/>',
    command: '<path d="M9 9V6.5A2.5 2.5 0 1 0 6.5 9H9zm0 0h6m-6 0v6m6-6V6.5A2.5 2.5 0 1 1 17.5 9H15zm0 0v6m0 0h-6m6 0v2.5a2.5 2.5 0 1 0 2.5-2.5H15zm-6 0v2.5A2.5 2.5 0 1 1 6.5 15H9z"/>',
    tray: '<path d="M3.5 13.5 6 5h12l2.5 8.5V19a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z"/><path d="M3.5 13.5H8l1.5 2.5h5l1.5-2.5h4.5"/>'
  };

  function icon(name, extraClass) {
    const body = P[name] || P.question;
    const cls = extraClass ? `icon ${extraClass}` : 'icon';
    return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  }

  function fullLogo(extraClass) {
    const cls = extraClass ? ` ${extraClass}` : '';
    return `<svg class="brand-logo-svg${cls}" viewBox="16 10 470 124" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="LipCue"><g transform="translate(0 8)"><path d="M22 34C22 22.954 30.954 14 42 14H101C112.046 14 121 22.954 121 34V78C121 89.046 112.046 98 101 98H65L40 120V98H42C30.954 98 22 89.046 22 78V34Z" stroke="var(--accent)" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/><path d="M49 53V65" stroke="var(--text-strong)" stroke-width="8" stroke-linecap="round"/><path d="M69 42V76" stroke="var(--text-strong)" stroke-width="8" stroke-linecap="round"/><path d="M89 49V69" stroke="var(--accent)" stroke-width="8" stroke-linecap="round"/><path d="M109 37V81" stroke="var(--accent)" stroke-width="8" stroke-linecap="round"/></g><g aria-label="LipCue"><path d="M135 0H1083V253H440V1490H135Z" transform="translate(154.000 116.000) scale(0.05078125 -0.05078125)" fill="var(--text-strong)"/><path d="M128 0H428V1118H128ZM278 1264C368 1264 443 1332 443 1418C443 1503 368 1572 278 1572C187 1572 113 1503 113 1418C113 1332 187 1264 278 1264Z" transform="translate(208.605 116.000) scale(0.05078125 -0.05078125)" fill="var(--text-strong)"/><path d="M128 -418H428V179H437C479 89 571 -19 754 -19C1012 -19 1209 185 1209 557C1209 939 1004 1132 756 1132C566 1132 478 1019 437 930H423V1118H128ZM662 222C509 222 421 356 421 558C421 761 508 892 662 892C819 892 902 754 902 558C902 361 818 222 662 222Z" transform="translate(232.588 116.000) scale(0.05078125 -0.05078125)" fill="var(--text-strong)"/><path d="M786 -20C1162 -20 1394 233 1428 510H1119C1089 348 961 251 791 251C561 251 404 421 404 744C404 1060 559 1239 792 1239C962 1239 1090 1143 1118 981H1427C1383 1316 1125 1510 786 1510C393 1510 94 1231 94 744C94 260 389 -20 786 -20Z" transform="translate(286.947 116.000) scale(0.05078125 -0.05078125)" fill="var(--accent)"/><path d="M513 -14C683 -14 797 74 860 232L864 0H1148V1118H847V471C847 323 757 237 630 237C504 237 428 320 428 459V1118H128V407C128 145 281 -14 513 -14Z" transform="translate(359.680 116.000) scale(0.05078125 -0.05078125)" fill="var(--accent)"/><path d="M633 -22C893 -22 1071 99 1126 285L854 336C822 250 743 204 638 204C487 204 385 298 378 481H1143V565C1143 947 910 1132 618 1132C291 1132 81 898 81 553C81 200 291 -22 633 -22ZM380 669C392 807 478 906 621 906C760 906 839 815 854 669Z" transform="translate(420.227 116.000) scale(0.05078125 -0.05078125)" fill="var(--accent)"/></g></svg>`;
  }

  // Static markup uses <span data-icon="name">; swap them for the SVG once.
  function hydrateIcons(root) {
    (root || document).querySelectorAll('[data-icon]').forEach((el) => {
      if (el.dataset.iconDone) return;
      el.dataset.iconDone = '1';
      el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon));
      if (el.tagName === 'SPAN' && !el.className) el.style.display = 'inline-flex';
    });
  }

  window.CueIcons = { icon, fullLogo, hydrateIcons, names: Object.keys(P) };
})();
