// The instant text. One wording during business hours, one after hours.
const cfg = $('Config').first().json;
const call = $input.first().json;
const name = cfg.businessName;

const body = call.afterHours
  ? `${name}: Sorry we missed your call. Our office is closed right now. Reply with your address and the problem, and a technician will call you back first thing in the morning. If it is an emergency (gas smell, flooding, fire), call 911.`
  : `${name}: Sorry we missed your call. Reply with your address and the problem, and a technician will call you back.`;

return [{ json: { ...call, sms: { from: call.to, to: call.from, body, tag: call.afterHours ? 'missed-call-after-hours' : 'missed-call' } } }];
