const COPY = {
  CONFIRM_ASSIGN: (emp, cert) =>
    `Got it — I’ll assign the ${cert} to ${emp}. Someone on the team will action this shortly.`,
  CONFIRM_ADD: (name) =>
    `Got it — adding ${name} to the team. Someone will confirm and action this shortly.`,
  CONFIRM_NOTE: (emp) =>
    `Logged for ${emp}. Thanks.`,
  CLARIFY_MISSING_CERT: (emp) =>
    `Which certification should I assign to ${emp}?`,
  CLARIFY_GENERAL:
    `I didn’t catch that. Try: “Assign John the HVAC cert”, “Add Mike Torres mike@co.com technician”, or “John finished the refrigerant module today”.`,
  FALLBACK:
    `I couldn’t parse that one — a team member will follow up. Reply HELP for usage examples.`,
  EMPLOYEE_NOT_FOUND: (name) =>
    `${name} isn’t in the roster yet — I’ll flag this and a team member will confirm within the hour.`,
  HELP:
    `SkillCat Logbook. Text requests like: “Assign John the HVAC cert”, “Add Mike Torres mike@co.com technician”, or “John passed the refrigerant module today”. Msg & data rates may apply. Reply STOP to opt out.`,
};

module.exports = { COPY };
