// Turns an n8n failure into one Slack alert and one log line. Always carries the execution id.
const e = $('Error Trigger').first().json;
const exec = e.execution ?? {};
const wf = e.workflow ?? {};
const id = exec.id ?? 'unknown (manual test run)';
const step = exec.lastNodeExecuted ?? exec.error?.node?.name ?? 'unknown step';
const error = String(exec.error?.message ?? 'unknown error').slice(0, 300);
const when = new Date().toISOString();
const link = exec.url ? `<${exec.url}|Open this run in n8n>` : 'n8n -> Executions -> find this id';

const alert = {
  text: `⚠️ Automation failed: ${wf.name ?? 'unknown workflow'} (execution ${id})`,
  blocks: [
    { type: 'header', text: { type: 'plain_text', text: '⚠️ Automation failed', emoji: true } },
    { type: 'section', fields: [
      { type: 'mrkdwn', text: `*Workflow*\n${wf.name ?? 'unknown'}` },
      { type: 'mrkdwn', text: `*Failed step*\n${step}` },
      { type: 'mrkdwn', text: `*Execution ID*\n${id}` },
      { type: 'mrkdwn', text: `*Time*\n${when}` },
    ] },
    { type: 'section', text: { type: 'mrkdwn', text: `*What went wrong*\n${error}` } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `The customer may not have been texted. ${link}` }] },
  ],
};
const logLine = `${when} ALERT workflow="${wf.name ?? 'unknown'}" step="${step}" execution=${id} error="${error}"`;
return [{ json: { alert, logLine, executionId: id } }];
