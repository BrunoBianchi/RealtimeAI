"""Minimal Deepgram-like WebSocket server for integration tests.
Mimics: idle timeout (no audio/KeepAlive for 10 s -> close 1011 NET-0001),
Results for audio, from_finalize on Finalize, Metadata + close on CloseStream.
Optional abrupt TCP drop of the first connection after DROP_AT seconds."""
import asyncio, json, sys, time
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

PORT = int(sys.argv[1])
DROP_AT = float(sys.argv[2]) if len(sys.argv) > 2 else 0.0
STATS_FILE = sys.argv[3] if len(sys.argv) > 3 else "stats.json"
IDLE_TIMEOUT = 10.0
T0 = time.monotonic()
stats = {"connections": 0, "keepalives": 0, "finalizes": 0, "closestreams": 0,
         "audio_bytes": 0, "net0001_closes": 0, "drops": 0, "bad_auth": 0, "events": []}

def log(msg):
    line = f"[server {time.monotonic() - T0:6.2f}s] {msg}"
    stats["events"].append(line)
    print(line, flush=True)

def dump():
    with open(STATS_FILE, "w") as f:
        json.dump(stats, f, indent=1)

async def handler(ws):
    stats["connections"] += 1
    cid = stats["connections"]
    auth = ws.request.headers.get("Authorization")
    log(f"conn {cid} open path={ws.request.path[:60]}... auth={auth!r}")
    if auth != "Token test-key":
        stats["bad_auth"] += 1
    last = [time.monotonic()]
    audio_since = [0]

    async def idle_watchdog():
        while True:
            await asyncio.sleep(0.2)
            if time.monotonic() - last[0] > IDLE_TIMEOUT:
                stats["net0001_closes"] += 1
                log(f"conn {cid}: 10 s without audio/KeepAlive -> close 1011 NET-0001")
                await ws.close(1011, "NET-0001")
                return

    async def dropper():
        await asyncio.sleep(DROP_AT)
        stats["drops"] += 1
        log(f"conn {cid}: simulating network drop (TCP abort)")
        ws.transport.abort()

    tasks = [asyncio.create_task(idle_watchdog())]
    if DROP_AT > 0 and cid == 1:
        tasks.append(asyncio.create_task(dropper()))
    try:
        async for msg in ws:
            last[0] = time.monotonic()
            if isinstance(msg, (bytes, bytearray)):
                stats["audio_bytes"] += len(msg)
                audio_since[0] += len(msg)
                if audio_since[0] >= 16000:
                    audio_since[0] = 0
                    await ws.send(json.dumps({"type": "Results", "is_final": True, "speech_final": False,
                        "channel": {"alternatives": [{"transcript": f"ola conn{cid}", "confidence": 0.9}]}}))
            else:
                t = json.loads(msg).get("type")
                if t == "KeepAlive":
                    stats["keepalives"] += 1
                elif t == "Finalize":
                    stats["finalizes"] += 1
                    await ws.send(json.dumps({"type": "Results", "is_final": True, "from_finalize": True,
                        "channel": {"alternatives": [{"transcript": f"fim do turno conn{cid}", "confidence": 0.9}]}}))
                elif t == "CloseStream":
                    stats["closestreams"] += 1
                    log(f"conn {cid}: CloseStream -> Metadata + close 1000")
                    await ws.send(json.dumps({"type": "Metadata", "request_id": f"fake-{cid}"}))
                    await ws.close(1000, "")
                    break
    except ConnectionClosed as e:
        log(f"conn {cid}: closed ({e.rcvd.code if e.rcvd else 'no close frame'})")
    finally:
        for t in tasks:
            t.cancel()
        dump()

async def main():
    async def periodic():
        while True:
            await asyncio.sleep(1)
            dump()
    async with serve(handler, "127.0.0.1", PORT, ping_interval=None):
        log(f"listening on {PORT}, drop_at={DROP_AT}")
        await periodic()

asyncio.run(main())
