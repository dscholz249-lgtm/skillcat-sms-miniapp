const WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

function field(label, value) {
  return { type: 'mrkdwn', text: `*${label}*\n${value || '—'}` };
}

function managerLabel(managerInfo, managerPhone) {
  if (!managerInfo) return managerPhone || 'unknown';
  const parts = [managerInfo.name];
  if (managerInfo.company_name) parts.push(managerInfo.company_name);
  return parts.join(' · ');
}

function buildBlocks(type, payload, managerPhone, managerInfo) {
  const manager = managerLabel(managerInfo, managerPhone);

  if (type === 'assign_training') {
    return [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: ':pencil: *New training request*' },
      },
      {
        type: 'section',
        fields: [
          field('Employee', payload.employee_name),
          field('Course', payload.certification_name),
          field('Manager', manager),
        ],
      },
    ];
  }

  if (type === 'add_employee') {
    const detail = [payload.name, payload.email, payload.title].filter(Boolean).join(' · ');
    return [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: ':busts_in_silhouette: *New employee request*' },
      },
      {
        type: 'section',
        fields: [
          field('Details', detail),
          field('Manager', manager),
        ],
      },
    ];
  }

  if (type === 'human_review') {
    return [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: ':warning: *Request needs review*' },
      },
      {
        type: 'section',
        fields: [
          field('Raw message', payload.raw ? `"${payload.raw}"` : null),
          field('Manager', manager),
        ],
      },
    ];
  }

  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `:bell: *New request: ${type}*\nFrom: ${manager}` },
    },
  ];
}

async function notifySlack(type, payload, managerPhone, managerInfo) {
  if (!WEBHOOK_URL) return;
  try {
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocks: buildBlocks(type, payload, managerPhone, managerInfo) }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    console.error('[slack] webhook failed', e.message);
  }
}

module.exports = { notifySlack };
