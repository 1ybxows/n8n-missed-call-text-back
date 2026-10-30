// Builds the job card: the Slack message (Block Kit, with Assign and Call back buttons) and the row for the jobs sheet.
const m = $input.first().json;
const LABEL = { 'no heat': 'No heat', 'no cool': 'No cooling (A/C)', 'garage door': 'Garage door', electrical: 'Electrical', leak: 'Leak / plumbing', other: 'Other / not sure' };
const problem = LABEL[m.problemType] ?? 'Other / not sure';
const place = [m.address, m.city, [m.state, m.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
const addressLine = m.address ? place : (m.zip ? `address missing (ZIP ${m.zip})` : 'address missing');
const tag = m.urgent ? '🚨 URGENT' : (m.isUpdate ? '🔄 UPDATE' : '🆕 New job');
const reasons = m.urgencyReasons.join(', ');
// Urgent cards lead with the reason ("Gas smell"), not the job type; the type follows when it adds information.
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const what = m.urgent ? cap(reasons) + (m.problemType !== 'other' && !/no heat/.test(reasons) ? ` - ${problem}` : '') : problem;

const slack = {
  text: `${tag}: ${what} | ${addressLine} | ${m.from}`,
  blocks: [
    { type: 'header', text: { type: 'plain_text', text: `${tag} - ${what}`, emoji: true } },
    { type: 'section', fields: [
      { type: 'mrkdwn', text: `*Customer*\n${m.from}` },
      { type: 'mrkdwn', text: `*Job*\n${m.jobId}` },
      { type: 'mrkdwn', text: `*Address*\n${addressLine}` },
      { type: 'mrkdwn', text: `*ZIP*\n${m.zip ?? 'not given'}` },
    ] },
    ...(m.urgent ? [{ type: 'section', text: { type: 'mrkdwn', text: `*Why urgent:* ${reasons}. Call this customer first.` } }] : []),
    { type: 'section', text: { type: 'mrkdwn', text: `> ${m.message.slice(0, 1500)}` } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `Language: ${m.language === 'es' ? 'Spanish' : 'English'} | Received ${m.receivedAt}` }] },
    { type: 'actions', block_id: `job_${m.jobId}`, elements: [
      { type: 'button', text: { type: 'plain_text', text: 'Assign' }, style: 'primary', action_id: 'assign_job', value: m.jobId },
      { type: 'button', text: { type: 'plain_text', text: 'Call back' }, ...(m.urgent ? { style: 'danger' } : {}), action_id: 'call_back', value: m.from },
    ] },
  ],
};

const sheetRow = {
  job_id: m.jobId, created_at: m.receivedAt, status: m.isUpdate ? 'Updated' : 'New', priority: m.urgent ? 'URGENT' : 'Normal',
  phone: m.from, address: m.address ? place : '', zip: m.zip ?? '', problem_type: m.problemType,
  urgency: reasons, language: m.language, message: m.message,
};
return [{ json: { ...m, slack, sheetRow } }];
