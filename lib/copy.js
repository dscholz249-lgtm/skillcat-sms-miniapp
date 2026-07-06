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
  CONFIRM_NOTE: (emp) =>
    `Logged for ${emp}. Thanks.`,
  CLARIFY_MISSING_CERT: (emp) =>
    `Which certification should I assign to ${emp}?`,
  CLARIFY_GENERAL:
    `I didn't catch that. Try: "Assign John the HVAC cert", "Add Mike Torres mike@co.com technician", or "John finished the refrigerant module today".`,
  FALLBACK:
    `I couldn't parse that one — a team member will follow up. Reply HELP for usage examples.`,
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
};

module.exports = { COPY };
