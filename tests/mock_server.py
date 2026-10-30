"""Mock services for the offline tests (Python standard library only).

What it stands in for, and what it writes under tests/out/<scenario>/:
  POST /sms         the SMS sender          -> sms-log.jsonl   (a real Twilio call in production)
  POST /slack       a Slack incoming webhook -> slack-log.jsonl (the client's Slack URL in production)
  (Slack down: the tests set STATE.slack_down, then /slack answers HTTP 500)
  POST /sheet       the jobs sheet           -> jobs.csv        (a Google Sheet in production)
  POST /log         event and alert log lines -> events.log, alerts.log

Failure switches for the tests (by destination phone number):
  FAIL_ALWAYS  every SMS to this number gets HTTP 500 (carrier outage)
  FAIL_ONCE    the first SMS to this number gets HTTP 500, the retry works
"""
import csv
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

FAIL_ALWAYS = "+12145550199"
FAIL_ONCE = "+12145550198"
CSV_COLUMNS = ["job_id", "created_at", "status", "priority", "phone", "address", "zip", "problem_type", "urgency", "language", "message"]


class State:
    def __init__(self):
        self.lock = threading.Lock()
        self.outdir = None
        self.reset(None)

    def reset(self, outdir):
        with self.lock:
            self.outdir = Path(outdir) if outdir else None
            self.sms, self.sms_attempts, self.slack, self.slack_down_hits = [], {}, [], 0
            self.slack_down = False
            self.rows, self.events, self.alerts = [], [], []
            if self.outdir:
                self.outdir.mkdir(parents=True, exist_ok=True)
                for f in self.outdir.iterdir():
                    f.unlink()

    def append(self, name, text):
        if self.outdir:
            with open(self.outdir / name, "a", encoding="utf-8") as f:
                f.write(text)


STATE = State()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # keep the test output quiet
        pass

    def _reply(self, code, payload):
        data = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        try:
            body = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            return self._reply(400, {"error": "body is not JSON"})
        s = STATE
        with s.lock:
            if self.path == "/sms":
                to = body.get("to")
                n = s.sms_attempts[to] = s.sms_attempts.get(to, 0) + 1
                if to == FAIL_ALWAYS or (to == FAIL_ONCE and n == 1):
                    return self._reply(500, {"error": "carrier unavailable"})
                body["sid"] = f"SMmock{len(s.sms) + 1:04d}"
                s.sms.append(body)
                s.append("sms-log.jsonl", json.dumps(body) + "\n")
                return self._reply(201, {"sid": body["sid"], "status": "queued"})
            if self.path == "/slack":
                if s.slack_down:
                    s.slack_down_hits += 1
                    return self._reply(500, {"error": "slack is down"})
                s.slack.append(body)
                s.append("slack-log.jsonl", json.dumps(body) + "\n")
                return self._reply(200, {"ok": True})
            if self.path == "/sheet":
                row = {c: body["row"].get(c, "") for c in CSV_COLUMNS}
                s.rows.append(row)
                if s.outdir:
                    new = not (s.outdir / "jobs.csv").exists()
                    with open(s.outdir / "jobs.csv", "a", newline="", encoding="utf-8") as f:
                        w = csv.DictWriter(f, fieldnames=CSV_COLUMNS)
                        if new:
                            w.writeheader()
                        w.writerow(row)
                return self._reply(200, {"ok": True})
            if self.path == "/log":
                (s.alerts if body.get("kind") == "alert" else s.events).append(body["line"])
                s.append("alerts.log" if body.get("kind") == "alert" else "events.log", body["line"] + "\n")
                return self._reply(200, {"ok": True})
        self._reply(404, {"error": f"no such mock endpoint {self.path}"})


def start(port):
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


if __name__ == "__main__":  # run by hand: python3 tests/mock_server.py 8099
    import sys
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8099
    STATE.reset(Path(__file__).parent / "out" / "manual")
    start(port)
    print(f"mock server on http://127.0.0.1:{port}, files in tests/out/manual (Ctrl+C to stop)")
    threading.Event().wait()
