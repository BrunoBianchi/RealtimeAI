"""OpenAI/OpenRouter-compatible streaming endpoint for integration tests."""
import json, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1])
TOKENS = ["- Prazo ", "de **4 ", "semanas**.\n", "Insight: ", "orçamento ", "aprovado.\n", "Ações: demo"]

class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a): pass

    def chunk(self, data: bytes):
        self.wfile.write(f"{len(data):X}\r\n".encode() + data + b"\r\n")
        self.wfile.flush()

    def do_GET(self):
        body = json.dumps({"data": {"label": "test"}}).encode()
        code = 200 if self.headers.get("Authorization") == "Bearer test-key" else 401
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        user = req["messages"][-1]["content"]
        print(f"[fake-openrouter] model={req['model']} stream={req['stream']} reasoning={req.get('reasoning')} "
              f"accept={self.headers.get('Accept')} title={self.headers.get('X-Title')}", flush=True)
        if self.headers.get("Authorization") != "Bearer test-key":
            body = json.dumps({"error": {"code": 401, "message": "No auth credentials found"}}).encode()
            self.send_response(401)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        try:
            self.chunk(b": OPENROUTER PROCESSING\n\n")
            time.sleep(0.25)
            if "ERRO_MEIO" in user:
                self.chunk(b'data: {"choices":[{"delta":{"content":"Comecei"},"finish_reason":null}]}\n\n')
                self.chunk(b'data: {"id":"x","object":"chat.completion.chunk","error":{"code":502,"message":"Provider disconnected"},"choices":[{"delta":{"content":""},"finish_reason":"error"}]}\n\n')
            else:
                slow = "LENTO" in user
                toks = TOKENS * (8 if slow else 1)
                for t in toks:
                    payload = json.dumps({"choices": [{"delta": {"content": t}, "finish_reason": None}]})
                    data = f"data: {payload}\n\n".encode()
                    # Split some events across chunks to exercise the SSE parser.
                    self.chunk(data[:7]); self.chunk(data[7:])
                    time.sleep(0.2 if slow else 0.03)
                self.chunk(b'data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"total_tokens":42}}\n\n')
                self.chunk(b"data: [DONE]\n\n")
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            print("[fake-openrouter] client aborted the stream", flush=True)

ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
