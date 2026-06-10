# SkillCat SMS Mini-App

A standalone service that runs the **SMS ride-along review** conversation over
Twilio. Receives a batch of reviews, texts opted-in managers, parses their
natural-language replies with Claude (Haiku 4.5), and writes results back to
the SkillCat platform (the mock, for testing).

This app owns: Twilio transport, the conversation state machine, the NL parse
layer, and transient session state. It does **not** own review records or
to-dos — those live in the platform. If this app's DB is wiped, no records of
value are lost.

## Run locally

```bash
npm install
cp .env.example .env
# fill in the Twilio + Anthropic + platform values
npm start
# open http://localhost:3000   (launcher)
# open http://localhost:3000/debug  (sessions + message log)
```

Without `TWILIO_MESSAGING_SERVICE_SID`, outbound SMS logs to stdout (handy
for early dev). Without `ANTHROPIC_API_KEY`, every non-fast-path reply parses
as "unclear" and triggers a re-prompt.

## Deploy to Railway

1. `gh repo create … && git push -u origin main` (or connect this repo through
   the Railway dashboard).
2. Set the env vars from [`.env.example`](.env.example) in the Railway service.
3. After the first deploy, copy Railway's public HTTPS URL into:
   - `PUBLIC_BASE_URL` (used to validate Twilio webhook signatures)
   - Twilio Console → Messaging Service → **Inbound Settings → webhook URL**:
     `{PUBLIC_BASE_URL}/twilio/inbound` (HTTP POST)
4. In Twilio Messaging Service settings, enable **Advanced Opt-Out** so
   STOP/HELP are handled at the carrier/Twilio layer.

The app binds `0.0.0.0:$PORT`, uses `Procfile`, and runs on Node 18+.

## Architecture (one screen)

```
   ┌────────────────────────┐   GET /api/ride-along/roster
   │  Test Launcher (GET /) │───────────────────┐
   └─────────┬──────────────┘                   │
             │ POST /test/start-batch           ▼
   ┌─────────▼──────────────┐         ┌──────────────────┐
   │ Conversation engine    │◀───────▶│ Platform (mock)  │
   │   - startBatch         │  REST   │   /review-batch  │
   │   - handleInbound (sm) │         │   /reviews/{id}  │
   └─────────┬────┬─────────┘         │   /result        │
             │    │                   └──────────────────┘
       NL    │    │ Twilio (REST out / webhook in)
      parse  │    ▼
  ┌──────────▼─┐ ┌──────────────────┐
  │ Anthropic  │ │ Twilio Messaging │
  │ Haiku 4.5  │ │ Service          │
  └────────────┘ └──────────────────┘
```

State lives in SQLite (`miniapp.db`, recreated if absent — single worker only):

- `sessions` — one row per `manager_phone`. Fields: pending review IDs (JSON),
  current review, held readiness verdict, state-machine step, original count.
- `message_log` — every inbound/outbound, with parsed JSON + step transitions.
  Used by `/debug`.

## State machine (locked)

- **Single review:**
  `SENT → AWAITING_READINESS → AWAITING_NOTE → COMPLETE`
- **Multi review:**
  `BATCH_SENT → AWAITING_SELECTION → AWAITING_READINESS → AWAITING_NOTE →`
  (loop back to `AWAITING_SELECTION` while pending remain) `→ ALL_COMPLETE`

**Write timing.** The platform `/result` endpoint is single-write (409 on a
second attempt). The app holds `readiness` in session state, echoes it back,
asks for a note, and writes the full result once at the note/skip step. A
manager who gives a verdict then ghosts leaves the review pending; no expiry.

**Cross-channel skip.** Before composing any selection or "who's next" prompt,
the app refreshes pending reviews via `GET /reviews/{id}` and drops any already
`complete`. After a selection, the app re-checks the selected review is still
pending before asking its readiness question. Result writes that 409 are
treated as already-done, never surfaced to the manager.

## NL parse layer

Every inbound goes through a deterministic fast-path first:

- `STOP` / `HELP` (compliance) — handled inline
- bare `skip` / `done`
- bare yes/no synonyms when step is `AWAITING_READINESS`
- exact (case-insensitive) single-name match when step is `AWAITING_SELECTION`

Otherwise Claude Haiku 4.5 produces a strict JSON object:

```
{intent, tech_id, readiness, note, confidence}
```

with `intent ∈ select_tech | give_verdict | give_note | skip | done | unclear`.
Compound replies (name+verdict, or verdict+note) collapse the next prompt.

On API error/timeout, invalid JSON, `confidence: low`, or `intent: unclear`:
re-prompt for the current step. **Never write on unclear input.**

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET  | `/`                 | Test launcher UI |
| GET  | `/api/roster`       | Roster proxy (launcher only) |
| POST | `/test/start-batch` | `{pairs: [{manager_id, technician_id}]}` → batch summary |
| POST | `/twilio/inbound`   | Twilio webhook — validates `X-Twilio-Signature`, replies empty TwiML |
| GET  | `/debug`            | Sessions + message log, auto-refresh |
| GET  | `/api/debug/state`  | Same data as JSON |
| GET  | `/health`           | `{ok: true}` |

## Acceptance checklist

- [ ] Launcher loads roster; **Send All** creates reviews/To-Dos (visible in the mock debug panel).
- [ ] SMS-eligible managers get texts; app-only managers do not.
- [ ] **Single tech:** readiness → yes/no → note/skip → "Saved"; result shows on the tech's Person Detail in the mock.
- [ ] **Multi tech:** heads-up list → name selection → readiness → note → "who's next" loop → "all done".
- [ ] **Compound reply** ("Tony's good to go") collapses selection + verdict.
- [ ] **Ambiguous/unclear reply** re-prompts once and writes nothing.
- [ ] **Echo-back** appears on every verdict.
- [ ] **Cross-channel skip:** mark a pending review complete in the mock debug panel mid-batch → the app skips it (no text about that tech).
- [ ] **STOP/HELP** handled.
- [ ] **Idempotency:** re-send same `batch_id` → no duplicate reviews (mock enforces).

## Out of scope

- Polished admin composer (lives in the dashboard prototype, served by the mock).
- Real-platform service auth + iframe context token (TODO when pointed off the mock — see `lib/platform.js`).
- Session expiry (deferred).
- Customer.io routing (platform's broader comms architecture).
