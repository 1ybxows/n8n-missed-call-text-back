// The texts back to the customer: ask for the address, or confirm the job (with safety words when it is urgent).
const cfg = $('Config').first().json;
const m = $('Dedupe & Merge').first().json;
const name = cfg.businessName;
const es = m.language === 'es';
const reasons = m.urgencyReasons;
let body;

if (m.route === 'ask_info') {
  body = es
    ? `${name}: ¡Gracias! Para enviar a un técnico necesitamos la dirección completa (calle y número) y el código postal. Por favor responda con ellos.`
    : (m.asks > 1
      ? `${name}: Sorry, we still need the street address to send a technician. Please reply with it, for example "123 Main St, Dallas TX 75201".`
      : `${name}: Thanks! To send a technician we need your street address and ZIP code. Please reply with them.`);
} else {
  const job = m.jobId;
  const safety = [];
  if (reasons.includes('gas smell') || reasons.includes('carbon monoxide')) {
    safety.push(es
      ? 'Si huele a gas o suena la alarma de monóxido de carbono, salga de la casa ahora y llame al 911 o a la línea de emergencia de la compañía de gas. No use interruptores ni teléfonos dentro.'
      : "If you smell gas or a carbon monoxide alarm is sounding, leave the building now and call 911 or your gas company's emergency line. Do not use light switches or phones inside.");
  }
  if (reasons.includes('flooding')) {
    safety.push(es ? 'Si puede hacerlo con seguridad, cierre la llave principal del agua. Si hay peligro, llame al 911.' : 'If it is safe, shut off the main water valve. If anyone is in danger, call 911.');
  }
  if (reasons.includes('smoke, fire or sparks')) {
    safety.push(es ? 'Si hay humo o fuego, saque a todos de la casa y llame al 911.' : 'If there is smoke or fire, get everyone out and call 911.');
  }
  const askAddress = m.addressMissing ? (es ? ' Por favor responda con su dirección y código postal.' : ' Please reply with your street address and ZIP code.') : '';
  let lead;
  if (m.isUpdate) lead = es ? `Gracias, recibimos la dirección (trabajo ${job}). Un técnico le llamará pronto.` : `Thanks, we got the address (job ${job}). A technician will call you back shortly.`;
  else if (m.urgent) lead = es ? `Marcamos su solicitud como URGENTE (trabajo ${job}) y estamos avisando a un técnico ahora.` : `We marked your request URGENT (job ${job}) and a technician is being alerted now.`;
  else lead = es ? `Gracias, recibimos su solicitud (trabajo ${job}). Un técnico le llamará pronto.` : `Thanks, we have your request (job ${job}). A technician will call you back shortly.`;
  body = `${name}: ${[lead + askAddress, ...safety].join(' ')}`;
}

return [{ json: { ...m, sms: { from: m.to, to: m.from, body, tag: m.route === 'ask_info' ? 'ask-address' : 'confirmation' } } }];
