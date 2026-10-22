function naturalList(names) {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

const COPY = {
  CONFIRM_ASSIGN: (emp, cert) =>
    `Got it — I'll assign the ${cert} to ${emp}. Someone on the team will action this shortly.`,
  CONFIRM_ADD: (name) =>
    `Got it — adding ${name} to the team. Someone will confirm and action this shortly.`,
  // Self-serve course assignment (PRD-436)
  ASSIGN_TO_TECH: (manager, course, link) =>
    `${manager} has assigned you ${course} on SkillCat: ${link}`,
  ASSIGN_DONE: (emp, course, channels) =>
    `Done — ${emp} has been assigned ${course}. I sent them the course link by ${channels}.`,
  // Self-serve add-technician flow (PRD-438)
  ADD_ASK_EMAIL: (name) =>
    `OK, let's add ${name}. What's their email address? (Reply NO if you don't have one.)`,
  ADD_ASK_EMAIL_AGAIN: (name) =>
    `That doesn't look like an email address. What's ${name}'s email? Reply NO to add them without one.`,
  ADD_EMAIL_TAKEN: (email, name) =>
    `${email} is already in use on the Logbook. Reply with a different email for ${name}, or NO to add them without one.`,
  ADD_ASK_INVITE: (name) =>
    `Added ${name}. Do you want me to send an invite so they can link their phone and learn how to use the Logbook? (Yes/No)`,
  ADD_INVITE_SENT: (name, email) =>
    `OK, I've sent an invitation to ${name} at ${email}.`,
  ADD_INVITE_FAILED: (name) =>
    `${name} is added, but I couldn't send the invite. You can send it from the Technicians page in the Logbook.`,
  ADD_NO_INVITE: (name) =>
    `OK, ${name} is added. You can send them an invite anytime from the Technicians page in the Logbook.`,
  ADD_DONE_NO_EMAIL: (name) =>
    `OK, I've added ${name}. You can add their email and send an invite later from the Technicians page in the Logbook.`,
  CONFIRM_NOTE: (emp) =>
    `Logged for ${emp}. Thanks.`,
  CLARIFY_MISSING_CERT: (emp) =>
    `Which certification should I assign to ${emp}?`,
  CLARIFY_GENERAL:
    `I didn't catch that. Try: "Assign John the HVAC cert", "Add Mike Torres mike@co.com technician", or "John finished the refrigerant module today".`,
  FALLBACK:
    `I couldn't parse that one — a team member will follow up. Reply HELP for usage examples.`,
  // Replies to a broadcast are answers to a person, not commands. Telling
  // someone who just replied "thanks, will do" that we couldn't parse them
  // reads as a machine failure; this acknowledges them instead.
  BROADCAST_ACK:
    `Thanks — got it. Someone on the team will follow up.`,
  CLARIFY_NAME: (candidates) =>
    `Got it — is this for ${candidates.map((c, i) => `${i + 1}. ${c.name}`).join(' or ')}? Reply with a number.`,
  CLARIFY_COURSE: (courses) =>
    `Which course? ${courses.map((c, i) => `${i + 1}. ${c.name}`).join(' or ')}? Reply with a number.`,
  EMPLOYEE_NOT_FOUND: (name) =>
    `Logged for ${name}. Note: they're not in the roster yet — a team member will verify within the hour.`,
  HELP:
    `SkillCat Logbook. Text requests like: "Assign John the HVAC cert", "What HVAC courses are available?", "Add Mike Torres mike@co.com", or "John passed the refrigerant module". Reply STOP to opt out.`,
  CATALOG_RESULTS: (courses) => {
    const MAX = 5;
    const shown = courses.slice(0, MAX);
    const rest = courses.length - shown.length;
    const list = naturalList(shown.map(c => c.name));
    const suffix = rest > 0 ? ` (+${rest} more — try a more specific search).` : '.';
    return `SkillCat has ${list}${suffix}`;
  },
  CATALOG_EMPTY: (query) =>
    `No courses found matching "${query}". Try different keywords or reply HELP for examples.`,
  ACTIONED_ASSIGN: (emp, cert) =>
    `Update: ${emp} has been enrolled in ${cert}. Reply with any other requests.`,
  ACTIONED_ADD: (name) =>
    `Update: ${name} has been added to your roster. Reply with any other requests.`,
  ACTIONED_GENERIC:
    `Update: your request has been completed. Reply with any other requests.`,
};

module.exports = { COPY };
