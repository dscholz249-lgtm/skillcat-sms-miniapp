const cron = require('node-cron');
const { sendSMS } = require('./twilio');

const REMINDER_MESSAGE =
  "Hi, it's SkillCat! Just wanted to check in and see if there were any updates for any of your techs.";

async function fetchManagersForReminder(preference) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.warn('[reminders] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set — skipping');
    return [];
  }

  const qs = new URLSearchParams({
    reminder_preference: `eq.${preference}`,
    phone: 'not.is.null',
    select: 'id,name,phone',
  });

  const res = await fetch(`${url}/rest/v1/managers?${qs}`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
  });

  if (!res.ok) {
    console.error('[reminders] Supabase query failed', res.status, await res.text());
    return [];
  }

  return res.json();
}

async function sendReminders(preference) {
  const managers = await fetchManagersForReminder(preference).catch(err => {
    console.error('[reminders] fetch error', err);
    return [];
  });

  if (managers.length === 0) {
    console.log(`[reminders] no ${preference} managers to notify`);
    return;
  }

  console.log(`[reminders] sending ${preference} reminders to ${managers.length} manager(s)`);

  for (const m of managers) {
    try {
      await sendSMS(m.phone, REMINDER_MESSAGE);
      console.log(`[reminders] sent to ${m.name} (${m.phone})`);
    } catch (err) {
      console.error(`[reminders] failed for ${m.name}`, err.message);
    }
  }
}

function initReminders() {
  const tz = process.env.REMINDER_TIMEZONE || 'America/Chicago';

  // Daily at 5 pm
  cron.schedule('0 17 * * *', () => sendReminders('daily'), { timezone: tz });

  // Weekly — Fridays at 5 pm
  cron.schedule('0 17 * * 5', () => sendReminders('weekly'), { timezone: tz });

  console.log(`[reminders] scheduled (tz: ${tz})`);
}

module.exports = { initReminders };
