"""Dev log sink: the PS5 app POSTs its diag lines here (text/plain).
Usage: python3 logsink.py <port> <logfile>"""
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG = sys.argv[2]


class Sink(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        # /blob?mb=N: N megabytes of zeros, for measuring LAN download speed.
        mb = 8
        if "mb=" in self.path:
            mb = max(1, min(64, int(self.path.split("mb=")[1].split("&")[0])))
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(mb << 20))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        chunk = bytes(1 << 20)
        for _ in range(mb):
            self.wfile.write(chunk)

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(min(n, 1 << 20)).decode("utf-8", "replace")
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(body.rstrip("\n") + "\n")
        self.send_response(204)
        self._cors()
        self.end_headers()

    def log_message(self, *args):
        pass


ThreadingHTTPServer(("0.0.0.0", int(sys.argv[1])), Sink).serve_forever()
