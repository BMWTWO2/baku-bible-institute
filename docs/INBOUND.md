# Inbound homework (WhatsApp and email)

Students can send written homework by WhatsApp or by email. It lands in the same
anytime homework pipeline as the website (`hw_submissions`): the scheduled
assistant translates and drafts it, and Bruce reviews it at `/admin/homework`.
The channel (Web, WhatsApp, or Email) is stored and shown on the homework list
and review page. **Nothing is ever auto-replied**, by email or by WhatsApp.

## WhatsApp

The webhook is already live: `GET/POST https://bakubibleinstitute.org/webhooks/whatsapp`.

When a message arrives from a phone number that matches an **active** student's
`whatsapp_phone`, and it looks like homework (contains *tapşırıq* / *ev tapşırığı*
/ *homework* / *esse* / *essay*, or is longer than 200 characters, or has an
image or document), a homework submission is created with `source=whatsapp`.

Assignment matching:

- If the text names exactly one assignment title or course code for that student, use it.
- Else if the student has exactly one open assignment (due date not yet passed, or no due date), use it.
- Otherwise the submission is filed with no assignment. On the review page, pick the assignment so the due date and late deduction can be applied.

Unknown numbers stay in `/admin/whatsapp` as before and are never auto-filed.
Other suggested actions (attendance, grades, new student) still wait for Apply.

Media: a reference (type, filename, Meta media id) is stored on the submission.
If `WHATSAPP_ACCESS_TOKEN` is set, the app also tries to download the file into
`data/media/` (gitignored; on Render's free disk this is lost at spin-down, so
the reference is what lasts).

### Connecting a Meta WhatsApp Cloud API number

This is **not enabled until** a Meta WhatsApp Business number is connected:

1. In the Meta Developer app, set the webhook URL to
   `https://bakubibleinstitute.org/webhooks/whatsapp` and the verify token to the
   same value as the Render env var `WHATSAPP_VERIFY_TOKEN`.
2. Set `WHATSAPP_APP_SECRET` on the Render service so `X-Hub-Signature-256` is checked.
3. Optionally set `WHATSAPP_ACCESS_TOKEN` (a permanent or long-lived system-user token)
   if you want inbound image/document files downloaded.

No WhatsApp message is ever sent by this app.

## Email

`POST https://bakubibleinstitute.org/api/inbound-email`

Auth: `Authorization: Bearer $INBOUND_EMAIL_TOKEN` (16+ characters; `503` if unset,
`401` without a valid token). JSON body:

```json
{ "from": "student@example.com", "subject": "THG 101 Romalılar 5", "text": "...", "html": "<p>...</p>", "attachments": [{ "filename": "esse.pdf", "mime": "application/pdf", "size": 12345 }] }
```

`from` is matched, case-insensitive, to an active student's `students.email` or
their login email. Subject + body use the same assignment-matching rules as WhatsApp.
Attachment *contents* are not stored; filenames and types are noted on the submission.

Unmatched senders are **not discarded**. They appear at `/admin/inbound`, where
an admin can file the message as homework for a chosen student, or dismiss it.
No reply is ever sent.

## Cloudflare Email Worker (homework@bakubibleinstitute.org)

The Worker lives in `cloudflare/inbound-email-worker/`. It receives mail via
Cloudflare Email Routing, parses it with `postal-mime`, and POSTs to the endpoint
above. It never replies or forwards.

Email Routing and Workers are on Cloudflare's free tier. **Do not start a paid
plan.** Enabling Email Routing adds **MX and TXT (SPF)** records only. It must
never change the **A or CNAME** records that point the website at Render
(`bakubibleinstitute.org` A → Render, `www` CNAME → `baku-bible-institute.onrender.com`).

As of this writing the domain has **no MX records**, so adding Cloudflare's mail
MX/TXT would not replace an existing mailbox. Re-check `MX` and apex `TXT` before
enabling, and abort if someone else's mail is already hosted there.

### Deploy steps (needs a Cloudflare login)

These cannot be run from this box until `wrangler login` (or `CLOUDFLARE_API_TOKEN`)
succeeds. The Cloudflare connector in this workspace also still needs to be signed in.

1. Sign in: from the `cloudflare/inbound-email-worker` folder run
   `npx wrangler login`, or set a token with Email Routing and Workers edit permission.
2. Install and dry-run:
   ```bash
   cd cloudflare/inbound-email-worker
   npm install
   npx wrangler deploy --dry-run
   ```
3. Deploy the Worker (free plan is fine):
   ```bash
   npx wrangler deploy
   ```
4. Put the same inbound token already set on Render into the Worker as a secret
   (paste it when prompted; do not put it in the repo or in `wrangler.jsonc`):
   ```bash
   npx wrangler secret put INBOUND_EMAIL_TOKEN
   ```
5. Enable Email Routing for `bakubibleinstitute.org` **only after reviewing the
   DNS preview**. Use either:
   - Dashboard: Compute → Email Service → Email Routing → Onboard Domain.
     Accept **only MX and TXT (SPF/DKIM)** additions. Do not edit A or CNAME records.
   - CLI: `npx wrangler email routing enable bakubibleinstitute.org`
     (confirm the planned records are MX/TXT only).
6. Route **only** `homework@bakubibleinstitute.org` to this Worker. Do not add a
   catch-all. Either:
   - Leave `"addresses": ["homework@bakubibleinstitute.org"]` in `wrangler.jsonc`
     and redeploy (Wrangler will create that one rule), or
   - Dashboard: Routing Rules → Create → `homework` @ `bakubibleinstitute.org`
     → Send to a Worker → `bbi-inbound-email`.
   CLI equivalent (flag names can change; check `npx wrangler email routing rules create --help`):
   ```bash
   npx wrangler email routing rules create bakubibleinstitute.org \
     --match-type=literal --match-field=to \
     --match-value="homework@bakubibleinstitute.org" \
     --action-type=worker --action-value=bbi-inbound-email
   ```
7. Confirm DNS after enabling:
   - `MX bakubibleinstitute.org` should show Cloudflare's `*.mx.cloudflare.net` records.
   - A records for `bakubibleinstitute.org` should still be Render (`216.24.57.16` / `216.24.57.18`).
   - `www` should still be a CNAME to `baku-bible-institute.onrender.com`.
8. Test by sending a message from a test address to `homework@bakubibleinstitute.org`.
   A matching student should appear under Homework; any other sender should appear
   under `/admin/inbound`. No auto-reply should be sent.

`INBOUND_EMAIL_TOKEN` must also be set on the Render service `baku-bible-institute`
(this is a merge, not a replacement of other env vars). A local copy is kept in the
gitignored file `.bbi_inbound_email_token`.
