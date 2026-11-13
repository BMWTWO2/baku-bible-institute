# Baku Bible Institute (BBI)
Separate system from the Maryland Bible College CMS: its own roster and SQLite DB. Tracks students, attendance, grades and homework with feedback in Azerbaijani (az), with WhatsApp intake and helper bots.

## Run
```
npm install
npm run seed:demo   # LOCAL ONLY: wipes + loads FICTIONAL demo data
npm run seed        # production boot step: never wipes, never adds sample data
PORT=3050 npm start # http://localhost:3050  · health: /healthz
npm run shots       # optional Playwright screenshots → screenshots/
```
Stack: Node 20+, Express 5, EJS, better-sqlite3, express-session, bcryptjs. Schema: `db/schema.sql`. Config: `.env.example`.

## Demo setup
One teacher, **Pastor Bruce Wright** (bruce@baku-bible.example), and two classes (Payız 2026). Set `SEED_SAMPLE_STUDENTS=false` to seed only staff and classes, with no fictional students, enrollments, grades, attendance, or homework.
- **THG 101 Theology of Grace** · Lütf İlahiyyatı
- **ECC 101 Body Life** · Body Life

## Areas
- `/` public homepage · `/login`
- Admin: `/admin` dashboard, `/admin/students` roster (flags), `/admin/classes`, `/admin/attendance` (Sentinel flags: >2 unexcused; excused never count), `/admin/gradebook`, `/admin/homework` (Draft Azeri correction → edit → approve), `/admin/whatsapp`, `/admin/bots`, `/admin/report` (+ `.json`)
- Teacher: classes, attendance, grades, homework review
- Student (Azerbaijani): `/telebe` — dərslər, iştirak, qiymətlər, ev tapşırıqları, müəllim rəyi

## Bots
Shepherd (at-risk: attendance <75% or avg <70%), Steward (sections ≥90% full), Herald (WhatsApp pending > HERALD_HOURS, applicants), Scribe (missing grades past due), Watchman (data integrity), Sentinel (>2 unexcused absences per class), Homework Helper (Azeri drafts for professor approval), Chronicler (weekly report). Bots only suggest; admins apply.

Homework Helper: with `OPENAI_API_KEY` it asks an LLM for Azerbaijani feedback; without one it produces a deterministic draft clearly labeled **NÜMUNƏ / SAMPLE**. Students see nothing until a teacher approves.

## WhatsApp
Endpoint: `GET/POST /webhooks/whatsapp`
- Verify: Meta calls `GET ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`; we echo the challenge when the token equals `WHATSAPP_VERIFY_TOKEN`.
- Inbound: Meta Cloud API `whatsapp_business_account` payloads, or test JSON `{"from":"+99455…","name":"Aysel","text":"…"}`.
- Each message is stored (number, name, body, time, raw JSON), linked to a student by phone, and given a suggested action (create student / mark attendance / record grade / file homework) that an admin applies or dismisses in `/admin/whatsapp`.
- Security: set `WHATSAPP_APP_SECRET` to verify `X-Hub-Signature-256`. With `DEMO_MODE=false` and no app secret, posts need header `x-bbi-token: <VERIFY_TOKEN>`.

### Connecting real WhatsApp later
1. Meta for Developers → create an app → add **WhatsApp** product; use a WhatsApp Business number (a personal WhatsApp app chat cannot be read by a webhook; the number must be registered on the WhatsApp Business Platform / Cloud API, or forward messages to it).
2. Deploy BBI at a public HTTPS URL (e.g. Render).
3. WhatsApp → Configuration → Webhook: callback `https://<host>/webhooks/whatsapp`, verify token = your `WHATSAPP_VERIFY_TOKEN`; subscribe to `messages`.
4. Set `WHATSAPP_APP_SECRET`, `DEMO_MODE=false`, a strong `SESSION_SECRET`, and real admin passwords. No live credentials are included here.

## Homework (anytime submission, late deductions, Bruce approval)
See `docs/HOMEWORK_API.md`. Admin: `/admin/assignments`, `/admin/homework`. Student: `/telebe` → «Tapşırıqlarım». Test: `node test/homework-e2e.mjs` against a local demo server.

## Grades
`/admin/gradebook`: add graded items (exams, quizzes…) with max points and weight; per-student points and a comment the
student sees; per-class weighted averages and final course grades (`/admin/gradebook/class/:id`, also on each student page).
Students see averages, comments and final grades in their kabinet.

## Email outbox
`/admin/outbox`: every email (new-assignment notices and returned-homework notices, in Azeri) is queued as **pending** and
is sent only when Bruce clicks Send / Send all, and only if `EMAIL_SENDING_ENABLED=true`. Provider: SendGrid HTTPS API
(`SENDGRID_API_KEY`, `EMAIL_FROM`, `EMAIL_FROM_NAME`, `EMAIL_REPLY_TO`). "Check mail credential" validates the key without sending.

## Persistence
SQLite lives in `data/`; on Render's free tier the disk is wiped on every restart. Set `DATABASE_URL` (Postgres) to turn on durable snapshots of the whole database — see `docs/PERSISTENCE.md`.
