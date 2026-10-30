#!/usr/bin/env node
// Offline engine for the workflow files in workflows/. It is NOT n8n: it runs the same JSON (nodes, connections, Code-node
// JavaScript, IF conditions, expressions, retries, error workflow) for the few node types this demo uses, so the logic can be
// tested without an n8n server. HTTP Request nodes make real HTTP calls (to the mock server in tests/).
// Usage: node tools/mini-runner.mjs --workflow workflows/1-missed-call.json --payload '{"From":"..."}' --now 2027-01-12T10:15:00-06:00 --state <dir>
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    workflow: { type: 'string' }, payload: { type: 'string', default: '{}' }, now: { type: 'string' }, state: { type: 'string' },
    config: { type: 'string', multiple: true, default: [] }, 'workflows-dir': { type: 'string' },
  },
});
const NOW = args.now ? Date.parse(args.now) : Date.now();
class FakeDate extends Date {
  constructor(...a) { if (a.length === 0) super(NOW); else super(...a); }
  static now() { return NOW; }
}
const overrides = Object.fromEntries(args.config.map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
const stateDir = args.state;
mkdirSync(stateDir, { recursive: true });
const wfDir = args['workflows-dir'] ?? path.dirname(path.resolve(args.workflow));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const nextExecId = () => {
  const f = path.join(stateDir, 'exec-counter.json');
  const n = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')).n : 1000;
  writeFileSync(f, JSON.stringify({ n: n + 1 }));
  return String(n + 1);
};
const staticFile = (id) => path.join(stateDir, `static-${id}.json`);
const loadStatic = (id) => (existsSync(staticFile(id)) ? JSON.parse(readFileSync(staticFile(id), 'utf8')) : {});

// ---- expressions: "={{ ... }}" -------------------------------------------------------------------------------------
function evalJs(expr, ctx) {
  const names = Object.keys(ctx);
  return new Function(...names, `"use strict"; return (${expr});`)(...names.map((n) => ctx[n]));
}
function resolve(val, ctx) {
  if (typeof val === 'string') {
    if (!val.startsWith('=')) return val;
    const tpl = val.slice(1);
    const single = /^\{\{([\s\S]+)\}\}$/.exec(tpl.trim());
    if (single && !single[1].includes('{{')) return evalJs(single[1], ctx);
    return tpl.replace(/\{\{([\s\S]+?)\}\}/g, (_, e) => { const v = evalJs(e, ctx); return typeof v === 'object' ? JSON.stringify(v) : String(v); });
  }
  if (Array.isArray(val)) return val.map((v) => resolve(v, ctx));
  if (val && typeof val === 'object') return Object.fromEntries(Object.entries(val).map(([k, v]) => [k, resolve(v, ctx)]));
  return val;
}
function makeCtx(run, items, i) {
  const ref = (name) => {
    const out = run.outputs.get(name);
    if (!out) throw new Error(`Node '${name}' hasn't been executed`);
    return { first: () => out[0], last: () => out[out.length - 1], all: () => out, item: out[i] ?? out[0] };
  };
  return {
    $json: items[i]?.json, $: ref, $input: { first: () => items[0], last: () => items[items.length - 1], all: () => items, item: items[i] },
    $execution: { id: run.executionId, mode: 'production' }, $workflow: { id: run.wf.id, name: run.wf.name, active: true },
    $getWorkflowStaticData: () => run.staticData, Date: FakeDate,
  };
}

// ---- nodes ------------------------------------------------------------------------------------------------------------
const OPS = {
  equals: (a, b) => a === b, notEquals: (a, b) => a !== b, contains: (a, b) => String(a).includes(b),
  true: (a) => a === true, false: (a) => a === false,
};
async function httpNode(node, ctx) {
  const p = resolve(node.parameters, ctx);
  const body = typeof p.jsonBody === 'string' ? p.jsonBody : JSON.stringify(p.jsonBody);
  const tries = node.retryOnFail ? (node.maxTries ?? 3) : 1;
  let last;
  for (let a = 1; a <= tries; a++) {
    try {
      const res = await fetch(p.url, { method: p.method, headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(p.options?.timeout ?? 10000) });
      const text = await res.text();
      if (!res.ok) throw new Error(`Request failed with status code ${res.status} (${text.slice(0, 80)})`);
      let json;
      try { json = JSON.parse(text); } catch { json = { data: text }; }
      return { json };
    } catch (e) {
      last = e;
      if (a < tries) await sleep(Math.min(node.waitBetweenTries ?? 0, 20)); // real n8n waits waitBetweenTries; shortened here
    }
  }
  if (node.onError === 'continueRegularOutput') return { json: { error: last.message } };
  throw last;
}
async function execNode(node, items, run) {
  if (node.disabled) return [items]; // n8n passes the data straight through a turned-off node
  const kind = node.type.replace('n8n-nodes-base.', '');
  switch (kind) {
    case 'webhook': case 'errorTrigger': return [items];
    case 'noOp': case 'stickyNote': return [items];
    case 'respondToWebhook': {
      const p = resolve(node.parameters, makeCtx(run, items, 0));
      run.response ??= { code: p.options?.responseCode ?? 200, body: p.responseBody };
      return [items];
    }
    case 'set': return [items.map((item, i) => {
      const ctx = makeCtx(run, items, i);
      const json = node.parameters.includeOtherFields ? { ...item.json } : {};
      for (const a of node.parameters.assignments.assignments) {
        const o = node.name === 'Config' ? overrides[a.name] : undefined;
        json[a.name] = o !== undefined ? (a.type === 'number' ? Number(o) : a.type === 'boolean' ? o === 'true' : o) : resolve(a.value, ctx);
      }
      return { json };
    })];
    case 'if': {
      const yes = [], no = [];
      items.forEach((item, i) => {
        const ctx = makeCtx(run, items, i);
        const c = node.parameters.conditions;
        const results = c.conditions.map((x) => {
          const op = OPS[x.operator.operation];
          if (!op) throw new Error(`mini-runner: IF operator ${x.operator.operation} not supported`);
          return op(resolve(x.leftValue, ctx), resolve(x.rightValue, ctx));
        });
        const pass = c.combinator === 'or' ? results.some(Boolean) : results.every(Boolean);
        (pass ? yes : no).push(item);
      });
      return [yes, no];
    }
    case 'code': {
      const ctx = makeCtx(run, items, 0);
      const fn = new Function('$input', '$', '$getWorkflowStaticData', '$execution', '$workflow', 'Date', 'console', node.parameters.jsCode);
      const out = fn(ctx.$input, ctx.$, ctx.$getWorkflowStaticData, ctx.$execution, ctx.$workflow, FakeDate, { log: (...a) => console.error(...a) });
      if (!Array.isArray(out) || out.some((x) => !x || typeof x.json !== 'object')) throw new Error('Code node must return an array of { json: {...} } items');
      return [out];
    }
    case 'httpRequest': {
      const out = [];
      for (let i = 0; i < items.length; i++) out.push(await httpNode(node, makeCtx(run, items, i)));
      return [out];
    }
    case 'stopAndError': throw new Error(resolve(node.parameters.errorMessage, makeCtx(run, items, 0)));
    default: throw new Error(`mini-runner: node type ${node.type} is not supported (turned-off nodes are fine)`);
  }
}

async function runWorkflow(wf, startItems) {
  const executionId = nextExecId();
  const run = { wf, executionId, outputs: new Map(), nodesRun: [], response: null, staticData: loadStatic(wf.id) };
  const byName = new Map(wf.nodes.map((n) => [n.name, n]));
  const start = wf.nodes.find((n) => ['n8n-nodes-base.webhook', 'n8n-nodes-base.errorTrigger'].includes(n.type));
  const queue = [{ name: start.name, items: startItems }];
  let error = null;
  while (queue.length) {
    const { name, items } = queue.shift();
    try {
      const outs = await execNode(byName.get(name), items, run);
      run.outputs.set(name, outs.find((o) => o.length) ?? []);
      run.nodesRun.push(name);
      (wf.connections[name]?.main ?? []).forEach((targets, idx) => {
        if (outs[idx]?.length) for (const t of targets) queue.push({ name: t.node, items: outs[idx] });
      });
    } catch (e) {
      error = { node: name, message: e.message };
      run.nodesRun.push(`${name} (FAILED)`);
      break;
    }
  }
  writeFileSync(staticFile(wf.id), JSON.stringify(run.staticData));
  return { run, error };
}

const wf = JSON.parse(readFileSync(args.workflow, 'utf8'));
const first = await runWorkflow(wf, [{ json: { headers: {}, params: {}, query: {}, body: JSON.parse(args.payload) } }]);
let errorRun = null;
if (first.error && wf.settings?.errorWorkflow) {
  const file = readdirSync(wfDir).filter((f) => f.endsWith('.json')).map((f) => path.join(wfDir, f)).find((f) => JSON.parse(readFileSync(f, 'utf8')).id === wf.settings.errorWorkflow);
  if (file) {
    const data = { execution: { id: first.run.executionId, url: `http://127.0.0.1:5678/workflow/${wf.id}/executions/${first.run.executionId}`, error: { message: first.error.message }, lastNodeExecuted: first.error.node, mode: 'webhook' }, workflow: { id: wf.id, name: wf.name } };
    errorRun = await runWorkflow(JSON.parse(readFileSync(file, 'utf8')), [{ json: data }]);
  }
}
console.log(JSON.stringify({
  workflow: wf.name, executionId: first.run.executionId, ok: !first.error, error: first.error, nodesRun: first.run.nodesRun, response: first.run.response,
  errorWorkflow: errorRun ? { executionId: errorRun.run.executionId, ok: !errorRun.error, error: errorRun.error, nodesRun: errorRun.run.nodesRun } : null,
}));
