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
    `Got it — is this for ${candidates.map((c, i) => `${i + 1}. ${c.name}`).join(" or ")}? Reply with a number.`,
  EMPLOYEE_NOT_FOUND: (name) =>
    `Logged for ${name}. Note: they're not in the roster yet — a team member will verify within the hour.`,
  HELP:
    `SkillCat Logbook. Text requests like: "Assign John the HVAC cert", "Add Mike Torres mike@co.com technician", or "John passed the refrigerant module today". Msg & data rates may apply. Reply STOP to opt out.`,
};

module.exports = { COPY };
