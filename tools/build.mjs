// Builds the three n8n workflow files in workflows/ from the Code-node sources in code/.
// Run: node tools/build.mjs     (the workflow files are committed, so you only need this after editing code/)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(path.join(root, 'code', f), 'utf8');
// "//@include shared.js" is replaced by the file's text, because a Code node cannot import local files.
const code = (file) => read(file).replace(/^\/\/@include (.+)$/gm, (_, f) => read(f.trim()).trimEnd());

const uid = (s) => {
  const h = createHash('sha1').update(s).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};
const node = (name, type, typeVersion, position, parameters, extra = {}) => ({
  parameters, id: uid(name), name, type: `n8n-nodes-base.${type}`, typeVersion, position, ...extra,
});

// ---- the one place a client's settings live -------------------------------------------------------------------
const CONFIG_VALUES = [
  ['businessName', 'Summit Home Services', 'string'],
  ['businessTimezone', 'America/Chicago', 'string'],
  ['openHour', 7, 'number'],
  ['closeHour', 19, 'number'],
  ['dedupeHours', 24, 'number'],
  ['winterMonths', '11,12,1,2,3', 'string'],
  ['smsMode', 'mock', 'string'],
  ['mockBaseUrl', 'http://127.0.0.1:8099', 'string'],
  ['slackWebhookUrl', 'http://127.0.0.1:8099/slack', 'string'],
];
const SHEET_COLUMNS = ['job_id', 'created_at', 'status', 'priority', 'phone', 'address', 'zip', 'problem_type', 'urgency', 'language', 'message'];

const config = (pos, keys) => node('Config', 'set', 3.4, pos, {
  mode: 'manual', includeOtherFields: true,
  assignments: { assignments: CONFIG_VALUES.filter(([k]) => !keys || keys.includes(k)).map(([name, value, type]) => ({ id: uid(`cfg:${name}`), name, value, type })) },
  options: {},
}, { notes: 'Per-client settings. smsMode: mock or twilio. Slack and mock URLs are set here too.', notesInFlow: true });

const webhook = (name, p, pos) => node(name, 'webhook', 2, pos, { httpMethod: 'POST', path: p, responseMode: 'responseNode', options: {} }, { webhookId: uid(`webhook:${p}`) });
const respondOk = (pos) => node('Respond OK', 'respondToWebhook', 1.1, pos, {
  respondWith: 'text', responseBody: '<Response></Response>',
  options: { responseCode: 200, responseHeaders: { entries: [{ name: 'Content-Type', value: 'text/xml' }] } },
}, { notes: 'Answers the phone company at once. Everything after this runs in the background.', notesInFlow: true });
const ifEquals = (name, pos, field, value) => node(name, 'if', 2.2, pos, {
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
    conditions: [{ id: uid(`if:${name}`), leftValue: `={{ $json.${field} }}`, rightValue: value, operator: { type: 'string', operation: 'equals' } }],
    combinator: 'and',
  },
  options: {},
});
const codeNode = (name, pos, file, extra = {}) => node(name, 'code', 2, pos, { jsCode: code(file) }, extra);
const http = (name, pos, url, body, extra = {}) => node(name, 'httpRequest', 4.2, pos, {
  method: 'POST', url, sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: body, options: { timeout: 10000 },
}, extra);
const retry = { retryOnFail: true, maxTries: 2, waitBetweenTries: 1000 };
const mock = (p) => `={{ $('Config').first().json.mockBaseUrl }}${p}`;
const stop = (name, pos, text) => node(name, 'stopAndError', 1, pos, { errorType: 'errorMessage', errorMessage: text });
const sticky = (pos, w, h, content) => node(`Note ${pos[0]}`, 'stickyNote', 1, pos, { content, width: w, height: h, color: 7 });

// The sender: mock by default (a local log), real Twilio when Config.smsMode is "twilio" and the node is turned on.
const smsCluster = (x, y) => [
  ifEquals('SMS Mode?', [x, y], 'config_unused', 'twilio'),
  node('Send SMS (Twilio)', 'twilio', 1, [x + 230, y - 90], {
    resource: 'sms', operation: 'send', from: '={{ $json.sms.from }}', to: '={{ $json.sms.to }}', toWhatsapp: false, message: '={{ $json.sms.body }}', options: {},
  }, { disabled: true, notes: 'Turned off in the demo (no credentials). To go live: add the client\'s Twilio credential, turn this on, set smsMode to twilio.', notesInFlow: true }),
  http('Send SMS (mock)', [x + 230, y + 90], mock('/sms'), '={{ JSON.stringify($json.sms) }}', {
    ...retry, notes: 'Demo sender: appends the text to a local log instead of sending it.', notesInFlow: true,
  }),
];
// "SMS Mode?" reads Config, not the item, so it gets its own condition.
const smsModeNode = (x, y) => {
  const n = smsCluster(x, y);
  n[0].parameters.conditions.conditions[0].leftValue = "={{ $('Config').first().json.smsMode }}";
  return n;
};

const wf = (id, name, nodes, links, settings) => {
  const connections = {};
  for (const [from, to, out = 0] of links) {
    connections[from] ??= { main: [] };
    while (connections[from].main.length <= out) connections[from].main.push([]);
    connections[from].main[out].push({ node: to, type: 'main', index: 0 });
  }
  return { id, name, nodes, connections, active: false, settings: { executionOrder: 'v1', ...settings }, pinData: {}, meta: { templateCredsSetupCompleted: false } };
};
const ERROR_WF = 'hsdErrorAlert01';

// ---- 1. missed call -> instant text ----------------------------------------------------------------------------
const w1Nodes = [
  webhook('Missed Call Webhook', 'hsd/missed-call', [0, 300]),
  respondOk([220, 300]),
  config([440, 300]),
  codeNode('Validate Call', [660, 300], 'validate-call.js'),
  ifEquals('Valid Missed Call?', [880, 300], 'route', 'ok'),
  codeNode('Dedupe Caller', [1100, 200], 'dedupe-call.js'),
  ifEquals('New Caller?', [1320, 200], 'route', 'new'),
  codeNode('Build Reply SMS', [1540, 120], 'reply-sms.js'),
  ...smsModeNode(1760, 120),
  codeNode('Mark Texted', [2220, 120], 'mark-texted.js'),
  http('Log Duplicate Call', [1540, 320], mock('/log'), "={{ JSON.stringify({ kind: 'event', line: 'duplicate call: ' + $json.reason }) }}"),
  ifEquals('Invalid Input?', [1100, 440], 'route', 'invalid'),
  stop('Reject Invalid Call', [1320, 400], '={{ "Rejected missed-call event: " + $json.reason }}'),
  http('Log Ignored Call', [1320, 540], mock('/log'), "={{ JSON.stringify({ kind: 'event', line: 'ignored: ' + $json.reason }) }}"),
  sticky([0, 60], 640, 170, '## 1. Missed call -> instant text\nThe phone system posts a missed call here. The caller gets a text within seconds. A repeat caller within 24 hours is not texted twice. Bad data raises an alert (error workflow) instead of failing silently.'),
];
const w1Links = [
  ['Missed Call Webhook', 'Respond OK'], ['Respond OK', 'Config'], ['Config', 'Validate Call'], ['Validate Call', 'Valid Missed Call?'],
  ['Valid Missed Call?', 'Dedupe Caller', 0], ['Valid Missed Call?', 'Invalid Input?', 1],
  ['Dedupe Caller', 'New Caller?'], ['New Caller?', 'Build Reply SMS', 0], ['New Caller?', 'Log Duplicate Call', 1],
  ['Build Reply SMS', 'SMS Mode?'], ['SMS Mode?', 'Send SMS (Twilio)', 0], ['SMS Mode?', 'Send SMS (mock)', 1],
  ['Send SMS (Twilio)', 'Mark Texted'], ['Send SMS (mock)', 'Mark Texted'],
  ['Invalid Input?', 'Reject Invalid Call', 0], ['Invalid Input?', 'Log Ignored Call', 1],
];

// ---- 2. customer reply -> job card ------------------------------------------------------------------------------
const w2Nodes = [
  webhook('Customer Reply Webhook', 'hsd/customer-reply', [0, 300]),
  respondOk([220, 300]),
  config([440, 300]),
  codeNode('Parse Reply', [660, 300], 'parse-reply.js'),
  ifEquals('Reply OK?', [880, 300], 'route', 'ok'),
  stop('Reject Unreadable Reply', [1100, 440], '={{ "Rejected customer reply: " + $json.reason }}'),
  codeNode('Dedupe & Merge', [1100, 200], 'merge-state.js'),
  ifEquals('Already Has Job?', [1320, 200], 'route', 'duplicate'),
  http('Log Duplicate Reply', [1540, 100], mock('/log'), "={{ JSON.stringify({ kind: 'event', line: 'duplicate reply: ' + $json.reason }) }}"),
  ifEquals('Make Job Card?', [1540, 300], 'route', 'card'),
  codeNode('Build Job Card', [1760, 200], 'job-card.js'),
  http('Add Row (mock CSV)', [1980, 200], mock('/sheet'), "={{ JSON.stringify({ row: $json.sheetRow }) }}", {
    ...retry, notes: 'Demo jobs sheet: a CSV file. Same columns as the Google Sheets node.', notesInFlow: true,
  }),
  node('Add Row (Google Sheets)', 'googleSheets', 4.5, [2200, 200], {
    authentication: 'oAuth2', resource: 'sheet', operation: 'append',
    documentId: { __rl: true, mode: 'url', value: '' }, sheetName: { __rl: true, mode: 'name', value: 'Jobs' },
    columns: { mappingMode: 'defineBelow', value: Object.fromEntries(SHEET_COLUMNS.map((c) => [c, `={{ $('Build Job Card').first().json.sheetRow.${c} }}`])), matchingColumns: [], schema: [] },
    options: {},
  }, { disabled: true, notes: 'Turned off in the demo (no credentials). To go live: add the client\'s Google credential and pick the sheet.', notesInFlow: true }),
  http('Post to Slack', [2420, 200], '={{ $(\'Config\').first().json.slackWebhookUrl }}', "={{ JSON.stringify($('Build Job Card').first().json.slack) }}", {
    ...retry, notes: 'Slack incoming webhook. Demo default is a local mock; put the client\'s real URL in Config.', notesInFlow: true,
  }),
  codeNode('Build SMS', [2640, 300], 'sms-texts.js'),
  ...smsModeNode(2860, 300),
  sticky([0, 60], 700, 170, '## 2. Customer reply -> job card\nThe customer\'s text comes in. Plain rules read the address, ZIP and problem, flag urgent jobs and remember the customer for 24 hours. A job card goes to Slack and to the jobs sheet. A missing address gets a polite question instead of a card (unless it is urgent).'),
];
const w2Links = [
  ['Customer Reply Webhook', 'Respond OK'], ['Respond OK', 'Config'], ['Config', 'Parse Reply'], ['Parse Reply', 'Reply OK?'],
  ['Reply OK?', 'Dedupe & Merge', 0], ['Reply OK?', 'Reject Unreadable Reply', 1],
  ['Dedupe & Merge', 'Already Has Job?'], ['Already Has Job?', 'Log Duplicate Reply', 0], ['Already Has Job?', 'Make Job Card?', 1],
  ['Make Job Card?', 'Build Job Card', 0], ['Make Job Card?', 'Build SMS', 1],
  ['Build Job Card', 'Add Row (mock CSV)'], ['Add Row (mock CSV)', 'Add Row (Google Sheets)'], ['Add Row (Google Sheets)', 'Post to Slack'], ['Post to Slack', 'Build SMS'],
  ['Build SMS', 'SMS Mode?'], ['SMS Mode?', 'Send SMS (Twilio)', 0], ['SMS Mode?', 'Send SMS (mock)', 1],
];

// ---- 3. error alert ---------------------------------------------------------------------------------------------
const w3Nodes = [
  node('Error Trigger', 'errorTrigger', 1, [0, 200], {}),
  config([220, 200], ['mockBaseUrl', 'slackWebhookUrl']),
  codeNode('Build Alert', [440, 200], 'build-alert.js'),
  http('Write Alert Log Line', [660, 200], mock('/log'), "={{ JSON.stringify({ kind: 'alert', line: $json.logLine }) }}", {
    notes: 'Last line of defence: a log line is written first, so an alert exists even if Slack is down.', notesInFlow: true,
  }),
  http('Post Alert to Slack', [880, 200], '={{ $(\'Config\').first().json.slackWebhookUrl }}', "={{ JSON.stringify($('Build Alert').first().json.alert) }}", { onError: 'continueRegularOutput' }),
  sticky([0, 20], 620, 130, '## 3. Error alert\nSet as the "error workflow" of workflows 1 and 2. Any failure becomes a Slack alert plus a log line, both with the execution id, so nothing fails silently.'),
];
const w3Links = [['Error Trigger', 'Config'], ['Config', 'Build Alert'], ['Build Alert', 'Write Alert Log Line'], ['Write Alert Log Line', 'Post Alert to Slack']];

const out = [
  ['1-missed-call.json', wf('hsdMissedCall01', 'HSD 1 - Missed call to instant text', w1Nodes, w1Links, { errorWorkflow: ERROR_WF })],
  ['2-customer-reply.json', wf('hsdCustomerReply01', 'HSD 2 - Customer reply to job card', w2Nodes, w2Links, { errorWorkflow: ERROR_WF })],
  ['3-error-alert.json', wf(ERROR_WF, 'HSD 3 - Error alert', w3Nodes, w3Links, {})],
];
mkdirSync(path.join(root, 'workflows'), { recursive: true });
for (const [file, w] of out) {
  writeFileSync(path.join(root, 'workflows', file), JSON.stringify(w, null, 2) + '\n');
  console.log(`${file}: ${w.nodes.length} nodes`);
}
