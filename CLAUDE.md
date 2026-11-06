# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

lipcue.com is a Windows real-time interview/meeting copilot: a native C++20 engine with a Direct2D HUD (`src/`) plus an Electron dashboard (`apps/dashboard/`). User-facing strings (dashboard, HUD, engine notices and errors) are in English; keep new ones in English. LLM prompts, Portuguese question/filler detection, speaker tags ("Você"/"Outros") and config.ini keys stay in Portuguese on purpose.

The product was called Cue and RealTimeAI before. These old names stay on purpose, because changing them breaks existing installs: `appId` (`com.raiado.realtimeai`), the data folder (`%LOCALAPPDATA%\RealTimeAI`, `%APPDATA%\RealTimeAI`), the DPAPI entropy (`RealTimeAI.config.v1`), the HUD window class and the GitHub repository. The `window.Cue` renderer global and `rtai_*` names are internal. The executable and installer are `lipcue.exe` and `lipcue-Setup-*` (no `.com`, which would read as a double extension).

## Commands

Root (`package.json`):

| Command | Purpose |
|---|---|
| `npm run setup` | install root + dashboard deps |
| `npm run dev` | run the dashboard from source (`apps/dashboard`, `npm start`) |
| `npm run backend` | local lipcue.com server (`../backend/`, Go, run with Docker; see its README). `backend:docker` / `backend:docker:down` run it detached. `npm run dev` uses the built-in server; `RTAI_LOCAL_BACKEND=1` starts and uses this one instead (`local_backend.js`) |
| `npm run test:backend` / `lint:backend` | `go test` / `go vet` for `../backend/` (`scripts/backend-go.mjs`: local Go, else the `golang` Docker image) |
| `npm run build:native` | `cmake --preset windows-release` + build |
| `npm run test:native` | `ctest --preset windows-release` |
| `npm test` | script tests (`scripts/tests/*.test.mjs`) + backend tests + dashboard tests |
| `npm run build:css` | rebuild `apps/dashboard/src/renderer/styles.css` |
| `npm run check:secrets` / `npm run flags:validate` | secret scan / validate `apps/dashboard/flags.json` |

Windows helper scripts (`scripts/windows/`): `setup-dev.bat` (once), `dev.bat` (incremental native build + dashboard from source; `--skip` to skip rebuild), `build.bat`, `package.bat` (NSIS installer into `dist/`).

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

### Latency

Everychange need to work with the smallest latency possible that the application is looking for, we need at least < 200 ms latency 

### Engine ↔ dashboard contract
The dashboard spawns `rtai_app.exe --no-launcher --server [--agent <id>]` and talks JSON lines:
- stdout (engine → UI): `hello`, `status`, `live`, `turn`, `answer_start/delta/done`, `notice`, `pause`, `level`, `mode`, `summary` (field `export`), `open_settings`, `bye`.
- stdin (UI → engine): `answer`, `chat`, `recap`, `followup`, `pause`, `rate`, `clear_chat`, `set_mode`, `set_config`, `quit`.
Both sides are defined in `src/core/include/rtai/server_protocol.hpp`; `apps/dashboard/src/main/main.js` (`launchOverlay`, `LIVE_EVENT_TYPES`, `sendOverlayCommand`) forwards events to the renderer as `rtai:live-event`. Change both ends together.

### Shared state on disk (`%LOCALAPPDATA%\RealTimeAI\`)
- `config.ini` — shared by dashboard and engine; Portuguese section/key names (`[deepgram] idioma`, `[llm] modelo`, `[stealth] invisivel_gravacao`…). The dashboard maps them to English keys in `readConfigIni()` / `writeConfigIni()` in `main.js`; add new settings in both. The engine reads config only at start, so `rtai:save-config` restarts a running overlay.
- `agents/<id>.json` — a "goal"/session (company, role, job description, documents with extracted text, playbook, mini_compact). `saveAgentToDisk()` normalizes and **drops unknown fields** — new agent fields must be added there.
- `question_bank.json` (JEV engine, `jev_engine.js`), `dashboard_profile.json`, `playbooks.json`, flags files.

### lipcue.com cloud backend (`docs/server-api.md`)
- Sign-in (e-mail + password) or local mode is required: otherwise the renderer shows only `auth.js`'s login view (`Cue.isLocked()`, `AUTH_ACTIONS` gate in `app.js`) and `launchOverlay` refuses (`canUseApp()` in `main.js`); the engine answers `hello.needs = "login"`.
- Local mode (`[servidor] modo = local`, "Continue locally" on the login view): no account and no server call at all, the user's own keys only (`cloud::local_mode`, `isLocalMode()` / `Cue.localMode()`). PRO features (cloud backup, sync across devices, Google Calendar) are shown as ads (`Cue.proAd`) and every live answer waits `cloud::kLocalAnswerDelayMs` (`DelayedLlmClient`, mirrored by `LOCAL_ANSWER_DELAY_MS` in `app.js`; keep both in sync and keep the delay disclosed in the UI).
- Plans (`plans.js` ↔ `cloud::PlanRules`): Free = one session of up to 15 min, once; PRO = $19, 200 min and 1 Advanced mock interview/month (`renderer/mock.js`, `main/mock_interview.js`; Basic is a text chat with Orby; Advanced adds voice and consented camera image analysis. Any account may buy mode-specific mock credits); token packs (1 token = 1 live minute, `credit_minutes`, never expire) are spent after the plan's minutes. The server is authoritative (`402` → `needs = "upgrade"`); the engine's plan guard ends the session at the budget.
- `[servidor]` (`modo` auto/nuvem/proprio, `url`, `regiao`, `token`): the engine makes one `POST /v1/session` at start (overlapped with set-up) and gets short-lived STT/LLM credentials; audio still goes straight to Deepgram. `modo = proprio` uses own keys but still needs the session grant (quota).
- Engine: `cloud_session.hpp` (core, tested) + `CloudClient` (`src/net`); dashboard: `cloud_account.js` (sign-in, billing), `plans.js`, `renderer/auth.js`, and the `account`/`plan` settings tabs. Default server URL: CMake preset `RTAI_SERVER_URL` + `BUILTIN_SERVER_URL` (keep both in sync; `http://167.172.147.53` for now).
- `../backend/` — next to this repo, outside git, kept only on the developer's machine (tests skip without it) — local implementation of this API (Go, stdlib `net/http` + `golang.org/x/crypto`/`x/text`, `cmd/server` + `internal/*`, distroless Docker image): accounts, plans (billing answers 503 until a payment provider exists), Deepgram grants, SSE LLM relay (503 without a key: never canned answers), dashboard AI relay, company research, Google Calendar token broker, community question bank, cloud sync (`/v1/sync`). Keep it in step with `docs/server-api.md`. Security rules there: tokens and one-time links are stored as SHA-256 hashes, passwords as argon2id, browser forms go through `http.CrossOriginProtection`, pages use `html/template` with a nonce CSP, and research fetches go through `research.SafeGet` (public addresses only, checked at dial time).
- Cloud sync (`cloud_sync.js`): signed in, `agents/`, the session history and `question_bank.json` are copied to the account (`/v1/sync`, debounced after changes, every 5 min, never during a live session); disk stays the working copy, and `cloud_sync.json` holds the last synced hashes. Free keeps 3 sessions and 5 history entries, PRO has no count limit; both share the storage quota with `/v1/files`.
- Signed in, the dashboard's own AI calls go through `aiTarget()` in `main.js` (server relay; OpenRouter direct only in "My keys" mode with a key); research, Google token exchanges and question sharing use `cloudAccount.api()`. Don't add direct provider calls that need the user's keys.

### Dashboard (`apps/dashboard/`)
- `src/main/main.js` — IPC handlers (`rtai:*`), overlay process control, config/agent/session persistence, tray, meeting detection, Google Calendar (`google_calendar.js`), updater (`updater.js`, electron-updater on GitHub releases, stable/beta), feature flags (`feature_flags.js`).
- `src/preload/preload.js` — the only renderer API (`window.rtai`).
- `src/renderer/` — no framework. `app.js` holds state (`Cue.state`), hash router (`#/home`, `#/sessions[/past]`, `#/session/<id>`, `#/review/<sessionId>`, `#/files`, `#/questions`, `#/live`, `#/settings/<tab>`), shell rendering and event delegation (`data-action` / `data-change` / `data-input` → `Cue.actions/changes/inputs`). Views register on `window.Cue` from `views.js`, `live.js`, `settings.js`, `modals.js`; icons are inline SVG in `icons.js`. Views render from real data only; missing values show "—".
- Window is frameless: the top bar is the drag region and hosts the `data-win` controls.
- Interface language (i18n): English is the source text in the views; `renderer/i18n.js` translates rendered text nodes and `placeholder`/`title`/`aria-label` automatically (MutationObserver) from `renderer/locales/<locale>.js` (exact strings + `{placeholder}` templates; `{n}`/`{d}`/`{total}`/`{used}`/`{limit}` match numbers only). Use `Cue.t('In {n} days', { n })` for text built in code. User content (`textarea`, `pre`, `code`, `.md`, `[data-no-i18n]`) is never translated. The locale is `[sistema] idioma_interface` (`auto` = the Windows display language via `main/ui_locale.js`; dashboard-only, it never restarts the copilot). After adding UI text, run `npm run i18n:check` and add the Portuguese entry (the `tests/i18n.test.js` coverage test fails otherwise). New locale: a catalog file, a `<script>` in `index.html`, and `SUPPORTED` in `ui_locale.js`.
- First run is empty: no starter goal, no sample data and no scripted demo: `rtai:start-overlay` always starts a real session, and test doubles (scripted LLM, fake transport/VAD, WAV source) live only in `tests/support/` (`rtai::test_support`), which `rtai_app` does not link. Never add placeholder or invented content; views show "—" or an empty state.
- Guided tours: `renderer/tour.js` on driver.js (vendored in `renderer/vendor/driver/`, same version as `package.json`; copy `node_modules/driver.js/dist/driver.js.iife.js` + `driver.css` when upgrading). Steps point at `[data-tour]` anchors in the views and `[data-card]` (slug of the English title) on settings cards; `welcome` runs on the first unlocked visit, each page's tour on its first visit, progress in `dashboard_profile.json` `tours_seen`. New UI worth explaining gets a step; `tests/first_run_and_tour.test.js` checks every anchor exists, and tour text goes through the i18n catalogs like any other string.
- Tests in `apps/dashboard/tests/` mix main-process logic tests with tests that grep the renderer source for specific IDs/strings; after renderer changes, update the latter rather than reintroducing old markup.
