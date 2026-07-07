const WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

function field(label, value) {
  return { type: 'mrkdwn', text: `*${label}*\n${value || '—'}` };
}

function buildBlocks(type, payload, managerPhone) {
  const phone = managerPhone || 'unknown';

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
          field('Manager', phone),
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
          field('Manager', phone),
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
          field('Manager', phone),
        ],
      },
    ];
  }

  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `:bell: *New request: ${type}*\nFrom: ${phone}` },
    },
  ];
}

async function notifySlack(type, payload, managerPhone) {
  if (!WEBHOOK_URL) return;
  try {
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocks: buildBlocks(type, payload, managerPhone) }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    console.error('[slack] webhook failed', e.message);
  }
}

module.exports = { notifySlack };
