// Message catalog — LOCKED per build spec §5. Resolve {tech}/{first}/etc at send.

const firstName = (full) => (full || '').split(/\s+/)[0] || full || '';
const joinNames = (names) => {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
};

const COPY = {
  BATCH_SINGLE: (tech) =>
    `Is ${tech} ready to run service calls on their own?`,
  BATCH_MULTI: (n, names) =>
    `SkillCat: You've got ${n} ride-along reviews from today — ${joinNames(names)}. Who do you want to start with?`,
  READINESS_AFTER_SELECTION: (tech) =>
    `${tech} — ready to run service calls on their own?`,
  ECHO_NOTE_READY: (tech) =>
    `Got it, ${firstName(tech)}'s marked ready. Anything to note? Reply with a note, or say skip.`,
  ECHO_NOTE_NOT_READY: (tech) =>
    `Got it — not yet for ${firstName(tech)}. What would help them get there? Reply with a note, or say skip.`,
  SAVED_MORE: (remainingNames) =>
    `Saved. Still have ${joinNames(remainingNames)} — who's next?`,
  SAVED_SINGLE: (tech) =>
    `Saved to ${firstName(tech)}'s record. Thanks.`,
  BATCH_COMPLETE: (n) =>
    `That's all ${n} done. Thanks!`,
  NO_SESSION:
    `No open reviews right now. You'll get a text when there's a ride-along to review.`,
  UNCLEAR_SELECTION: (remainingNames) =>
    `I didn't catch that — you've got ${joinNames(remainingNames)} left. Who first?`,
  UNCLEAR_VERDICT: (tech) =>
    `Just to confirm — is ${firstName(tech)} ready to work solo? Reply yes or no.`,
  AMBIGUOUS_NAME: (a, b) =>
    `Did you mean ${a} or ${b}?`,
  HELP:
    `SkillCat ride-along reviews. Reply a technician's name and whether they're ready (yes/no). Msg & data rates may apply. Reply STOP to opt out.`,
};

module.exports = { COPY, firstName, joinNames };
