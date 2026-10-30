// Draws docs/flow.svg: the three workflows on one page. Hand-placed boxes (the n8n canvas is too wide to read in a README).
// Run: node tools/make-diagram.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COLORS = {
  trigger: ['#e3f4e8', '#2e7d4f'], code: ['#e8eefb', '#3b5bdb'], decision: ['#fff4dc', '#b7791f'],
  out: ['#f1e8fb', '#7c3aed'], error: ['#fde8e8', '#c53030'], off: ['#f1f1f1', '#8a8a8a'],
};
const W = 150, H = 54;
const boxes = {};
const parts = [];
const box = (id, x, y, kind, text, dashed = false) => {
  boxes[id] = { x, y };
  const [fill, stroke] = COLORS[kind];
  const lines = text.split('\n');
  const t = lines.map((l, i) => `<tspan x="${x + W / 2}" dy="${i === 0 ? -(lines.length - 1) * 7 : 14}">${l}</tspan>`).join('');
  parts.push(`<rect x="${x}" y="${y}" width="${W}" height="${H}" rx="9" fill="${fill}" stroke="${stroke}" stroke-width="1.6"${dashed ? ' stroke-dasharray="5 4"' : ''}/>`);
  parts.push(`<text x="${x + W / 2}" y="${y + H / 2 + 4}" text-anchor="middle" font-size="12" fill="#1f2328">${t}</text>`);
};
const arrow = (a, b, label, side = 'h', dx = 0) => {
  const A = boxes[a], B = boxes[b];
  let x1, y1, x2, y2;
  if (side === 'h') { x1 = A.x + W; y1 = A.y + H / 2; x2 = B.x; y2 = B.y + H / 2; }
  else { x1 = A.x + W / 2; y1 = A.y + H; x2 = B.x + W / 2; y2 = B.y; }
  parts.push(`<path d="M${x1} ${y1} L${x2} ${y2}" stroke="#57606a" stroke-width="1.5" fill="none" marker-end="url(#arr)"/>`);
  if (label) parts.push(`<text x="${(x1 + x2) / 2 + dx + (side === 'h' ? 0 : 8)}" y="${(y1 + y2) / 2 - (side === 'h' ? 6 : -4)}" text-anchor="${side === 'h' ? 'middle' : 'start'}" font-size="11" fill="#57606a">${label}</text>`);
};
const title = (y, text) => parts.push(`<text x="30" y="${y}" font-size="15" font-weight="600" fill="#1f2328">${text}</text>`);

title(30, '1. Missed call - instant text');
box('a1', 30, 46, 'trigger', 'Phone system\nmissed-call webhook');
box('a2', 230, 46, 'code', 'Check the call\nmissed? real number?\nopen or closed?');
box('a3', 430, 46, 'decision', 'Texted this caller\nin the last 24 h?');
box('a4', 630, 46, 'out', 'Instant text back\nmock log / Twilio');
box('a5', 830, 46, 'code', 'Mark caller\nas texted');
box('a6', 430, 136, 'code', 'Log it, send no\nsecond text');
box('a7', 230, 136, 'error', 'Bad data:\nalert, no text');
box('a8', 30, 136, 'off', 'Call was answered:\nignore, log it');
arrow('a1', 'a2'); arrow('a2', 'a3', 'ok'); arrow('a3', 'a4', 'no'); arrow('a4', 'a5'); arrow('a3', 'a6', 'yes', 'v'); arrow('a2', 'a7', 'bad', 'v'); arrow('a2', 'a8', 'answered', 'v', -62);

title(262, '2. Customer reply - job card');
box('b1', 30, 278, 'trigger', "Customer's text\nreply webhook");
box('b2', 230, 278, 'code', 'Read the text:\naddress, ZIP, problem,\nurgency, language');
box('b3', 430, 278, 'code', 'Remember customer\n24 h, merge messages');
box('b4', 630, 278, 'decision', 'Address found\n(or urgent)?');
box('b5', 830, 278, 'code', 'Build the\njob card');
box('b6', 1030, 232, 'out', 'Slack card\nAssign / Call back');
box('b7', 1030, 300, 'out', 'Row in the\njobs sheet');
box('b8', 1030, 368, 'out', 'Confirmation text\nto the customer');
box('b9', 630, 368, 'out', 'Ask for the address\nby text');
box('b10', 430, 368, 'code', 'Already has a job:\nno second card');
arrow('b1', 'b2'); arrow('b2', 'b3'); arrow('b3', 'b4'); arrow('b4', 'b5', 'yes'); arrow('b5', 'b6'); arrow('b5', 'b7'); arrow('b5', 'b8');
arrow('b4', 'b9', 'no', 'v'); arrow('b3', 'b10', 'repeat', 'v');

title(478, '3. Error alert - nothing fails silently');
box('c1', 30, 494, 'error', 'Any failure in\nworkflow 1 or 2');
box('c2', 230, 494, 'code', 'Build alert: workflow,\nstep, error, execution id');
box('c3', 430, 494, 'out', 'Log line\n(always written)');
box('c4', 630, 494, 'out', 'Slack alert\n(tried second)');
arrow('c1', 'c2'); arrow('c2', 'c3'); arrow('c3', 'c4');

parts.push('<text x="30" y="590" font-size="11" fill="#57606a">Legend:</text>');
let lx = 85;
for (const [name, kind] of [['trigger', 'trigger'], ['Code node', 'code'], ['decision', 'decision'], ['sends something (mock by default)', 'out'], ['alert', 'error'], ['not a missed call', 'off']]) {
  parts.push(`<rect x="${lx}" y="580" width="14" height="14" rx="3" fill="${COLORS[kind][0]}" stroke="${COLORS[kind][1]}" stroke-width="1.4"/>`);
  parts.push(`<text x="${lx + 20}" y="591" font-size="11" fill="#57606a">${name}</text>`);
  lx += 40 + name.length * 6.2;
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1210" height="610" viewBox="0 0 1210 610" font-family="-apple-system, Helvetica, Arial, sans-serif">
<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#57606a"/></marker></defs>
<rect width="1210" height="610" fill="#ffffff"/>
${parts.join('\n')}
</svg>
`;
mkdirSync(path.join(root, 'docs'), { recursive: true });
writeFileSync(path.join(root, 'docs', 'flow.svg'), svg);
console.log('wrote docs/flow.svg');
