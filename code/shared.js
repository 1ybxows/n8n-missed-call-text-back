// Shared helpers. tools/build.mjs copies this block into every Code node that says "//@include shared.js",
// because an n8n Code node cannot import local files.
const cfg = $('Config').first().json;

// Test clock: honoured only when Config.allowTestClock is true (tests and demos). Production ignores the TestNow field.
const clock = () => (cfg.allowTestClock === true && cfg.testNow ? new Date(cfg.testNow) : new Date());

// US numbers only. Returns +1XXXXXXXXXX or null. Area code and exchange must start with 2-9.
function toE164(raw) {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(d) ? '+1' + d : null;
}

// Local weekday / hour / month in the business time zone.
function localParts(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', hour: 'numeric', hourCycle: 'h23', month: 'numeric',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return { weekday: get('weekday'), hour: Number(get('hour')), month: Number(get('month')) };
}
