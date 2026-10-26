# Overlay Win32/Direct2D integration — manual verification checklist (task 22)

Task 22 verifies the HUD's Win32/Direct2D behaviour. Part of it is automated in
`test_overlay_win32.cpp` (and the Req 13.4 static guard in
`no_spinner_check.cmake`); the rest needs a **live interactive desktop**, the
**real Direct2D renderer**, an **actual capture source**, a **screen-share
consumer**, and **frame-level timing instrumentation**, so it is verified by
hand with the running app (`run-live.bat`).

Each item lists the requirement, how to reproduce it, and the pass condition.

## Automated vs manual at a glance

| Area | Req | Where |
| --- | --- | --- |
| WS_EX_NOACTIVATE / TOOLWINDOW / LAYERED styles | 10.1, 11.2, 14.2 | automated |
| WM_MOUSEACTIVATE → MA_NOACTIVATE | 10.2 | automated |
| Foreground unchanged on click | 10.3 | automated (+ manual confirm in a real call) |
| Focus restore ≤ 100 ms | 10.5 | automated (budget) (+ manual confirm) |
| Taskbar / Alt+Tab exclusion | 11.2, 11.3 | automated (style) (+ manual confirm) |
| Capture exclusion applied / degrades | 11.1, 11.5, 11.4 | automated (+ manual screen-share confirm) |
| No rotating spinner | 13.4 | automated (static guard) |
| Render coalescing ≤ 60 fps | 6.3 | **manual** |
| Ease-out line expansion ~150 ms | 6.4 | **manual** |
| Global hotkeys fire without focus | 12.1–12.7 | **manual** |
| Panic toggle ≤ 50 ms | 12.8, 12.9 | **manual** |
| Per-pixel alpha composition | 14.2 | **manual** |
| IDWriteTextLayout cache reuse | 14.4 | **manual** |
| Styles/affinity unchanged on mode switch | 9.6 | automated (before/after on the passive window) (+ manual confirm) |
| Finalize → dashboard rendered ≤ ~300 ms | 9.5 | automated (engine path, mocked net) + **manual** (live visual) |

## Manual steps

### M1 — Zero-focus-steal in a real call (Req 10.3, 10.5)
1. Join any video call (or open Notepad as the foreground app) and keep it in
   front.
2. Click each HUD button (Responder, Tela, Chat, menu, feedback).
3. **Pass:** the call/Notepad stays in the foreground (title bar stays active);
   the webcam/mic are not interrupted.
4. Open the chat field, type, press Enter/Esc.
5. **Pass:** keyboard focus returns to the previous app within ~100 ms (you can
   immediately type into it).

### M2 — Anti-capture invisibility (Req 11.1, 11.3)
1. Start a screen share (Teams/Zoom/Meet "share entire screen") or OBS display
   capture.
2. **Pass:** the HUD is absent from the shared/captured image while remaining
   visible on your own screen.
3. Check the taskbar and press Alt+Tab.
4. **Pass:** the HUD never appears in the taskbar or the Alt+Tab switcher.
   - On Windows older than 10 2004 the app shows a Warning notice and the HUD
     stays usable (Req 11.4) — note it here if that path is hit.

### M3 — Global hotkeys without focus (Req 12.1–12.7)
1. Keep another app focused the whole time.
2. Press Alt+Space / Ctrl+Space (immediate answer), Alt+Up/Down (history),
   Alt+1/2/3 (quick actions).
3. **Pass:** each hotkey acts on the HUD without the focused app losing focus;
   an empty buffer on immediate-answer shows an Info notice; end-of-history
   shows an Info notice.

### M4 — Panic toggle ≤ 50 ms (Req 12.8, 12.9)
1. Press Alt+H.
2. **Pass:** the HUD vanishes (opacity 0 or an 8×8 dot) effectively instantly
   (≤ 50 ms — no perceptible delay).
3. Press Alt+H again.
4. **Pass:** the HUD restores its previous opacity and size just as fast.

### M5 — Streaming without jitter (Req 6.3, 6.4)
1. Trigger an answer and watch it stream in.
2. **Pass:** text does not flicker/jump per token; only whole words appear; the
   card grows one line at a time with a smooth ~150 ms ease-out, not a jump.
3. (Optional) capture the window at high FPS and confirm repaints coalesce to
   ≤ ~60 fps (≥ ~16 ms between frames) during a token burst.

### M6 — Per-pixel alpha composition (Req 14.2)
1. Move the HUD over a bright area and a dark area of the desktop.
2. **Pass:** rounded corners and soft edges stay correct over both backgrounds
   (no single chroma-key color box, no hard rectangle); glyph edges keep their
   outline/shadow and read clearly on both (contrast is comfortable).

### M7 — Layout cache reuse (Req 14.4)
1. Let an answer finish so its text stops changing, then let the pulse/shimmer
   animations keep running (60 fps repaints) without changing the text.
2. **Pass:** the HUD stays smooth and CPU stays low while idle-animating — the
   text layout is reused across frames, not rebuilt. If a layout build ever
   fails, the previous frame is preserved and an error is logged (Req 14.5).

### M8 — Finalize → dashboard within ~300 ms and styles unchanged (Req 9.5, 9.6)
Task 10.3. The automatable slices are covered in code and need only a visual
confirmation with the live renderer:
- the **engine path** (finalize → `OverlayModeEvent{PostInterviewReport}`
  published) with the Cold_Path network mocked is measured in
  `tests/core_tests/test_finalize_timing.cpp` (`FinalizeTiming.*`): the engine
  adds no artificial delay and leaves ample room inside the ~300 ms budget;
- the **window-style preservation** on the mode switch is measured in
  `test_overlay_win32.cpp` (`OverlayWin32.StylesUnchangedOnModeSwitch`): it
  captures `GetWindowLong(GWL_EXSTYLE)` + `GetWindowDisplayAffinity` before and
  after a `PostInterviewReport` switch on the passive window and asserts both
  are byte-for-byte identical.

Manual confirmation with the running app (`run-live.bat`):
1. Run a short mock/live interview so the transcript has a few turns, then press
   the Finalize button/hotkey.
2. **Pass (Req 9.5):** the three Score_Rings + the 3-line Instant_Feedback
   appear and begin their 0→θ sweep within ~300 ms of pressing Finalize (no
   perceptible stall between the click and the dashboard showing up). On any
   Cold_Path failure/timeout the overlay stays in LiveCopilot and no partial
   dashboard flashes.
3. While the dashboard is visible, start a screen share (as in M2) and press
   Alt+Tab / check the taskbar.
4. **Pass (Req 9.6):** the dashboard is still absent from the shared image and
   still out of the taskbar/Alt+Tab — i.e. the capture exclusion and the passive
   window styles carried over unchanged from LiveCopilot to the dashboard; the
   call/foreground app is never activated by the switch.

## Running the automated portion

```powershell
# configure + build (Visual Studio generator already set up in build/)
cmake --build build --config Release --target overlay_tests
# the Req 13.4 static guard runs as part of the build (overlay_no_spinner_check)

# run the Win32 suite (self-skips if no interactive desktop)
build\bin\Release\overlay_tests.exe
# or via ctest
ctest --test-dir build -C Release -R "OverlayWin32|overlay_no_spinner_check" --output-on-failure
```
