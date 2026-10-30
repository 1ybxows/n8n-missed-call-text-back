//@include shared.js
// Reads the customer's text with plain rules (no AI): address, ZIP, problem type, urgency, language.
const hook = $('Customer Reply Webhook').first().json.body ?? {};
const now = new Date();
const from = toE164(hook.From);
const to = toE164(hook.To);
const text = String(hook.Body ?? '').replace(/\s+/g, ' ').trim();
const base = { receivedAt: now.toISOString(), messageSid: hook.MessageSid ?? null };
if (!from || !to) {
  const bad = !from ? hook.From : hook.To;
  return [{ json: { ...base, route: 'invalid', reason: `${!from ? 'customer' : 'business'} number "${bad ?? ''}" is not a valid US number, message not processed` } }];
}

// lower case, accents removed: "calefacción" and "calefaccion" hit the same rule
const t = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// Language: English unless two different Spanish words show up.
const esWords = new Set(t.match(/\b(hola|necesito|por favor|gracias|calle|avenida|vivo|estoy|tengo|tiene|hay|sin|funciona|fuga|agua|calefaccion|aire|acondicionado|puerta|garaje|casa|ayuda|urgente|huele|luz)\b/g) ?? []);
const language = esWords.size >= 2 ? 'es' : 'en';

// Street address: house number + street name + street word (St, Ave, Rd ...), optional unit.
const SUFFIX = 'street|st|avenue|ave|boulevard|blvd|road|rd|drive|dr|lane|ln|court|ct|way|place|pl|circle|cir|parkway|pkwy|trail|trl|terrace|ter|highway|hwy';
const NOT_A_STREET_NAME = new Set(['in', 'the', 'of', 'my', 'and', 'at', 'is', 'are', 'to', 'a', 'on', 'for', 'we', 'i']);
const streetRe = new RegExp(`\\b(\\d{1,6})\\s+((?:[A-Za-z0-9.'-]+\\s+){0,3}?[A-Za-z0-9.'-]+)\\s+(?:${SUFFIX})\\b\\.?(?:,?\\s+(?:apt|unit|suite|ste|#)\\.?\\s*[A-Za-z0-9-]+)?`, 'gi');
let address = null;
let span = null;
for (const m of text.matchAll(streetRe)) {
  if (m[2].toLowerCase().split(/\s+/).some((w) => NOT_A_STREET_NAME.has(w))) continue;
  address = m[0].replace(/[.,]+$/, '');
  span = [m.index, m.index + m[0].length];
  break;
}

// City, state, ZIP right after the street ("Dallas TX 75201"); otherwise the last 5-digit number outside the street.
let city = null;
let state = null;
let zip = null;
const csz = /,?\s*([A-Z][A-Za-z.' -]{1,24}?),?\s+([A-Z]{2})\b,?\s*(\d{5})(?:-\d{4})?/.exec(span ? text.slice(span[1]) : text);
if (csz) {
  city = csz[1].trim();
  state = csz[2];
  zip = csz[3];
} else {
  const zips = [...text.matchAll(/\b(\d{5})(?:-\d{4})?\b/g)].filter((m) => !(span && m.index >= span[0] && m.index < span[1]));
  if (zips.length) zip = zips[zips.length - 1][1];
}

// Problem type. A gas smell is an urgency flag, not a "leak" job, so those words are removed before the type rules run.
const GAS = "\\b(smell(s|ed|ing)? (of |like )?(natural )?gas|gas (smell|odor|leak|leaking)|(natural )?gas is leaking|rotten eggs?|huele a gas|olor a gas|fuga de gas)\\b";
const hasGas = new RegExp(GAS).test(t);
const tNoGas = t.replace(new RegExp(GAS, 'g'), ' ');
const TYPES = [
  ['no heat', /\bno (heat|heating|hot air)\b|\bnot (heating|blowing hot)|\bheat(er|ing)? (is |has |isn'?t |won'?t |stopped |went )?(out|off|not working|broken|down|dead|quit)\b|\bfurnace\b|\bboiler\b|(?<!water )\bheater\b|calefaccion|no calienta|\b(house|home) is (freezing|cold)\b/],
  ['no cool', /\bno (cool|cold air|cooling|ac|a\/c)\b|\b(ac|a\/c|air condition(er|ing)?)\b|\bnot (cooling|blowing cold)|\bwarm air\b|\bblowing warm\b|aire acondicionado|no enfria|sin aire|\b(house|home) is (hot|warm)\b/],
  ['garage door', /\bgarage\b|garaje|\bopener\b|\boverhead door\b/],
  ['electrical', /\belectric(al|ian)?\b|\boutlets?\b|\bbreakers?\b|\bcircuit\b|\bno power\b|\bpower (is |went )?out\b|\bwiring\b|\bfuse\b|\bsparks?\b|\bsparking\b|\bpanel\b|corto circuito|apagon|sin luz/],
  ['leak', /\bleak(s|ing|ed|y)?\b|\bdrip(s|ping)?\b|\bflood(ed|ing|s)?\b|\bburst\b|\bpipes?\b|\bfaucet\b|\bsink\b|\btoilet\b|\bdrain\b|\bclog(ged)?\b|\bsewer\b|\bwater heater\b|\bwater (is )?(everywhere|pouring|coming|on the floor)\b|fuga de agua|gotea|inundacion|tuberia|plomer/],
];
const matched = TYPES.filter(([, re]) => re.test(tNoGas)).map(([name]) => name);
const problemType = matched[0] ?? 'other';

// Urgency: gas smell, carbon monoxide, flooding, smoke or fire, and "no heat" in the winter months from Config.
const winterMonths = String(cfg.winterMonths).split(',').map((s) => Number(s.trim()));
const winter = winterMonths.includes(localParts(now, cfg.businessTimezone).month);
const urgencyReasons = [];
if (hasGas) urgencyReasons.push('gas smell');
if (/carbon monoxide|\bco (alarm|detector)\b|monoxido/.test(t)) urgencyReasons.push('carbon monoxide');
if (/\bflood(ed|ing|s)?\b|\bburst (pipe|pipes)\b|\bpipe (burst|broke|is broken)\b|\bwater (is )?(everywhere|pouring|gushing|rushing)\b|inundacion|se inundo|tuberia rota/.test(t)) urgencyReasons.push('flooding');
if (/\bsmoke\b|\bon fire\b|\bfire\b|\bsparks?\b|\bsparking\b|burning smell|smells? (like )?(burning|smoke)|\bhumo\b|chispas|huele a quemado/.test(t)) urgencyReasons.push('smoke, fire or sparks');
if (problemType === 'no heat' && winter) urgencyReasons.push('no heat in winter');

return [{ json: {
  ...base, route: 'ok', from, to, text: text.slice(0, 400), language,
  address, city, state, zip, problemType, alsoMentioned: matched.slice(1),
  urgent: urgencyReasons.length > 0, urgencyReasons, missing: address ? [] : ['address'],
} }];
