const { PostHog } = require('posthog-node');

const client = process.env.POSTHOG_API_KEY
  ? new PostHog(process.env.POSTHOG_API_KEY, {
      host: process.env.POSTHOG_HOST || 'https://us.i.posthog.com',
      flushAt: 1,
      flushInterval: 0,
    })
  : null;

if (!client) console.warn('[analytics] POSTHOG_API_KEY not set — tracking disabled');

function capture(distinctId, event, properties = {}) {
  if (!client || !distinctId) return;
  client.capture({ distinctId, event, properties });
}

function identify(distinctId, properties = {}) {
  if (!client || !distinctId) return;
  client.identify({ distinctId, properties });
}

module.exports = { capture, identify };
