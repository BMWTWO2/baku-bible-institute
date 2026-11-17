# Homepage enrollment form (this week only)

A temporary form on the public homepage (`/#qeydiyyat`) collects name, telephone, optional WhatsApp (only if different from the phone), and class choice: Theology of Grace (THG 101) and/or Body Life (ECC 101).

It stays visible until **Sunday, 22 November 2026, 23:59 Baku time (UTC+4)**. After that instant the form hides itself and `POST /enroll` is rejected with a friendly closed message. No redeploy is needed — the close time is `ENROLLMENT_CLOSES_AT` (ISO-8601, default `2026-11-22T23:59:59+04:00`).

## What a submission does
- Saves an `enrollment_requests` row (`source` = `homepage form`, `notified` starts as 0).
- Creates a roster record (name, phone, WhatsApp) **with no login or password**. If the model ever needs email/password they stay empty; the instructor creates a login later on the student page.
- Enrolls the student in each selected class that still has a seat (capacity 20). A full class is **not** over-enrolled; the request is flagged `class full — needs review`.
- If a student with the same (normalized) phone already exists, no duplicate is created. The selected classes are added (when seats remain) and the request is flagged `existing student`.
- Nothing is emailed or sent on WhatsApp.

Admin review: `/admin/enrollments` (admin only). The student page has a **Create login** form when `user_id` is empty so they can later sign in and scan QR attendance.

Watchman will flag students with no login yet. If a WhatsApp number is missing, Watchman may also flag that. Shepherd may flag them later if attendance or grades go missing.

## API (for the Grok Bot chat notification)
Auth: `Authorization: Bearer $HOMEWORK_API_TOKEN` (same token as the homework and flags APIs; 16+ characters; 503 if unset). JSON in, JSON out. Base: `https://bakubibleinstitute.org`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/enrollments?unnotified=1` | `{ items: [...], close_at, open }` — pending requests the chat bot has not yet notified Bruce about. Omit the query (or use `unnotified=0`) to list all. Each item includes `id`, `created_at`, `source`, `name`, `phone`, `whatsapp_phone`, `classes`, `enrolled`, `full`, `student_id`, `existing_student`, `review_flag`, `notified`. |
| POST | `/api/enrollments/:id/notified` | Marks that request as notified (`notified=1`). Idempotent. |
| POST | `/api/enrollments/:id/discard` | Removes a request. A **new** student created by that request is also removed, along with the sections it added, only if they still have no login and no class activity. An **existing** student is kept; only enrollments this request newly added (and only if they still have no activity) are undone. |

Do not send email or WhatsApp from this API. Notify Bruce in the Grok Bot chat, then `POST` notified.


# QR self-enrollment

A first-time student who scans a **live** weekly class QR code and is not signed in can enroll themselves. This is not tied to the homepage form close date — it works whenever that week's token is valid.

The sign-in page (`/login?next=/qeyd/<token>`) keeps the “sign in once” line for students who already have a login, and offers a prominent **Yeniyəm — qeydiyyatdan keç** button. That opens `/qeyd/<token>/qeydiyyat` (name, email, WhatsApp, optional note). Rate-limited, honeypot-protected, and de-duplicated by email + token. An email that already has a login is told to sign in instead.

A successful submit:

- Saves an `enrollment_requests` row (`source` = `QR self-enroll · <CODE> · week <n>`, `via` in the API = `qr`, `review_status` = `pending`, `notified` starts as 0 so `GET /api/enrollments?unnotified=1` picks it up).
- Adds a roster record if needed and enrolls them in that class.
- Records attendance for that session as present, source `qr-pending`. This does **not** count toward the attendance grade and is **never** turned into an automatic absence.
- Shows a confirmation: “Təşəkkür edirik! Qeydiyyatınız qəbul olundu. Bu dərsdə iştirakınız qeyd olundu. Pastor Bruce tezliklə sizə giriş məlumatlarınızı göndərəcək.”

Admin review: `/admin/enrollments`.

- **Approve** creates a student login (if they do not already have one) and converts the pending mark to a regular QR present. The site does **not** email the temporary password. It is stored for the welcome-email routine (see below).
- **Reject** drops the pending attendance mark.

## Welcome-email API (temporary passwords)

When any student login is created (QR approve, or the “Create login” form on the student page), a row is stored in `login_welcomes`. The plaintext temporary password is available only through the token API below. It is never shown on admin pages, never logged, and never emailed by the site. The scheduled Grok Bot routine `bbi-new-student-login-welcome-email` should send the Azeri welcome email.

Auth: same Bearer token as the other APIs (`HOMEWORK_API_TOKEN`).

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/logins/welcome?pending=1` | `{ items: [...] }` — new logins not yet marked as emailed. Each item includes `id`, `student_id`, `user_id`, `email`, `name`, `temp_password`, `source`, `created_at`. Omit `pending=1` to list all (including already emailed). |
| POST | `/api/logins/welcome/:id/sent` | Marks that row as emailed (`emailed_at` set). Idempotent. |

Do not send email from the website. After the routine sends the welcome message, `POST` sent.
