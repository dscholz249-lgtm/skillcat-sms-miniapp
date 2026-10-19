const { requestLinkUrl } = require('./request-link');

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

// A plain mrkdwn link rather than a Block Kit button: this is an incoming
// webhook with no interactivity endpoint, and URL buttons still ping one.
function requestLinkBlock(url) {
  return {
    type: 'section',
    text: { type: 'mrkdwn', text: `<${url}|Mark complete →>` },
  };
}

// #experiment-notifications: every request also goes there spelled out — what
// kind it is, what to do, and a link — with an @-mention so it pings. A second
// incoming webhook; skipped if unset. Mention by member ID: `<@U…>` is the
// only mention form webhooks honour.
const EXPERIMENT_WEBHOOK_URL = process.env.SLACK_EXPERIMENT_WEBHOOK_URL?.trim() || null;
const MENTION_USER_ID = process.env.SLACK_MENTION_USER_ID?.trim() || 'U0B65LV46MA';

function dashboardUrl() {
  const raw = process.env.LOGBOOK_PUBLIC_URL || process.env.NEXTJS_URL;
  return raw ? `${raw.replace(/\/$/, '')}/dashboard` : null;
}

// The "Request" kind of the Logbook's experiment notifications. Same layout as
// experimentPayload() in skillcat-technician-logbook/lib/slack.ts, which sends
// Urgent and Interest Requests.
function experimentNotification(type, payload, managerPhone, managerInfo, linkUrl) {
  const manager = managerLabel(managerInfo, managerPhone);
  const managerName = managerInfo?.name || managerPhone || 'The manager';
  const link = linkUrl
    ? { url: linkUrl, label: 'Open the request' }
    : dashboardUrl() && { url: dashboardUrl(), label: 'Open the Logbook dashboard' };

  if (type === 'assign_training') {
    return {
      subject: `Training assignment · ${payload.employee_name || 'unknown employee'}`,
      fields: [['Employee', payload.employee_name], ['Course', payload.certification_name], ['Manager', manager]],
      todo: `${managerName} asked for ${payload.employee_name || 'an employee'} to be assigned ` +
        `*${payload.certification_name || 'a course'}*. Enroll them in that course on the SkillCat platform, ` +
        `then click *Mark complete*, which texts ${managerName} to confirm.`,
      link,
    };
  }
  if (type === 'add_employee') {
    const detail = [payload.email, payload.title].filter(Boolean).join(' · ');
    const company = managerInfo?.company_name ? `${managerInfo.company_name}'s` : 'their';
    return {
      subject: `New employee · ${payload.name || 'unnamed'}`,
      fields: [['Name', payload.name], ['Details', detail], ['Manager', manager]],
      todo: `${managerName} asked to add ${payload.name || 'someone'} to ${company} roster. ` +
        `Add them in the Logbook dashboard, then click *Mark complete*, which texts ${managerName} to confirm.`,
      link,
    };
  }
  if (type === 'human_review') {
    return {
      subject: `Needs review · ${managerName}`,
      fields: [['Message', payload.raw ? `"${payload.raw}"` : null], ['Manager', manager]],
      todo: `The SMS bot couldn't work out what ${managerName} wanted. Read the message and follow up ` +
        `with them, then click *Mark complete* (texts them) or *Ignore* (no text).`,
      link,
    };
  }
  return {
    subject: type,
    fields: [['Manager', manager]],
    todo: 'Open the request in the Logbook dashboard and handle it.',
    link,
  };
}

function experimentPayload(n) {
  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: `<@${MENTION_USER_ID}> :pencil: *Request* · ${n.subject}` } },
    { type: 'section', fields: n.fields.map(([label, value]) => field(label, value)) },
    { type: 'section', text: { type: 'mrkdwn', text: `*What to do*\n${n.todo}` } },
  ];
  if (n.link) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `<${n.link.url}|${n.link.label} →>` } });
  }
  // Top-level text drives the push notification and the mention.
  return { text: `<@${MENTION_USER_ID}> Request: ${n.subject}`, blocks };
}

async function post(url, payload) {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    console.error('[slack] webhook failed', e.message);
  }
}

// Posts to #logbook-requests in the original format and, when configured, to
// #experiment-notifications in the spelled-out one. One signed link serves both.
async function notifySlack(type, payload, managerPhone, managerInfo, queueId) {
  const linkUrl = requestLinkUrl(queueId);
  const sends = [];

  if (WEBHOOK_URL) {
    const blocks = buildBlocks(type, payload, managerPhone, managerInfo);
    if (linkUrl) blocks.push(requestLinkBlock(linkUrl));
    sends.push(post(WEBHOOK_URL, { blocks }));
  }
  if (EXPERIMENT_WEBHOOK_URL) {
    sends.push(post(
      EXPERIMENT_WEBHOOK_URL,
      experimentPayload(experimentNotification(type, payload, managerPhone, managerInfo, linkUrl)),
    ));
  }
  await Promise.all(sends);
}

module.exports = { notifySlack, experimentNotification, experimentPayload };
