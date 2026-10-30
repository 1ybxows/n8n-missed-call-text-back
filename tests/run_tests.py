#!/usr/bin/env python3
"""Runs the 20 made-up scenarios offline and writes TESTS.md.

How it works (Python standard library only; Node is needed to run the workflows' JavaScript):
  - a mock server (tests/mock_server.py) stands in for the SMS sender, Slack and the jobs sheet
  - tools/mini-runner.mjs executes the real workflow files in workflows/ against that mock server
  - each scenario sends made-up calls and texts, sets a pretend clock, then checks what the mock server received

Usage: python3 tests/run_tests.py            all scenarios, rewrites TESTS.md
       python3 tests/run_tests.py --only S09  one scenario, prints only
"""
import argparse
import json
import platform
import shutil
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).parent))
import mock_server  # noqa: E402
from scenarios import BIZ, SCENARIOS  # noqa: E402

RUNNER = ROOT / "tools" / "mini-runner.mjs"
WORKFLOW = {"call": ROOT / "workflows" / "1-missed-call.json", "reply": ROOT / "workflows" / "2-customer-reply.json"}


class World:
    def __init__(self, sid, base):
        self.base = base
        self.dir = ROOT / "tests" / "out" / sid
        shutil.rmtree(self.dir, ignore_errors=True)
        (self.dir / "files").mkdir(parents=True)
        mock_server.STATE.reset(self.dir / "files")
        self.config = {"mockBaseUrl": base, "slackWebhookUrl": base + "/slack"}
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

    def set_config(self, **kv):
        for key, value in kv.items():
            self.config[key] = self.base + value if value.startswith("/") else value

    def _run(self, kind, payload, at):
        cmd = ["node", str(RUNNER), "--workflow", str(WORKFLOW[kind]), "--payload", json.dumps(payload), "--now", at,
               "--state", str(self.dir / "state"), "--workflows-dir", str(ROOT / "workflows")]
        for key, value in self.config.items():
            cmd += ["--config", f"{key}={value}"]
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if p.returncode != 0:
            raise RuntimeError(f"runner crashed: {p.stderr[-400:]}")
        result = json.loads(p.stdout.strip().splitlines()[-1])
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
            return f"answered (HTTP {r.status}), but this harness does not use it"
    except Exception:
        return "not running"


def node_version():
    return subprocess.run(["node", "--version"], capture_output=True, text=True).stdout.strip()


def write_tests_md(results, env):
    passed = sum(r["ok"] for r in results)
    checks_ok = sum(c for r in results for _, c in r["checks"])
    checks_all = sum(len(r["checks"]) for r in results)
    L = ["# Test results", "",
         f"**{passed} of {len(results)} scenarios passed ({checks_ok} of {checks_all} checks).**", "",
         "Everything here ran on made-up calls and messages (fictional 555-01xx numbers, invented addresses). "
         "It has not yet run on a live phone number.", "",
         "## How these were run", "",
         "- A small mock server (`tests/mock_server.py`) stands in for Twilio, Slack and the jobs sheet.",
         "- `tools/mini-runner.mjs` is a small engine that executes the three real workflow files in `workflows/` "
         "(Code nodes, IF conditions, expressions, retries, the error workflow) against that mock server. **It is not n8n.**",
         f"- n8n at 127.0.0.1:5678 was **{env['n8n']}** on the build machine, so these workflows were **not run inside n8n**. "
         "The node types and versions in the files were checked against n8n 2.44.7 (see README, \"Checked against n8n\").",
         "- Each scenario sets a pretend clock, so \"24 hours later\" costs nothing.", "",
         f"Run: {env['when']} | Python {env['python']} | Node {env['node']}", "",
         "## Results", "", "| # | Scenario | What it proves | Checks | Result |", "|---|---|---|---|---|"]
    for r in results:
        ok = sum(c for _, c in r["checks"])
        L.append(f"| {r['id']} | {r['title']} | {r['proves']} | {ok}/{len(r['checks'])} | {'PASS' if r['ok'] else '**FAIL**'} |")
    L += ["", "## Every check", ""]
    for r in results:
        L.append(f"### {r['id']} {r['title']}")
        L += [f"- {'PASS' if c else 'FAIL'}: {d}" for d, c in r["checks"]]
        L.append("")
    L += ["## Sample output", "", "### Urgent job card posted to Slack (scenario S09, gas smell)", "", "```json", r_sample(results, "S09", "card"), "```", "",
          "### Failure alert posted to Slack and written to the log (scenario S13, SMS sender down)", "", "```json", r_sample(results, "S13", "alert_slack"), "```", "",
          "```", r_sample(results, "S13", "alert_log"), "```", "",
          "### Jobs sheet written by scenario S20 (jobs.csv)", "", "```", r_sample(results, "S20", "csv"), "```", ""]
    (ROOT / "TESTS.md").write_text("\n".join(L), encoding="utf-8")


def r_sample(results, sid, key):
    for r in results:
        if r["id"] == sid:
            return r["samples"].get(key, "(not captured)")
    return "(scenario not run)"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8099)
    ap.add_argument("--only")
    args = ap.parse_args()
    mock_server.start(args.port)
    base = f"http://127.0.0.1:{args.port}"
    results = []
    for sid, title, proves, fn in SCENARIOS:
        if args.only and args.only.upper() != sid:
            continue
        w = World(sid, base)
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
        print(f"{'PASS' if ok else 'FAIL'}  {sid}  {title}  ({sum(c for _, c in w.checks)}/{len(w.checks)} checks)")
        for d, c in w.checks:
            if not c:
                print(f"        failed check: {d}")
    passed = sum(r["ok"] for r in results)
    print(f"\n{passed} of {len(results)} scenarios passed")
    if not args.only:
        env = {"when": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"), "python": platform.python_version(), "node": node_version(), "n8n": n8n_status()}
        write_tests_md(results, env)
        print("wrote TESTS.md")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
