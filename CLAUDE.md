# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

RealTimeAI is a Windows real-time interview/meeting copilot: a native C++20 engine with a Direct2D HUD (`src/`) plus an Electron dashboard (`apps/dashboard/`). Docs and UI copy are in Portuguese (pt-BR); keep user-facing strings in Portuguese.

## Commands

Root (`package.json`):

| Command | Purpose |
|---|---|
| `npm run setup` | install root + dashboard deps |
| `npm run dev` | run the dashboard from source (`apps/dashboard`, `npm start`) |
| `npm run build:native` | `cmake --preset windows-release` + build |
| `npm run test:native` | `ctest --preset windows-release` |
| `npm test` | script tests (`scripts/tests/*.test.mjs`) + dashboard tests |
| `npm run build:css` | rebuild `apps/dashboard/src/renderer/styles.css` |
| `npm run check:secrets` / `npm run flags:validate` | secret scan / validate `apps/dashboard/flags.json` |

Windows helper scripts (`scripts/windows/`): `setup-dev.bat` (once), `dev.bat` (incremental native build + dashboard from source; `--skip` to skip rebuild), `build.bat`, `package.bat` (NSIS installer into `dist/`), `run-demo.bat` (HUD with a scripted conversation, no API keys).

CMake presets: `windows-release` (default, hybrid RAG with ONNX), `windows-debug`, `windows-lean` (no ONNX Runtime), `linux` and `linux-tsan` (core library + tests only; `rtai_core` has no `<windows.h>`).

Single tests:
- Dashboard: `node --test apps/dashboard/tests/<name>.test.js` (from `apps/dashboard`: `node --test tests/<name>.test.js`).
- Native: `ctest --preset windows-release -R <regex>` or run the binary directly with `--gtest_filter=Suite.Name` (`core_tests`, `net_tests`, `overlay_tests`, `deepgram_tests` — the last needs `DEEPGRAM_API_KEY`).

`styles.css` is generated: edit `apps/dashboard/src/renderer/tailwind.input.css` (plain CSS design tokens; built through the Tailwind CLI wrapper `scripts/run-tailwind-css.mjs`) and run `build:css`.

## Commits

Conventional Commits enforced by commitlint (husky `commit-msg` hook); release-please/semantic-release derive versions from them. Allowed scopes are in `commitlint.config.mjs` (e.g. `core`, `engine`, `audio`, `stt`, `llm`, `rag`, `overlay`, `app`, `dashboard`, `ui`, `updater`, `flags`, `calendar`, `build`, `ci`, `scripts`, `tests`). `main` is always releasable; pushes to `beta` publish prereleases.


## Architecture

### Native engine (`src/`, one CMake library per folder)
- `core/` — all logic, platform-free and unit-tested: `CopilotEngine` (single thread owns state: turns, trigger policy, context), Deepgram stream protocol/backoff/reconnect, VAD, prompt building, SSE/LLM parsing, RAG (BM25 + optional e5 embeddings fused by RRF), `SessionStore`, and `server_protocol.hpp`.
- `net/` (WinHTTP WebSocket/HTTPS), `deepgram/`, `audio_wasapi/` (mic = "Você", loopback = "Outros"), `overlay/` (Win32 + Direct2D HUD), `vad_onnx/` and `embed_onnx/` (optional ONNX), `app/` (the `rtai_app` executable: wiring, config, lifecycle).
- Threading rule: producers only push into queues; the UI thread never blocks (one coalesced render per ≤16 ms). One writer thread per socket.
- Every session writes `sessions/<YYYY-MM-DD_HH-MM-SS_xxxx>.jsonl` (append-only events: `session_start`, `turn`, `suggestion`, `jev`, `feedback`, `pause`, `link`, `notice`, `session_end`) plus a `.md` summary on exit, under `%LOCALAPPDATA%\RealTimeAI\`.

### Engine ↔ dashboard contract
The dashboard spawns `rtai_app.exe --no-launcher --server [--agent <id>] [--demo]` and talks JSON lines:
- stdout (engine → UI): `hello`, `status`, `live`, `turn`, `answer_start/delta/done`, `notice`, `pause`, `level`, `mode`, `summary` (field `export`), `open_settings`, `bye`.
- stdin (UI → engine): `answer`, `chat`, `recap`, `followup`, `pause`, `rate`, `clear_chat`, `set_mode`, `set_config`, `quit`.
Both sides are defined in `src/core/include/rtai/server_protocol.hpp`; `apps/dashboard/src/main/main.js` (`launchOverlay`, `LIVE_EVENT_TYPES`, `sendOverlayCommand`) forwards events to the renderer as `rtai:live-event`. Change both ends together.

### Shared state on disk (`%LOCALAPPDATA%\RealTimeAI\`)
- `config.ini` — shared by dashboard and engine; Portuguese section/key names (`[deepgram] idioma`, `[llm] modelo`, `[stealth] invisivel_gravacao`…). The dashboard maps them to English keys in `readConfigIni()` / `writeConfigIni()` in `main.js`; add new settings in both. The engine reads config only at start, so `rtai:save-config` restarts a running overlay.
- `agents/<id>.json` — a "goal"/session (company, role, job description, documents with extracted text, playbook, mini_compact). `saveAgentToDisk()` normalizes and **drops unknown fields** — new agent fields must be added there.
- `question_bank.json` (JEV engine, `jev_engine.js`), `dashboard_profile.json`, `playbooks.json`, flags files.

### Dashboard (`apps/dashboard/`)
- `src/main/main.js` — IPC handlers (`rtai:*`), overlay process control, config/agent/session persistence, tray, meeting detection, Google Calendar (`google_calendar.js`), updater (`updater.js`, electron-updater on GitHub releases, stable/beta), feature flags (`feature_flags.js`).
- `src/preload/preload.js` — the only renderer API (`window.rtai`).
- `src/renderer/` — no framework. `app.js` holds state (`Cue.state`), hash router (`#/home`, `#/sessions[/past]`, `#/session/<id>`, `#/review/<sessionId>`, `#/files`, `#/questions`, `#/live`, `#/settings/<tab>`), shell rendering and event delegation (`data-action` / `data-change` / `data-input` → `Cue.actions/changes/inputs`). Views register on `window.Cue` from `views.js`, `live.js`, `settings.js`, `modals.js`; icons are inline SVG in `icons.js`. Views render from real data only; missing values show "—".
- Window is frameless: the top bar is the drag region and hosts the `data-win` controls.
- Tests in `apps/dashboard/tests/` mix main-process logic tests with tests that grep the renderer source for specific IDs/strings; after renderer changes, update the latter rather than reintroducing old markup.
