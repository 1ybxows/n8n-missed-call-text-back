#!/usr/bin/env python3
"""Runs the 20 made-up scenarios and writes TESTS.md (offline) or TESTS-LIVE.md (real n8n).

Offline (default): tools/mini-runner.mjs executes the workflow files against a mock server. No n8n needed.
Live (--live): the same scenarios are sent to the production webhooks of a LOCAL n8n (127.0.0.1:5678) where the workflows are
imported and active (bash tests/live-n8n.sh up). n8n's HTTP Request nodes call the same mock server. Nothing leaves this Mac.

Usage: python3 tests/run_tests.py                  all scenarios offline, rewrites TESTS.md
       python3 tests/run_tests.py --only S09       one scenario, prints only
       python3 tests/run_tests.py --prepare-live   writes the import copies (test clock on) to tests/out/live-workflows/
       python3 tests/run_tests.py --live           all scenarios against the local n8n, rewrites TESTS-LIVE.md
Python standard library only; Node is needed for the offline engine.
"""
import argparse
import json
import platform
import re
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).parent))
import mock_server  # noqa: E402
from scenarios import BIZ, SCENARIOS  # noqa: E402

RUNNER = ROOT / "tools" / "mini-runner.mjs"
WORKFLOW = {"call": ROOT / "workflows" / "1-missed-call.json", "reply": ROOT / "workflows" / "2-customer-reply.json"}
DONE = ("success", "error", "crashed", "canceled")


class Offline:
    live = False

    def __init__(self, base):
        self.base = base

    def start_scenario(self, w):
        pass

    def run(self, w, kind, payload, at):
        cmd = ["node", str(RUNNER), "--workflow", str(WORKFLOW[kind]), "--payload", json.dumps(payload), "--now", at,
               "--state", str(w.dir / "state"), "--workflows-dir", str(ROOT / "workflows"),
               "--config", f"mockBaseUrl={self.base}", "--config", f"slackWebhookUrl={self.base}/slack", "--config", "allowTestClock=true"]
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if p.returncode != 0:
            raise RuntimeError(f"runner crashed: {p.stderr[-400:]}")
        return json.loads(p.stdout.strip().splitlines()[-1])


class Live:
    """A real n8n on this Mac. Needs the three workflows imported and active (tests/live-n8n.sh up)."""
    live = True
    HOOK = {"call": "hsd/missed-call", "reply": "hsd/customer-reply"}
    WF_ID = {"call": "hsdMissedCall01", "reply": "hsdCustomerReply01"}
    ERROR_WF = "hsdErrorAlert01"

    def __init__(self, url, db):
        self.url, self.db = url.rstrip("/"), str(Path(db).expanduser())

    def _rows(self, after):
        con = sqlite3.connect(f"file:{self.db}?mode=ro", uri=True, timeout=10)
        try:
            return con.execute("select id, workflowId, status from execution_entity where id > ? order by id", (after,)).fetchall()
        finally:
            con.close()

    def _last_id(self):
        con = sqlite3.connect(f"file:{self.db}?mode=ro", uri=True, timeout=10)
        try:
            return con.execute("select coalesce(max(id), 0) from execution_entity").fetchone()[0]
        finally:
            con.close()

    def start_scenario(self, w):
        """Forget the 24 h memory (n8n workflow static data) so every scenario starts clean."""
        try:
            con = sqlite3.connect(self.db, timeout=10)
            con.execute("update workflow_entity set staticData = NULL where id in (?, ?)", (self.WF_ID["call"], self.WF_ID["reply"]))
            con.commit()
            con.close()
        except sqlite3.Error as e:
            print(f"   warning: could not reset the 24 h memory: {e}")

    def version(self):
        try:
            with urllib.request.urlopen(self.url + "/rest/settings", timeout=5) as r:
                return json.load(r)["data"]["versionCli"]
        except Exception:  # not available without a login: use the file that live-n8n.sh writes next to the data folder
            f = Path(self.db).parent.parent / "n8n.version"
            return f.read_text().strip() if f.exists() else "unknown"

    def run(self, w, kind, payload, at):
        before = self._last_id()
        for _ in range(40):  # right after n8n starts its webhooks may not be registered yet (404 "Cannot POST"): wait and retry
            req = urllib.request.Request(f"{self.url}/webhook/{self.HOOK[kind]}", data=json.dumps(payload).encode(),
                                         headers={"Content-Type": "application/json"}, method="POST")
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    resp = {"code": r.status, "body": r.read().decode()}
            except urllib.error.HTTPError as e:
                resp = {"code": e.code, "body": e.read().decode()[:200]}
            if not (resp["code"] == 404 and "Cannot POST" in resp["body"]):
                break
            time.sleep(1)
        wf_id, main, deadline = self.WF_ID[kind], None, time.time() + 60
        while time.time() < deadline:
            main = next((r for r in self._rows(before) if r[1] == wf_id), None)
            if main and main[2] in DONE:
                break
            time.sleep(0.15)
        if not main or main[2] not in DONE:
            raise RuntimeError(f"no finished execution of {wf_id} (webhook answered {resp}); is the workflow active?")
        ok, err, step, message = main[2] == "success", None, None, None
        if not ok:
            deadline = time.time() + 30
            while time.time() < deadline:
                err = next((r for r in self._rows(main[0]) if r[1] == self.ERROR_WF), None)
                if err and err[2] in DONE:
                    break
                time.sleep(0.15)
            for line in mock_server.STATE.alerts:
                m = re.search(r'step="([^"]*)" execution=(\d+) error="(.*)"$', line)
                if m and int(m.group(2)) == main[0]:
                    step, message = m.group(1), m.group(3)
        return {"workflow": wf_id, "executionId": str(main[0]), "ok": ok, "error": None if ok else {"node": step, "message": message},
                "nodesRun": [], "response": resp,
                "errorWorkflow": {"executionId": str(err[0]), "ok": err[2] == "success"} if err else None}


class World:
    def __init__(self, sid, backend):
        self.backend = backend
        self.dir = ROOT / "tests" / "out" / (sid + ("-live" if backend.live else ""))
        shutil.rmtree(self.dir, ignore_errors=True)
        (self.dir / "files").mkdir(parents=True)
        mock_server.STATE.reset(self.dir / "files")
        backend.start_scenario(self)
        self.checks, self.runs = [], []

    # what the pretend outside world received
    sms = property(lambda self: list(mock_server.STATE.sms))
    slack = property(lambda self: list(mock_server.STATE.slack))
    rows = property(lambda self: list(mock_server.STATE.rows))
    events = property(lambda self: list(mock_server.STATE.events))
    alerts = property(lambda self: list(mock_server.STATE.alerts))
    sms_attempts = property(lambda self: dict(mock_server.STATE.sms_attempts))
    slack_down_hits = property(lambda self: mock_server.STATE.slack_down_hits)
    cards = property(lambda self: [m for m in self.slack if "Automation failed" not in m.get("text", "")])

    def check(self, description, condition):
        self.checks.append((description, bool(condition)))

    def slack_down(self):
        mock_server.STATE.slack_down = True

    def _run(self, kind, payload, at):
        payload["TestNow"] = at  # the pretend clock; the workflows honour it only when Config.allowTestClock is true
        result = self.backend.run(self, kind, payload, at)
        self.runs.append(result)
        return result

    def call(self, number, at, hours=True, status="no-answer", frm=None):
        payload = {"From": frm if frm is not None else number, "To": BIZ, "CallStatus": status, "CallSid": f"CA{len(self.runs) + 1:04d}"}
        if hours is not None:
            payload["BusinessHours"] = hours
        return self._run("call", payload, at)

    def reply(self, number, text, at, frm=None):
        payload = {"From": frm if frm is not None else number, "To": BIZ, "Body": text, "MessageSid": f"SM{len(self.runs) + 1:04d}"}
        return self._run("reply", payload, at)


def n8n_status():
    try:
        with urllib.request.urlopen("http://127.0.0.1:5678/healthz", timeout=2) as r:
            return f"answered (HTTP {r.status})"
    except Exception:
        return "not running"


def prepare_live():
    """Copies of the three workflow files with the test clock switched on, for importing into the local n8n."""
    out = ROOT / "tests" / "out" / "live-workflows"
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    for f in sorted((ROOT / "workflows").glob("*.json")):
        wf = json.loads(f.read_text(encoding="utf-8"))
        for n in wf["nodes"]:
            if n["name"] == "Config":
                for a in n["parameters"]["assignments"]["assignments"]:
                    if a["name"] == "allowTestClock":
                        a["value"] = True
        (out / f.name).write_text(json.dumps(wf, indent=2) + "\n", encoding="utf-8")
    print(f"wrote import copies (test clock on) to {out}")


def sample(results, sid, key):
    return next((r["samples"].get(key, "(not captured)") for r in results if r["id"] == sid), "(scenario not run)")


def write_report(results, env, live):
    passed = sum(r["ok"] for r in results)
    checks_ok = sum(c for r in results for _, c in r["checks"])
    checks_all = sum(len(r["checks"]) for r in results)
    L = ["# Test results" + (" in real n8n" if live else " (offline)"), "",
         f"**{passed} of {len(results)} scenarios passed ({checks_ok} of {checks_all} checks).**", "",
         "Everything here ran on made-up calls and messages (fictional 555-01xx numbers, invented addresses). "
         "It has not yet run on a live phone number.", "", "## How these were run", ""]
    if live:
        L += [f"- **Real n8n {env['n8n_version']}**, running locally on 127.0.0.1:5678. The three workflow files were imported and published (all three: n8n 2.x only calls a published error workflow); "
              "every scenario was sent to the production webhooks (`/webhook/hsd/missed-call`, `/webhook/hsd/customer-reply`) and the test "
              "waited until n8n had finished each execution (read from n8n's own execution list).",
              "- n8n's HTTP Request nodes called the local mock server (`tests/mock_server.py`), which stands in for Twilio, Slack and the jobs sheet. "
              "Nothing left this Mac. The Twilio and Google Sheets nodes stayed turned off, no credentials.",
              "- The imported copies differ from `workflows/*.json` in one value: `Config.allowTestClock` is `true`, so each scenario can send a pretend "
              "clock (`TestNow`) and \"24 hours later\" costs nothing. In the committed files it is `false` and the field is ignored.",
              "- Between scenarios the 24-hour memory of both workflows is cleared directly in n8n's database."]
    else:
        L += ["- A small mock server (`tests/mock_server.py`) stands in for Twilio, Slack and the jobs sheet.",
              "- `tools/mini-runner.mjs` is a small engine that executes the three real workflow files in `workflows/` "
              "(Code nodes, IF conditions, expressions, retries, the error workflow) against that mock server. **It is not n8n.**",
              "- The same scenarios were also run in a real n8n: see [TESTS-LIVE.md](TESTS-LIVE.md).",
              "- Each scenario sets a pretend clock, so \"24 hours later\" costs nothing."]
    L += ["", f"Run: {env['when']} | Python {env['python']} | Node {env['node']}" + (f" | n8n {env['n8n_version']}" if live else ""), "",
          "## Results", "", "| # | Scenario | What it proves | Checks | Result |", "|---|---|---|---|---|"]
    for r in results:
        ok = sum(c for _, c in r["checks"])
        L.append(f"| {r['id']} | {r['title']} | {r['proves']} | {ok}/{len(r['checks'])} | {'PASS' if r['ok'] else '**FAIL**'} |")
    L += ["", "## Every check", ""]
    for r in results:
        L.append(f"### {r['id']} {r['title']}")
        L += [f"- {'PASS' if c else 'FAIL'}: {d}" for d, c in r["checks"]]
        L.append("")
    L += ["## Sample output", "", "### Urgent job card posted to Slack (scenario S09, gas smell)", "", "```json", sample(results, "S09", "card"), "```", "",
          "### Failure alert posted to Slack and written to the log (scenario S13, SMS sender down)", "", "```json", sample(results, "S13", "alert_slack"), "```", "",
          "```", sample(results, "S13", "alert_log"), "```", "",
          "### Jobs sheet written by scenario S20 (jobs.csv)", "", "```", sample(results, "S20", "csv"), "```", ""]
    (ROOT / ("TESTS-LIVE.md" if live else "TESTS.md")).write_text("\n".join(L), encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8099)
    ap.add_argument("--only")
    ap.add_argument("--live", action="store_true")
    ap.add_argument("--prepare-live", action="store_true")
    ap.add_argument("--n8n-url", default="http://127.0.0.1:5678")
    ap.add_argument("--n8n-db", default="~/Tools/n8n/data/.n8n/database.sqlite")
    args = ap.parse_args()
    if args.prepare_live:
        prepare_live()
        return 0
    mock_server.start(args.port)
    backend = Live(args.n8n_url, args.n8n_db) if args.live else Offline(f"http://127.0.0.1:{args.port}")
    results = []
    for sid, title, proves, fn in SCENARIOS:
        if args.only and args.only.upper() != sid:
            continue
        w = World(sid, backend)
        try:
            fn(w)
        except Exception as e:  # a crash is a failure, not a skip
            w.checks.append((f"scenario crashed: {type(e).__name__}: {e}", False))
        ok = all(c for _, c in w.checks)
        csv_file = w.dir / "files" / "jobs.csv"
        alerts_slack = [m for m in w.slack if "Automation failed" in m.get("text", "")]
        samples = {
            "card": json.dumps(w.cards[0], indent=2, ensure_ascii=False) if w.cards else "(none)",
            "alert_slack": json.dumps(alerts_slack[0], indent=2, ensure_ascii=False) if alerts_slack else "(none)",
            "alert_log": w.alerts[0] if w.alerts else "(none)",
            "csv": csv_file.read_text(encoding="utf-8").strip() if csv_file.exists() else "(none)",
        }
        results.append({"id": sid, "title": title, "proves": proves, "checks": w.checks, "ok": ok, "samples": samples})
        print(f"{'PASS' if ok else 'FAIL'}  {sid}  {title}  ({sum(c for _, c in w.checks)}/{len(w.checks)} checks)", flush=True)
        for d, c in w.checks:
            if not c:
                print(f"        failed check: {d}")
    passed = sum(r["ok"] for r in results)
    print(f"\n{passed} of {len(results)} scenarios passed" + (" (real n8n)" if args.live else " (offline)"))
    if not args.only:
        env = {"when": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"), "python": platform.python_version(),
               "node": subprocess.run(["node", "--version"], capture_output=True, text=True).stdout.strip(),
               "n8n_version": backend.version() if args.live else None}
        write_report(results, env, args.live)
        print("wrote " + ("TESTS-LIVE.md" if args.live else "TESTS.md"))
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
