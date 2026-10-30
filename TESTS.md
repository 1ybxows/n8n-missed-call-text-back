# Test results

**20 of 20 scenarios passed (78 of 78 checks).**

Everything here ran on made-up calls and messages (fictional 555-01xx numbers, invented addresses). It has not yet run on a live phone number.

## How these were run

- A small mock server (`tests/mock_server.py`) stands in for Twilio, Slack and the jobs sheet.
- `tools/mini-runner.mjs` is a small engine that executes the three real workflow files in `workflows/` (Code nodes, IF conditions, expressions, retries, the error workflow) against that mock server. **It is not n8n.**
- n8n at 127.0.0.1:5678 was **not running** on the build machine, so these workflows were **not run inside n8n**. The node types and versions in the files were checked against n8n 2.44.7 (see README, "Checked against n8n").
- Each scenario sets a pretend clock, so "24 hours later" costs nothing.

Run: 2026-10-29 23:57 UTC | Python 3.14.5 | Node v25.9.0

## Results

| # | Scenario | What it proves | Checks | Result |
|---|---|---|---|---|
| S01 | Missed call, in hours: instant text | the caller gets the agreed text, nothing else happens | 6/6 | PASS |
| S02 | Missed call, then a full reply: job card | Slack card with Assign and Call back, sheet row, confirmation text | 8/8 | PASS |
| S03 | Missed call, caller never replies (a late reply still works) | silence creates no job card and no alert; a reply 30 hours later is still handled | 2/2 | PASS |
| S04 | Same caller rings 3 times within 24 hours | only the first call is texted; repeats are logged, not texted | 3/3 | PASS |
| S05 | Same caller rings again after 25 hours | the 24-hour window expires and the caller is texted again | 2/2 | PASS |
| S06 | After-hours calls | closed-hours wording, flag from the phone system or worked out from Config hours | 5/5 | PASS |
| S07 | Invalid phone numbers | nothing is texted, and the failure is loud: Slack alert + log line with the execution id | 8/8 | PASS |
| S08 | Call that was answered | a completed call is ignored: no text, no alert | 3/3 | PASS |
| S09 | Gas smell (urgent) | urgent card on top, safety words in the text, works in any season | 6/6 | PASS |
| S10 | Reply without an address | no card yet; the customer is asked for the address | 4/4 | PASS |
| S11 | Address arrives in a second message | the two messages are merged into one job card | 4/4 | PASS |
| S12 | Spanish reply | problem and address understood, card marked Spanish, answer in Spanish | 3/3 | PASS |
| S13 | SMS sender is down (every attempt fails) | retry once, then the alert fires with the execution id; nobody is told it worked | 6/6 | PASS |
| S14 | SMS sender hiccups once | the retry saves it: text delivered, no alert | 3/3 | PASS |
| S15 | Customer texts again after the job card | no second job card inside 24 hours | 4/4 | PASS |
| S16 | No heat in winter | marked URGENT (January) | 1/1 | PASS |
| S17 | No heat outside winter | same message in October is a normal job | 1/1 | PASS |
| S18 | Flooding | urgent, filed as leak, water-valve advice sent | 2/2 | PASS |
| S19 | Slack is down | the job still reaches the sheet; the alert is written to the log even though Slack cannot take it | 5/5 | PASS |
| S20 | All six problem types | the keyword rules: no heat, no cool, leak, garage door, electrical, other | 2/2 | PASS |

## Every check

### S01 Missed call, in hours: instant text
- PASS: workflow finished without error
- PASS: phone system got HTTP 200 with empty TwiML
- PASS: exactly 1 text was sent
- PASS: text goes to the caller, from the business number
- PASS: text contains the agreed sentence
- PASS: no alert, no job card, no sheet row

### S02 Missed call, then a full reply: job card
- PASS: reply workflow finished without error
- PASS: 1 job card in Slack
- PASS: card says New job and Leak / plumbing
- PASS: card has the buttons Assign and Call back
- PASS: card shows the address with city, state and ZIP
- PASS: 1 sheet row: problem leak, ZIP 75201, Normal, status New
- PASS: 2 texts in total: missed-call text, then confirmation with the job id
- PASS: no alert

### S03 Missed call, caller never replies (a late reply still works)
- PASS: after the call: 1 text, no card, no row, no alert
- PASS: 30 hours later the reply still becomes 1 job card (garage door)

### S04 Same caller rings 3 times within 24 hours
- PASS: only 1 text for 3 calls
- PASS: 2 'duplicate call' lines in the log
- PASS: no alert

### S05 Same caller rings again after 25 hours
- PASS: 2 texts (one per window)
- PASS: no duplicate line in the log

### S06 After-hours calls
- PASS: flag says closed: text says closed, promises the morning, mentions 911
- PASS: no flag at 22:15: worked out as after hours
- PASS: no flag, Tuesday 10:15: normal in-hours text
- PASS: no flag, Sunday: after hours
- PASS: 4 texts, no alert

### S07 Invalid phone numbers
- PASS: blocked caller id: run failed on purpose
- PASS: phone system still got HTTP 200
- PASS: error workflow ran
- PASS: Slack alert names execution 1001
- PASS: log line names execution 1001
- PASS: too-short number: also rejected and alerted
- PASS: customer reply from a bad number: rejected and alerted
- PASS: no text sent, no job card

### S08 Call that was answered
- PASS: run finished without error
- PASS: no text, no alert
- PASS: 'ignored' line in the log

### S09 Gas smell (urgent)
- PASS: card header is URGENT
- PASS: card says why: gas smell
- PASS: Call back button is red (danger)
- PASS: sheet row priority URGENT, urgency 'gas smell'
- PASS: customer is told to leave the building and call 911
- PASS: a gas smell is not filed as a 'leak' job

### S10 Reply without an address
- PASS: run finished without error
- PASS: no job card, no sheet row
- PASS: 2nd text asks for the street address and ZIP
- PASS: no alert

### S11 Address arrives in a second message
- PASS: exactly 1 job card
- PASS: problem type 'no cool' came from the first message, address from the second
- PASS: both messages are on the card
- PASS: 3 texts: missed call, ask, confirmation

### S12 Spanish reply
- PASS: problem type no heat; winter, so URGENT
- PASS: card marked Spanish
- PASS: confirmation text is in Spanish

### S13 SMS sender is down (every attempt fails)
- PASS: run failed at the sender step
- PASS: the sender was tried twice (retry)
- PASS: no text delivered
- PASS: Slack alert has execution id 1001 and the failed step
- PASS: log line has execution id
- PASS: a failed send does not count as 'texted': the next call tries again (and alerts again)

### S14 SMS sender hiccups once
- PASS: run finished without error
- PASS: sender was tried twice, 1 text delivered
- PASS: no alert

### S15 Customer texts again after the job card
- PASS: run finished without error
- PASS: still 1 card and 1 sheet row
- PASS: 'duplicate reply' line in the log
- PASS: 2 texts only (missed call, confirmation): the repeat gets no new text

### S16 No heat in winter
- PASS: URGENT because of 'no heat in winter'

### S17 No heat outside winter
- PASS: normal priority, not urgent

### S18 Flooding
- PASS: URGENT, flooding, type leak
- PASS: customer is told to shut off the main water valve

### S19 Slack is down
- PASS: run failed at the Slack step
- PASS: the sheet row had already been written
- PASS: error workflow ran to the end
- PASS: log line with execution id exists (Slack could not take the alert)
- PASS: Slack was tried for the card (2x) and for the alert (1x)

### S20 All six problem types
- PASS: types found: no heat, no cool, leak, garage door, electrical, other
- PASS: 6 cards, none urgent, no alert

## Sample output

### Urgent job card posted to Slack (scenario S09, gas smell)

```json
{
  "text": "🚨 URGENT: Gas smell | 77 Maple Ave, Plano, TX 75074 | +12145550109",
  "blocks": [
    {
      "type": "header",
      "text": {
        "type": "plain_text",
        "text": "🚨 URGENT - Gas smell",
        "emoji": true
      }
    },
    {
      "type": "section",
      "fields": [
        {
          "type": "mrkdwn",
          "text": "*Customer*\n+12145550109"
        },
        {
          "type": "mrkdwn",
          "text": "*Job*\nJ-20261030-001"
        },
        {
          "type": "mrkdwn",
          "text": "*Address*\n77 Maple Ave, Plano, TX 75074"
        },
        {
          "type": "mrkdwn",
          "text": "*ZIP*\n75074"
        }
      ]
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*Why urgent:* gas smell. Call this customer first."
      }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "> Help I smell gas in my kitchen, 77 Maple Ave Plano TX 75074"
      }
    },
    {
      "type": "context",
      "elements": [
        {
          "type": "mrkdwn",
          "text": "Language: English | Received 2026-10-30T15:18:00.000Z"
        }
      ]
    },
    {
      "type": "actions",
      "block_id": "job_J-20261030-001",
      "elements": [
        {
          "type": "button",
          "text": {
            "type": "plain_text",
            "text": "Assign"
          },
          "style": "primary",
          "action_id": "assign_job",
          "value": "J-20261030-001"
        },
        {
          "type": "button",
          "text": {
            "type": "plain_text",
            "text": "Call back"
          },
          "style": "danger",
          "action_id": "call_back",
          "value": "+12145550109"
        }
      ]
    }
  ]
}
```

### Failure alert posted to Slack and written to the log (scenario S13, SMS sender down)

```json
{
  "text": "⚠️ Automation failed: HSD 1 - Missed call to instant text (execution 1001)",
  "blocks": [
    {
      "type": "header",
      "text": {
        "type": "plain_text",
        "text": "⚠️ Automation failed",
        "emoji": true
      }
    },
    {
      "type": "section",
      "fields": [
        {
          "type": "mrkdwn",
          "text": "*Workflow*\nHSD 1 - Missed call to instant text"
        },
        {
          "type": "mrkdwn",
          "text": "*Failed step*\nSend SMS (mock)"
        },
        {
          "type": "mrkdwn",
          "text": "*Execution ID*\n1001"
        },
        {
          "type": "mrkdwn",
          "text": "*Time*\n2027-01-12T16:15:00.000Z"
        }
      ]
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*What went wrong*\nRequest failed with status code 500 ({\"error\": \"carrier unavailable\"})"
      }
    },
    {
      "type": "context",
      "elements": [
        {
          "type": "mrkdwn",
          "text": "The customer may not have been texted. <http://127.0.0.1:5678/workflow/hsdMissedCall01/executions/1001|Open this run in n8n>"
        }
      ]
    }
  ]
}
```

```
2027-01-12T16:15:00.000Z ALERT workflow="HSD 1 - Missed call to instant text" step="Send SMS (mock)" execution=1001 error="Request failed with status code 500 ({"error": "carrier unavailable"})"
```

### Jobs sheet written by scenario S20 (jobs.csv)

```
job_id,created_at,status,priority,phone,address,zip,problem_type,urgency,language,message
J-20261030-001,2026-10-30T15:15:00.000Z,New,Normal,+12145550200,12 Oak Lane,,no heat,,en,No heat. 12 Oak Lane
J-20261030-002,2026-10-30T15:15:00.000Z,New,Normal,+12145550201,14 Elm Street,,no cool,,en,AC not cooling at 14 Elm Street
J-20261030-003,2026-10-30T15:15:00.000Z,New,Normal,+12145550202,16 Pine Road,,leak,,en,Water leaking from the ceiling at 16 Pine Road
J-20261030-004,2026-10-30T15:15:00.000Z,New,Normal,+12145550203,18 Birch Drive,,garage door,,en,"Garage door is stuck, 18 Birch Drive"
J-20261030-005,2026-10-30T15:15:00.000Z,New,Normal,+12145550204,20 Cedar Way,,electrical,,en,"Outlet in the kitchen is dead, 20 Cedar Way"
J-20261030-006,2026-10-30T15:15:00.000Z,New,Normal,+12145550205,22 Maple Avenue,,other,,en,"Need a quote for something, 22 Maple Avenue"
```
