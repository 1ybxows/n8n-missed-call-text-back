//@include shared.js
// Checks the missed-call event. Output route: ok | ignore (call was answered) | invalid (bad data -> alert).
const body = $('Missed Call Webhook').first().json.body ?? {};
const now = new Date();
// Twilio's <Dial action> reports the outcome as DialCallStatus; a plain status callback sends CallStatus.
const status = String(body.DialCallStatus ?? body.CallStatus ?? '').toLowerCase();
const base = { callSid: body.CallSid ?? null, receivedAt: now.toISOString() };

if (!['no-answer', 'busy', 'canceled'].includes(status)) {
  return [{ json: { ...base, route: 'ignore', reason: `call status "${status || 'missing'}" is not a missed call` } }];
}
const from = toE164(body.From);
if (!from) {
  return [{ json: { ...base, route: 'invalid', reason: `caller number "${body.From ?? ''}" is not a valid US number, nobody was texted` } }];
}
const to = toE164(body.To);
if (!to) {
  return [{ json: { ...base, route: 'invalid', reason: `business number "${body.To ?? ''}" is not a valid US number` } }];
}

// Open or closed: the phone system's flag wins; if it is missing, work it out from the Config hours (Mon-Sat).
function readFlag(v) {
  if (typeof v === 'boolean') return v;
  const s = String(v ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', 'open', 'in-hours'].includes(s)) return true;
  if (['false', '0', 'no', 'closed', 'after-hours'].includes(s)) return false;
  return null;
}
const flag = readFlag(body.BusinessHours);
let open = flag;
if (open === null) {
  const l = localParts(now, cfg.businessTimezone);
  open = l.weekday !== 'Sun' && l.hour >= Number(cfg.openHour) && l.hour < Number(cfg.closeHour);
}
return [{ json: { ...base, route: 'ok', from, to, afterHours: !open, hoursSource: flag === null ? 'computed from Config' : 'phone system flag' } }];
