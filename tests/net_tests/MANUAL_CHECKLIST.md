# Direct HTTP/2 transport — manual verification checklist (task 10.2)

Task 10.2 verifies the Dual-Path Hot_Path **direct HTTP/2 transport**
(`src/net/src/winhttp_llm_client.cpp`). Part of it is automated in
`test_http2_transport_integration.cpp` (the Req 4.1/4.3 critical-endpoint
static guard, which runs everywhere with no network); the rest needs a **live
network**, a **reachable provider endpoint**, **valid credentials**, and a
**packet/ETW capture tool**, so it is verified by hand against a real socket.

The automated tests self-skip when no live endpoint is provided, so the suite
stays green offline / in headless CI. The live tests opt in via environment
variables; see "Running" below.

Each item lists the requirement, how to reproduce it, and the pass condition.

## Automated vs manual at a glance

| Area | Req | Where |
| --- | --- | --- |
| Critical endpoints resolve to Cerebras/Groq | 4.1 | automated (static guard) |
| Critical endpoints never resolve to `openrouter.ai` | 4.3 | automated (static guard) |
| Endpoint selection / failover (`choose_endpoint`, `is_retryable`) | 4.2 | automated (property tests) |
| Keep-alive timing (`should_ping`, 25 s) | 4.5 | automated (property tests) |
| HTTP/2 is the negotiated wire protocol | 4.4 | **manual** (self-skipping live test) |
| Cancel + reissue reuses the TCP/TLS connection (no new handshake) | 4.6 | **manual** (self-skipping live test) |

## Opt-in environment variables

| Variable | Purpose |
| --- | --- |
| `RTAI_NET_LIVE` | Set to `1`/`true` to enable the live tests at all. Unset = skip. |
| `RTAI_LLM_API_KEY` | Cerebras (or compatible) API key used for the real generation request. |

With neither set, `test_http2_transport_integration.cpp`'s live tests
`GTEST_SKIP()` and only the pure static guard runs.

## Manual steps

### M1 — HTTP/2 is the negotiated protocol (Req 4.4)
1. Start a packet/protocol capture that can report the negotiated ALPN /
   application protocol — e.g. Wireshark (filter `tls.handshake.extensions_alpn_str`
   on the TLS ClientHello/ServerHello) or a Windows ETW trace of
   `Microsoft-Windows-WinHttp`.
2. Run the app (`run-live.bat`) against the Cerebras primary (`api.cerebras.ai`)
   with a valid `RTAI_LLM_API_KEY`, and trigger one live suggestion so a real
   generation request is sent.
3. **Pass:** the ALPN negotiated for the connection to `api.cerebras.ai` is
   `h2` (HTTP/2), not `http/1.1`. The request/response frames are HTTP/2 frames
   (HEADERS/DATA on a stream id), not an HTTP/1 request line.
4. (Fallback) Force a primary failover (e.g. an invalid primary route or a
   forced timeout) and confirm the request to the Groq fallback
   (`api.groq.com`) also negotiates `h2`.

### M2 — Cancel + reissue reuses the connection, no new handshake (Req 4.6)
1. Keep the same capture from M1 running (so TLS handshakes on the connection to
   `api.cerebras.ai` are visible).
2. Trigger a speculative generation, then cause an **abort** before it finishes
   — in the running app this is an `abort_shadow()` (e.g. the turn text diverges
   from the speculative text, or a new speculative turn supersedes it). This
   fires `ILlmCall::cancel()`, which emits a **RST_STREAM** on the in-flight
   stream while leaving the TCP/TLS connection open.
3. Immediately trigger the next generation (the new turn).
4. **Pass — RST_STREAM:** the capture shows an HTTP/2 `RST_STREAM` frame for the
   cancelled stream id (the stream is torn down, not the whole connection).
5. **Pass — connection reuse:** the second generation is sent on the **same**
   connection — there is **no new TCP handshake (SYN/SYN-ACK) and no new TLS 1.3
   handshake** to `api.cerebras.ai`; the new request appears as a fresh HTTP/2
   stream (new stream id) on the existing connection. Equivalently, the second
   request's time-to-first-byte does not include a handshake round-trip.
6. (Keep-alive corroboration, Req 4.5) Leave the session idle > 25 s and confirm
   a lightweight keep-alive ping keeps the same connection warm, so a later
   generation still reuses it with no handshake.

## Running

```powershell
# configure + build (Visual Studio generator already set up in build/)
cmake --build build --config Release --target net_tests

# offline / headless: only the static guard runs; live tests skip cleanly
build\bin\Release\net_tests.exe --gtest_filter=Http2Transport*

# opt in to the live tests (real network + credentials), then run by hand with
# a packet/ETW capture open per M1/M2 above:
$env:RTAI_NET_LIVE = "1"
$env:RTAI_LLM_API_KEY = "<your-cerebras-key>"
build\bin\Release\net_tests.exe --gtest_filter=Http2TransportLive.*

# or via ctest
ctest --test-dir build -C Release -R "Http2Transport" --output-on-failure
```
