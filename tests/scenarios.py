"""The 20 made-up scenarios. Every phone number is fictional (555-01xx), every address is invented.
Each scenario is a function that drives the workflows through `w` (see run_tests.py) and records checks with w.check().
"""
import json
from datetime import datetime, timedelta

from mock_server import FAIL_ALWAYS, FAIL_ONCE

BIZ = "+12145550100"
WINTER = "2027-01-12T10:15:00-06:00"        # Tuesday 10:15 in Dallas, winter
AUTUMN = "2026-10-30T10:15:00-05:00"        # Friday 10:15, not a winter month
NIGHT = "2027-01-12T22:15:00-06:00"         # Tuesday 22:15, office closed
SUNDAY = "2027-01-17T10:15:00-06:00"


def C(n):
    return f"+1214555{n:04d}"


def later(iso, hours):
    return (datetime.fromisoformat(iso) + timedelta(hours=hours)).isoformat()


PHRASE = "Sorry we missed your call. Reply with your address and the problem, and a technician will call you back."
SCENARIOS = []


def scenario(title, proves):
    def deco(fn):
        SCENARIOS.append((fn.__name__.upper(), title, proves, fn))
        return fn
    return deco


def header(msg):
    return msg["blocks"][0]["text"]["text"]


def buttons(msg):
    return [b["text"]["text"] for blk in msg["blocks"] if blk["type"] == "actions" for b in blk["elements"]]


def button_styles(msg):
    return {b["text"]["text"]: b.get("style") for blk in msg["blocks"] if blk["type"] == "actions" for b in blk["elements"]}


def blob(x):
    return json.dumps(x, ensure_ascii=False)


@scenario("Missed call, in hours: instant text", "the caller gets the agreed text, nothing else happens")
def s01(w):
    r = w.call(C(101), WINTER)
    w.check("workflow finished without error", r["ok"])
    w.check("phone system got HTTP 200 with empty TwiML", r["response"] == {"code": 200, "body": "<Response></Response>"})
    w.check("exactly 1 text was sent", len(w.sms) == 1)
    sms = w.sms[0]
    w.check("text goes to the caller, from the business number", sms["to"] == C(101) and sms["from"] == BIZ)
    w.check("text contains the agreed sentence", PHRASE in sms["body"])
    w.check("no alert, no job card, no sheet row", not w.alerts and not w.cards and not w.rows)


@scenario("Missed call, then a full reply: job card", "Slack card with Assign and Call back, sheet row, confirmation text")
def s02(w):
    w.call(C(102), WINTER)
    r = w.reply(C(102), "123 Oak Lane, Dallas TX 75201 - my kitchen faucet is leaking under the sink", later(WINTER, 0.1))
    w.check("reply workflow finished without error", r["ok"])
    w.check("1 job card in Slack", len(w.cards) == 1)
    card = w.cards[0]
    w.check("card says New job and Leak / plumbing", "New job" in header(card) and "Leak / plumbing" in header(card))
    w.check("card has the buttons Assign and Call back", buttons(card) == ["Assign", "Call back"])
    w.check("card shows the address with city, state and ZIP", "123 Oak Lane, Dallas, TX 75201" in blob(card))
    w.check("1 sheet row: problem leak, ZIP 75201, Normal, status New", len(w.rows) == 1 and w.rows[0]["problem_type"] == "leak" and w.rows[0]["zip"] == "75201" and w.rows[0]["priority"] == "Normal" and w.rows[0]["status"] == "New")
    w.check("2 texts in total: missed-call text, then confirmation with the job id", len(w.sms) == 2 and w.rows[0]["job_id"] in w.sms[1]["body"])
    w.check("no alert", not w.alerts)


@scenario("Missed call, caller never replies (a late reply still works)", "silence creates no job card and no alert; a reply 30 hours later is still handled")
def s03(w):
    w.call(C(103), WINTER)
    w.check("after the call: 1 text, no card, no row, no alert", len(w.sms) == 1 and not w.cards and not w.rows and not w.alerts)
    w.reply(C(103), "Sorry, only saw this now. 9 Birch Drive, Plano TX 75074, garage door is stuck", later(WINTER, 30))
    w.check("30 hours later the reply still becomes 1 job card (garage door)", len(w.cards) == 1 and w.rows[0]["problem_type"] == "garage door")


@scenario("Same caller rings 3 times within 24 hours", "only the first call is texted; repeats are logged, not texted")
def s04(w):
    for hrs in (0, 2, 5):
        w.call(C(104), later(WINTER, hrs))
    w.check("only 1 text for 3 calls", len(w.sms) == 1)
    dup = [e for e in w.events if e.startswith("duplicate call")]
    w.check("2 'duplicate call' lines in the log", len(dup) == 2)
    w.check("no alert", not w.alerts)


@scenario("Same caller rings again after 25 hours", "the 24-hour window expires and the caller is texted again")
def s05(w):
    w.call(C(105), WINTER)
    w.call(C(105), later(WINTER, 25))
    w.check("2 texts (one per window)", len(w.sms) == 2)
    w.check("no duplicate line in the log", not w.events)


@scenario("After-hours calls", "closed-hours wording, flag from the phone system or worked out from Config hours")
def s06(w):
    w.call(C(106), NIGHT, hours=False)
    b = w.sms[-1]["body"]
    w.check("flag says closed: text says closed, promises the morning, mentions 911", "closed right now" in b and "first thing in the morning" in b and "911" in b)
    w.call(C(116), NIGHT, hours=None)
    w.check("no flag at 22:15: worked out as after hours", "closed right now" in w.sms[-1]["body"])
    w.call(C(126), WINTER, hours=None)
    w.check("no flag, Tuesday 10:15: normal in-hours text", PHRASE in w.sms[-1]["body"])
    w.call(C(136), SUNDAY, hours=None)
    w.check("no flag, Sunday: after hours", "closed right now" in w.sms[-1]["body"])
    w.check("4 texts, no alert", len(w.sms) == 4 and not w.alerts)


@scenario("Invalid phone numbers", "nothing is texted, and the failure is loud: Slack alert + log line with the execution id")
def s07(w):
    r1 = w.call(C(107), WINTER, frm="anonymous")
    w.check("blocked caller id: run failed on purpose", not r1["ok"] and r1["error"]["node"] == "Reject Invalid Call")
    w.check("phone system still got HTTP 200", r1["response"]["code"] == 200)
    w.check("error workflow ran", r1["errorWorkflow"] and r1["errorWorkflow"]["ok"])
    w.check("Slack alert names execution %s" % r1["executionId"], any(r1["executionId"] in blob(m) and "Automation failed" in m["text"] for m in w.slack))
    w.check("log line names execution %s" % r1["executionId"], any(f"execution={r1['executionId']} " in l for l in w.alerts))
    r2 = w.call(C(117), WINTER, frm="12345")
    w.check("too-short number: also rejected and alerted", not r2["ok"] and len(w.alerts) == 2)
    r3 = w.reply(None, "my heater is broken", WINTER, frm="not-a-number")
    w.check("customer reply from a bad number: rejected and alerted", not r3["ok"] and r3["error"]["node"] == "Reject Unreadable Reply" and len(w.alerts) == 3)
    w.check("no text sent, no job card", not w.sms and not w.cards)


@scenario("Call that was answered", "a completed call is ignored: no text, no alert")
def s08(w):
    r = w.call(C(108), WINTER, status="completed")
    w.check("run finished without error", r["ok"])
    w.check("no text, no alert", not w.sms and not w.alerts)
    w.check("'ignored' line in the log", any(e.startswith("ignored:") for e in w.events))


@scenario("Gas smell (urgent)", "urgent card on top, safety words in the text, works in any season")
def s09(w):
    w.call(C(109), AUTUMN)
    w.reply(C(109), "Help I smell gas in my kitchen, 77 Maple Ave Plano TX 75074", later(AUTUMN, 0.05))
    card = w.cards[0]
    w.check("card header is URGENT", "URGENT" in header(card))
    w.check("card says why: gas smell", "gas smell" in blob(card))
    w.check("Call back button is red (danger)", button_styles(card)["Call back"] == "danger")
    w.check("sheet row priority URGENT, urgency 'gas smell'", w.rows[0]["priority"] == "URGENT" and w.rows[0]["urgency"] == "gas smell")
    body = w.sms[-1]["body"]
    w.check("customer is told to leave the building and call 911", "leave the building" in body and "911" in body)
    w.check("a gas smell is not filed as a 'leak' job", w.rows[0]["problem_type"] == "other")


@scenario("Reply without an address", "no card yet; the customer is asked for the address")
def s10(w):
    w.call(C(110), AUTUMN)
    r = w.reply(C(110), "My AC is not working, please help", later(AUTUMN, 0.1))
    w.check("run finished without error", r["ok"])
    w.check("no job card, no sheet row", not w.cards and not w.rows)
    w.check("2nd text asks for the street address and ZIP", len(w.sms) == 2 and "street address" in w.sms[1]["body"])
    w.check("no alert", not w.alerts)


@scenario("Address arrives in a second message", "the two messages are merged into one job card")
def s11(w):
    w.call(C(111), AUTUMN)
    w.reply(C(111), "My AC is not working, please help", later(AUTUMN, 0.1))
    w.reply(C(111), "4521 Elm Street, Dallas TX 75201", later(AUTUMN, 0.2))
    w.check("exactly 1 job card", len(w.cards) == 1)
    w.check("problem type 'no cool' came from the first message, address from the second", w.rows[0]["problem_type"] == "no cool" and "4521 Elm Street" in w.rows[0]["address"])
    w.check("both messages are on the card", "AC is not working" in w.rows[0]["message"] and "4521 Elm Street" in w.rows[0]["message"])
    w.check("3 texts: missed call, ask, confirmation", len(w.sms) == 3 and "job" in w.sms[2]["body"])


@scenario("Spanish reply", "problem and address understood, card marked Spanish, answer in Spanish")
def s12(w):
    w.call(C(112), WINTER)
    w.reply(C(112), "Hola, necesito ayuda. No tengo calefacción en 4521 Elm Street, Dallas TX 75201", later(WINTER, 0.1))
    card = w.cards[0]
    w.check("problem type no heat; winter, so URGENT", w.rows[0]["problem_type"] == "no heat" and w.rows[0]["priority"] == "URGENT")
    w.check("card marked Spanish", w.rows[0]["language"] == "es" and "Spanish" in blob(card))
    w.check("confirmation text is in Spanish", "URGENTE" in w.sms[-1]["body"] and "técnico" in w.sms[-1]["body"])


@scenario("SMS sender is down (every attempt fails)", "retry once, then the alert fires with the execution id; nobody is told it worked")
def s13(w):
    r = w.call(FAIL_ALWAYS, WINTER)
    w.check("run failed at the sender step", not r["ok"] and r["error"]["node"] == "Send SMS (mock)")
    w.check("the sender was tried twice (retry)", w.sms_attempts.get(FAIL_ALWAYS) == 2)
    w.check("no text delivered", not w.sms)
    w.check("Slack alert has execution id %s and the failed step" % r["executionId"], any(r["executionId"] in blob(m) and "Send SMS (mock)" in blob(m) for m in w.slack))
    w.check("log line has execution id", any(f"execution={r['executionId']} " in l and "Send SMS (mock)" in l for l in w.alerts))
    r2 = w.call(FAIL_ALWAYS, later(WINTER, 1))
    w.check("a failed send does not count as 'texted': the next call tries again (and alerts again)", not r2["ok"] and len(w.alerts) == 2)


@scenario("SMS sender hiccups once", "the retry saves it: text delivered, no alert")
def s14(w):
    r = w.call(FAIL_ONCE, WINTER)
    w.check("run finished without error", r["ok"])
    w.check("sender was tried twice, 1 text delivered", w.sms_attempts.get(FAIL_ONCE) == 2 and len(w.sms) == 1)
    w.check("no alert", not w.alerts)


@scenario("Customer texts again after the job card", "no second job card inside 24 hours")
def s15(w):
    w.call(C(115), WINTER)
    w.reply(C(115), "3 Cedar Way, Dallas TX 75201, power is out in half the house", later(WINTER, 0.1))
    r = w.reply(C(115), "Any update?", later(WINTER, 1))
    w.check("run finished without error", r["ok"])
    w.check("still 1 card and 1 sheet row", len(w.cards) == 1 and len(w.rows) == 1)
    w.check("'duplicate reply' line in the log", any(e.startswith("duplicate reply") for e in w.events))
    w.check("2 texts only (missed call, confirmation): the repeat gets no new text", len(w.sms) == 2)


@scenario("No heat in winter", "marked URGENT (January)")
def s16(w):
    w.reply(C(116), "No heat at 910 Pine Ridge Rd, Dallas TX 75201", WINTER)
    w.check("URGENT because of 'no heat in winter'", "URGENT" in header(w.cards[0]) and w.rows[0]["urgency"] == "no heat in winter")


@scenario("No heat outside winter", "same message in October is a normal job")
def s17(w):
    w.reply(C(117), "No heat at 910 Pine Ridge Rd, Dallas TX 75201", AUTUMN)
    w.check("normal priority, not urgent", "New job" in header(w.cards[0]) and w.rows[0]["priority"] == "Normal" and w.rows[0]["problem_type"] == "no heat")


@scenario("Flooding", "urgent, filed as leak, water-valve advice sent")
def s18(w):
    w.reply(C(118), "Water is everywhere, burst pipe! 5 Cedar Court Plano TX 75074", AUTUMN)
    w.check("URGENT, flooding, type leak", w.rows[0]["priority"] == "URGENT" and "flooding" in w.rows[0]["urgency"] and w.rows[0]["problem_type"] == "leak")
    w.check("customer is told to shut off the main water valve", "main water valve" in w.sms[-1]["body"])


@scenario("Slack is down", "the job still reaches the sheet; the alert is written to the log even though Slack cannot take it")
def s19(w):
    w.set_config(slackWebhookUrl="/slack-down")
    w.call(C(119), WINTER)
    r = w.reply(C(119), "12 Birch Drive, Dallas TX 75201, outlet sparks when I plug anything in", later(WINTER, 0.1))
    w.check("run failed at the Slack step", not r["ok"] and r["error"]["node"] == "Post to Slack")
    w.check("the sheet row had already been written", len(w.rows) == 1)
    w.check("error workflow ran to the end", r["errorWorkflow"] and r["errorWorkflow"]["ok"])
    w.check("log line with execution id exists (Slack could not take the alert)", any(f"execution={r['executionId']} " in l and "Post to Slack" in l for l in w.alerts))
    w.check("Slack was tried for the card (2x) and for the alert (1x)", w.slack_down_hits == 3)


@scenario("All six problem types", "the keyword rules: no heat, no cool, leak, garage door, electrical, other")
def s20(w):
    cases = [
        ("No heat. 12 Oak Lane", "no heat"),
        ("AC not cooling at 14 Elm Street", "no cool"),
        ("Water leaking from the ceiling at 16 Pine Road", "leak"),
        ("Garage door is stuck, 18 Birch Drive", "garage door"),
        ("Outlet in the kitchen is dead, 20 Cedar Way", "electrical"),
        ("Need a quote for something, 22 Maple Avenue", "other"),
    ]
    for i, (text, _) in enumerate(cases):
        w.reply(C(200 + i), text, AUTUMN)
    got = [r["problem_type"] for r in w.rows]
    w.check("types found: %s" % ", ".join(got), got == [t for _, t in cases])
    w.check("6 cards, none urgent, no alert", len(w.cards) == 6 and all(r["priority"] == "Normal" for r in w.rows) and not w.alerts)
