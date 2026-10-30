// Remembers each customer for Config.dedupeHours. Decides: card (make a job card), ask_info (ask for the address),
// or duplicate (this customer already has a job card, so no second one).
const cfg = $('Config').first().json;
const msg = $input.first().json;
const store = $getWorkflowStaticData('global');
store.customers = store.customers ?? {};
store.seq = store.seq ?? 0;

const now = new Date(msg.receivedAt).getTime();
const windowMs = Number(cfg.dedupeHours) * 3600 * 1000;
for (const [num, rec] of Object.entries(store.customers)) {
  if (now - rec.firstAt >= windowMs) delete store.customers[num];
}
const prev = store.customers[msg.from];

// Fill the gaps from earlier messages inside the window; new information wins.
const messages = [...(prev?.messages ?? []), msg.text].slice(-5);
const merged = {
  address: msg.address ?? prev?.address ?? null,
  city: msg.city ?? prev?.city ?? null,
  state: msg.state ?? prev?.state ?? null,
  zip: msg.zip ?? prev?.zip ?? null,
  problemType: msg.problemType !== 'other' ? msg.problemType : (prev?.problemType ?? 'other'),
  language: msg.language === 'es' ? 'es' : (prev?.language ?? msg.language),
  urgencyReasons: [...new Set([...(prev?.urgencyReasons ?? []), ...msg.urgencyReasons])],
};
merged.urgent = merged.urgencyReasons.length > 0;

let route;
if (prev?.jobId && !(prev.addressMissing && merged.address)) route = 'duplicate';
else if (merged.address) route = 'card';
else if (merged.urgent || (prev?.asks ?? 0) >= 2) route = 'card'; // urgent, or asked twice already: a person takes over
else route = 'ask_info';

const isUpdate = route === 'card' && Boolean(prev?.jobId);
let jobId = prev?.jobId ?? null;
if (route === 'card' && !jobId) {
  store.seq += 1;
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: cfg.businessTimezone }).format(new Date(msg.receivedAt)).replace(/-/g, '');
  jobId = `J-${day}-${String(store.seq).padStart(3, '0')}`;
}

const rec = {
  ...(prev ?? {}), ...merged, messages, jobId,
  firstAt: prev?.firstAt ?? now, lastAt: now, replies: (prev?.replies ?? 0) + 1,
  asks: (prev?.asks ?? 0) + (route === 'ask_info' ? 1 : 0),
  cardAt: route === 'card' ? now : prev?.cardAt,
  addressMissing: route === 'card' ? !merged.address : prev?.addressMissing,
};
store.customers[msg.from] = rec;

const out = { ...msg, ...merged, message: messages.join(' | '), route, isUpdate, jobId, addressMissing: !merged.address, asks: rec.asks, replies: rec.replies };
if (route === 'duplicate') out.reason = `${msg.from} already has job ${prev.jobId} (created ${new Date(prev.cardAt).toISOString()}), no second job card`;
return [{ json: out }];
