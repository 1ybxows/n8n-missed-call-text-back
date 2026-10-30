// Same caller again inside the window (Config.dedupeHours) gets no second text.
// A caller counts as "texted" only after the SMS really went out (see Mark Texted), so a failed send is retried on the next call.
const cfg = $('Config').first().json;
const call = $input.first().json;
const store = $getWorkflowStaticData('global');
store.callers = store.callers ?? {};

const now = Date.now();
const windowMs = Number(cfg.dedupeHours) * 3600 * 1000;
for (const [num, rec] of Object.entries(store.callers)) {
  if (now - rec.firstCallAt >= windowMs) delete store.callers[num];
}

const seen = store.callers[call.from];
if (seen && seen.texted) {
  seen.calls += 1;
  seen.lastCallAt = now;
  const first = new Date(seen.firstCallAt).toISOString();
  return [{ json: { ...call, route: 'duplicate', calls: seen.calls, reason: `${call.from} was already texted at ${first} (call number ${seen.calls} in ${cfg.dedupeHours} h), no second text` } }];
}
store.callers[call.from] = { firstCallAt: seen?.firstCallAt ?? now, lastCallAt: now, calls: (seen?.calls ?? 0) + 1, texted: false };
return [{ json: { ...call, route: 'new' } }];
