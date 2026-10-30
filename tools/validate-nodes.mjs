#!/usr/bin/env node
// Static import check. Reads the node definitions of an INSTALLED n8n (it does not start n8n, touches no database) and checks
// that every node in workflows/ exists, has a supported typeVersion and only uses parameter names the node knows.
// Usage: node tools/validate-nodes.mjs <folder that contains node_modules/n8n-nodes-base>     e.g. ~/Tools/n8n
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const base = process.argv[2];
if (!base || !existsSync(path.join(base, 'node_modules/n8n-nodes-base'))) {
  console.log('usage: node tools/validate-nodes.mjs <folder with node_modules/n8n-nodes-base>   (skipped)');
  process.exit(2);
}
const require = createRequire(path.join(base, 'package.json'));
const root = path.join(base, 'node_modules/n8n-nodes-base/dist/nodes');
const n8nVersion = JSON.parse(readFileSync(path.join(base, 'node_modules/n8n/package.json'), 'utf8')).version;
const FILES = {
  webhook: 'Webhook/Webhook', respondToWebhook: 'RespondToWebhook/RespondToWebhook', set: 'Set/Set', code: 'Code/Code', if: 'If/If',
  httpRequest: 'HttpRequest/HttpRequest', errorTrigger: 'ErrorTrigger/ErrorTrigger', noOp: 'NoOp/NoOp', stopAndError: 'StopAndError/StopAndError',
  twilio: 'Twilio/Twilio', googleSheets: 'Google/Sheet/GoogleSheets', stickyNote: 'StickyNote/StickyNote',
};
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'workflows');
const workflows = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => [f, JSON.parse(readFileSync(path.join(dir, f), 'utf8'))]);
const ids = new Set(workflows.map(([, w]) => w.id));
const cache = new Map();
const load = (kind) => {
  if (!cache.has(kind)) {
    const Cls = Object.values(require(path.join(root, FILES[kind] + '.node.js')))[0];
    cache.set(kind, new Cls());
  }
  return cache.get(kind);
};

let problems = 0;
const bad = (file, msg) => { problems += 1; console.log(`  PROBLEM ${file}: ${msg}`); };
let checked = 0;
for (const [file, w] of workflows) {
  const names = new Set();
  for (const n of w.nodes) {
    checked += 1;
    if (names.has(n.name)) bad(file, `duplicate node name "${n.name}"`);
    names.add(n.name);
    if (n.credentials) bad(file, `"${n.name}" carries credentials`);
    const kind = n.type.replace('n8n-nodes-base.', '');
    if (!FILES[kind]) { bad(file, `"${n.name}": type ${n.type} not covered by this checker`); continue; }
    let inst;
    try { inst = load(kind); } catch (e) { bad(file, `"${n.name}": cannot load ${n.type}: ${e.message}`); continue; }
    const versions = inst.nodeVersions ? Object.keys(inst.nodeVersions) : [].concat(inst.description.version).map(String);
    if (!versions.includes(String(n.typeVersion))) { bad(file, `"${n.name}": ${n.type} has no version ${n.typeVersion} (has ${versions.join(', ')})`); continue; }
    const desc = inst.nodeVersions ? inst.nodeVersions[n.typeVersion].description : inst.description;
    const known = new Set(desc.properties.map((p) => p.name));
    for (const key of Object.keys(n.parameters)) if (!known.has(key)) bad(file, `"${n.name}": parameter "${key}" is unknown for ${n.type} ${n.typeVersion}`);
    if (n.onError && !['continueRegularOutput', 'continueErrorOutput', 'stopWorkflow'].includes(n.onError)) bad(file, `"${n.name}": onError "${n.onError}"`);
  }
  for (const [from, outs] of Object.entries(w.connections)) {
    if (!names.has(from)) bad(file, `connection from unknown node "${from}"`);
    for (const targets of outs.main) for (const t of targets) if (!names.has(t.node)) bad(file, `connection to unknown node "${t.node}"`);
  }
  if (w.settings?.errorWorkflow && !ids.has(w.settings.errorWorkflow)) bad(file, `errorWorkflow ${w.settings.errorWorkflow} is not in this folder`);
  console.log(`${file}: ${w.nodes.length} nodes checked`);
}
console.log(problems ? `\n${problems} problem(s) against n8n ${n8nVersion}` : `\nOK: ${checked} nodes match the node definitions of n8n ${n8nVersion} (static check, n8n was not started)`);
process.exit(problems ? 1 : 0);
