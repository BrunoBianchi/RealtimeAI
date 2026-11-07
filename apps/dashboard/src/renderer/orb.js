// Orby, the animated interviewer: a canvas with a friendly face. Views
// render C.orb(state, size) and C.startOrbs() brings the canvases on the page to
// life. The state lives on the element (data-state), so painting a new state
// never restarts the animation. Each loop stops when its canvas leaves the page.
'use strict';

(function orbModule() {
  const C = window.Cue;

  C.orb = function orb(state, size, extraClass) {
    return `<canvas class="orby ${extraClass || ''}" data-orb data-state="${state || 'idle'}" data-size="${size}" width="${size}" height="${size}" style="width:${size}px;height:${size}px" role="img" aria-label="Orby"></canvas>`;
  };

  C.setOrbState = function setOrbState(state, root) {
    const scope = root || document;
    for (const el of scope.querySelectorAll('canvas[data-orb]')) el.dataset.state = state || 'idle';
  };

  // A calm, matte mascot: no aura, no rays, no glow. The state shows on the
  // face (eyes, mouth, a few thinking dots) and the body only breathes slowly,
  // so it is easy to look at for a whole interview.
  function draw(el, ctx, size, st, now) {
    const t = (now - st.t0) / 1000;
    const mode = el.dataset.state || 'idle';
    const thinking = mode === 'thinking' || mode === 'connecting';
    const cx = size / 2;
    const bob = Math.sin(t * 1.6) * size * 0.008;
    const cy = size * 0.5 + bob;
    const r = size * 0.32 * (1 + 0.012 * Math.sin(t * 1.6));
    ctx.clearRect(0, 0, size, size);

    // Soft contact shadow, so it sits on the page instead of floating in light.
    ctx.beginPath();
    ctx.ellipse(cx, size * 0.5 + r * 1.06, r * (0.62 - bob / size), r * 0.1, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,.28)';
    ctx.fill();

    // Body: a gentle top-to-bottom green, darker at the base. No gloss.
    const body = ctx.createLinearGradient(0, cy - r, 0, cy + r);
    body.addColorStop(0, 'rgb(74,222,128)');
    body.addColorStop(0.55, 'rgb(34,197,94)');
    body.addColorStop(1, 'rgb(21,128,61)');
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = body;
    ctx.fill();
    // Matte shading on the lower half and a faint rim.
    const shade = ctx.createRadialGradient(cx - r * 0.25, cy - r * 0.35, r * 0.2, cx, cy, r);
    shade.addColorStop(0, 'rgba(255,255,255,.08)');
    shade.addColorStop(1, 'rgba(5,46,22,.22)');
    ctx.fillStyle = shade;
    ctx.fill();
    ctx.strokeStyle = 'rgba(5,46,22,.35)';
    ctx.lineWidth = Math.max(1, size * 0.006);
    ctx.stroke();

    // Face.
    const ink = 'rgb(6,40,22)';
    const blink = t % 4.2 < 0.13 ? 0.15 : 1;
    const lookX = thinking ? r * 0.08 : Math.sin(t * 0.5) * r * 0.03;
    const lookY = thinking ? -r * 0.08 : mode === 'listening' ? -r * 0.02 : 0;
    const eyeY = cy - r * 0.08 + lookY;
    const eyeDx = r * 0.3;
    if (mode === 'happy') {
      ctx.strokeStyle = ink;
      ctx.lineWidth = r * 0.07;
      ctx.lineCap = 'round';
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(cx + side * eyeDx + lookX, eyeY + r * 0.04, r * 0.1, 1.15 * Math.PI, 1.85 * Math.PI);
        ctx.stroke();
      }
    } else {
      const ew = r * (mode === 'listening' ? 0.17 : 0.15);
      const eh = r * (mode === 'listening' ? 0.24 : 0.21) * blink;
      for (const side of [-1, 1]) {
        const x = cx + side * eyeDx + lookX;
        ctx.beginPath();
        ctx.ellipse(x, eyeY, ew / 2, eh / 2, 0, 0, Math.PI * 2);
        ctx.fillStyle = ink;
        ctx.fill();
        if (blink === 1) {
          ctx.beginPath();
          ctx.arc(x + ew * 0.16, eyeY - eh * 0.2, ew * 0.16, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,255,255,.85)';
          ctx.fill();
        }
      }
    }

    // Cheeks.
    ctx.fillStyle = 'rgba(244,114,182,.22)';
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(cx + side * r * 0.52 + lookX, cy + r * 0.16 + lookY, r * 0.11, r * 0.065, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // Mouth.
    const my = cy + r * 0.24 + lookY;
    ctx.strokeStyle = ink;
    ctx.fillStyle = ink;
    ctx.lineCap = 'round';
    ctx.lineWidth = r * 0.055;
    if (mode === 'speaking') {
      const open = 0.35 + 0.65 * Math.abs(Math.sin(t * 7));
      ctx.beginPath();
      ctx.ellipse(cx + lookX, my, r * 0.1, r * 0.075 * open + r * 0.02, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (mode === 'happy') {
      ctx.beginPath();
      ctx.arc(cx + lookX, my - r * 0.06, r * 0.16, 0.12 * Math.PI, 0.88 * Math.PI);
      ctx.stroke();
    } else if (thinking) {
      ctx.beginPath();
      ctx.moveTo(cx + lookX - r * 0.07, my);
      ctx.lineTo(cx + lookX + r * 0.07, my);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(cx + lookX, my - r * 0.05, r * 0.1, 0.18 * Math.PI, 0.82 * Math.PI);
      ctx.stroke();
    }

    // Thinking: three small dots above the head, rising one after another.
    if (thinking) {
      for (let i = 0; i < 3; i += 1) {
        const k = (Math.sin(t * 3 - i * 0.9) + 1) / 2;
        ctx.beginPath();
        ctx.arc(cx + (i - 1) * size * 0.05, cy - r - size * 0.05 - k * size * 0.015, size * 0.012, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(134,239,172,${0.35 + k * 0.5})`;
        ctx.fill();
      }
    }
  }

  function start(el) {
    if (el.__orb) return;
    el.__orb = true;
    const size = Number(el.dataset.size) || el.width;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    el.width = size * dpr;
    el.height = size * dpr;
    const ctx = el.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    const st = { t0: performance.now() };
    const still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const frame = (now) => {
      if (!el.isConnected) return;
      draw(el, ctx, size, st, now);
      if (!still) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  C.startOrbs = function startOrbs() {
    for (const el of document.querySelectorAll('canvas[data-orb]')) start(el);
  };
})();
