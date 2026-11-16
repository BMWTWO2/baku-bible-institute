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
