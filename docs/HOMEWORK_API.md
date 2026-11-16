# Homework workflow and assistant API

## Flow (nothing reaches a student without Bruce)
1. **Student submits** (`/telebe`, section «Tapşırıqlarım») — any time, never blocked. Either for an
   assignment (`POST /telebe/tapsiriq/:assignmentId`) or as free homework (`POST /telebe/tapsiriq`).
   Status: `submitted`. Late work is recorded with minutes late and the assignment's deduction %.
2. **Draft**: an English translation (when the work is in Azeri) and an English correction draft are added
   → status `drafted`. Done by the built-in AI only if `OPENAI_API_KEY` is set; otherwise by a scheduled
   assistant through the API below.
3. **Bruce edits and approves** at `/admin/homework` → `/admin/homework/anytime/:id`: edits the English
   correction, enters the raw score (late deduction applied automatically; final score can be overridden),
   ticks "I have reviewed and edited", clicks **Approve** → `approved_by_bruce`. He can withdraw approval.
4. **Azeri return**: Bruce's approved English is translated into Azeri → `returned`. Only now does the
   student see the feedback and score, and the score is written to the gradebook. An Azeri email notice is queued
   in `/admin/outbox` and is sent only if Bruce clicks Send there.

## Assignments and late policy
`/admin/assignments` (admin/teacher): class, Azeri title, instructions, **due date + time in Baku time
(Asia/Baku, UTC+4)**, max points, late policy. Creating an assignment also creates its gradebook item.
Late policy text `hours:percent`, default `24:5, 72:10, 168:20, *:30` — up to 24h late −5% of max points,
up to 3 days −10%, up to 7 days −20%, beyond −30% (cap). Final = max(0, raw − deduction) unless Bruce overrides.

## API (for the scheduled assistant)
Auth: `Authorization: Bearer $HOMEWORK_API_TOKEN` (server env var, at least 16 characters; 503 if unset).
JSON in, JSON out. Base: `https://bakubibleinstitute.org/api/homework`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/status` | counts per status, `builtInAi`, `durable` |
| GET | `/needs-draft` | `{items:[…]}` with status `submitted` (id, course_code, title, lang, body, due/late info) |
| POST | `/:id/draft` | body `{translation_en, draft_en, by?}`; `translation_en` required when `lang` is `az`. 409 once Bruce has approved |
| GET | `/needs-azeri` | `{items:[…]}` with status `approved_by_bruce`, including Bruce's `final_en` and `final_score` |
| POST | `/:id/return` | body `{return_az, by?}`. **Refused (409) unless status is `approved_by_bruce`.** Sets `returned` |

Items carry only the student's first name, never email or phone.

### What a scheduled routine does
1. `GET /needs-draft`; for each item translate `body` to English (if `lang` is `az`) and write a short,
   warm, personal correction in English for Bruce to edit; `POST /:id/draft`.
2. `GET /needs-azeri`; for each item translate `final_en` faithfully into warm, simple Azerbaijani (Latin
   script), adding nothing; `POST /:id/return`.

## Flags API (scheduled helper-bot check)

Read-only. Auth is the same bearer token as the homework API (`Authorization: Bearer $HOMEWORK_API_TOKEN`).
`401` without a valid token, `503` if the token is unset. No writes; nothing is changed in the database.

`GET https://bakubibleinstitute.org/api/flags`

Returns every helper bot's current findings (`runAll()`: shepherd, steward, herald, scribe, watchman, sentinel, helper):

```json
{
  "checked_at": "2026-11-14T12:00:00.000Z",
  "bots": {
    "steward": {
      "name": "Steward",
      "watches": "Class capacity: sections at 90%+ or over capacity.",
      "count": 1,
      "items": [{ "text": "THG 101 Theology of Grace: 18/20 seats", "link": "https://bakubibleinstitute.org/admin/classes" }]
    }
  }
}
```

Links are absolute (`https://bakubibleinstitute.org…`). Phone numbers in item text (for example Watchman's duplicate-phone flags) are replaced with `a duplicate number`.

## Assignment portal: lesson → five questions → three answers → review → overview

Nothing here reaches a student automatically. A lesson's assignment is a **draft** until Bruce clicks **Publish**
on `/admin/lessons/:id`; feedback still goes through the approve → Azeri return flow above. No paid AI service
is called by the site: the scheduled assistant writes everything through these endpoints (same bearer token,
base `https://bakubibleinstitute.org/api/homework`). Items carry the student's first name only.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/lessons?status=` | all lessons (optional status filter) |
| POST | `/lessons` | create from Pocket/pasted text: `{course_code, title, title_az?, session_date (Baku YYYY-MM-DD), source:"pocket"\|"paste", source_ref, source_text, summary_en?, summary_az?, outline?, by?}`. Deduplicated by class + source + source_ref (returns `existed:true`) |
| GET | `/lessons/needs-summary` | lessons waiting for a summary (Bruce added them on `/admin/lessons`, or "Rewrite summary") — includes `source_text`, `source_ref` (Pocket title to fetch when `source_text` is empty) and the class notes for that course |
| POST | `/lessons/:id/summary` | `{summary_en, summary_az, outline, title?, title_az?, by?}` → `needs_questions` |
| GET | `/lessons/needs-questions` | lessons waiting for questions (includes summary + outline) |
| POST | `/lessons/:id/questions` | `{questions:[{en, az}×5], instructions_az?, by?}` → creates/updates the **draft** assignment (30 pts, choose 3) → `draft_ready`. 409 once published. `publish_test:true` works only for the TEST 000 class |
| GET | `/lessons/:id` | one lesson with questions |
| GET | `/needs-review` | five-question submissions waiting for review: student `body`, `lang`, `answers_split` (site's first-pass split by question number; may be empty or wrong), `questions`, `choose_n`, `points_per_question`, `lesson.summary_en`, `lesson.outline`, `lesson.class_note` |
| POST | `/:id/review` | `{answers:[{question, answer_text, answer_en (required unless the work is English), correction_en, content_en, alignment:"strong"\|"partial"\|"weak", score:1–5, points?}], note_en, draft_en?, translation_en?, by?}`. `answers` is authoritative (it replaces the site's split). Points default to `points_per_question × score ÷ 5`. Sets status `drafted` (Bruce edits/approves as usual). 409 after Bruce approves |
| GET | `/needs-report` | reviewed submissions not yet reported to Bruce: full overview + ready-to-send `message_md` + `admin_url` |
| POST | `/:id/reported` | mark one overview as delivered to Bruce (so it is not repeated) |
| GET | `/overview/:id`, `/assignments/:id/overview` | one submission / every submission of an assignment |

`/needs-draft` no longer lists five-question submissions (they are in `/needs-review`).

### What the scheduled routine does (every run)
1. **Summaries.** `GET /lessons/needs-summary`. For each: if `source_text` is empty and `source` is `pocket`, fetch the Pocket
   summary by its exact title (`node scripts/pocket-lesson.mjs --title "<source_ref>"` on the box). Write a clear class summary in
   simple English for Azeri ESL students, the same summary in warm, simple Azerbaijani (Latin script), and a numbered class outline
   of the key points (for grading). `POST /lessons/:id/summary`.
   *Optional, after each class:* `node scripts/pocket-lesson.mjs --list "Baku Bible Institute"`; for a new BBI recording, pick the class
   (ECC 101 Body Life or THG 101 Theology of Grace) and run `--title "<title>" --course "<code>" --post` (or `POST /lessons`).
2. **Questions.** `GET /lessons/needs-questions`. For each, write five discussion/essay questions from the summary and outline
   (English + warm Azerbaijani, Latin script). `POST /lessons/:id/questions`. They stay a draft until Bruce publishes.
3. **Reviews.** `GET /needs-review`. For each item: decide which questions the student answered (use `answers_split` as a hint; read
   `body`), translate each answer to English if needed, and for each answer write `correction_en` (grammar and clarity, gentle),
   `content_en` (accuracy against `lesson.outline` and `lesson.summary_en`), `alignment` and `score` (1–5). Add a one-line `note_en`
   for Bruce and, optionally, a warm student-facing `draft_en` in English ending "Thank you, and God bless you." / "Pastor Bruce Wright".
   `POST /:id/review`. If a student answered more or fewer than three, review what is there; the site flags it.
4. **Report to Bruce.** `GET /needs-report`; send each item's `message_md` (with its `admin_url`) to Bruce in the Grok Bot chat,
   then `POST /:id/reported`. Never message students.
5. Keep doing the existing `/needs-draft` and `/needs-azeri` steps.

### How WhatsApp and email answers reach the same assignment
Email (`/api/inbound-email`) and WhatsApp (`/webhooks/whatsapp`) are matched to the student by address/number, then to their only
open, **published** assignment (or one named in the subject/text). Drafts are never matched. Students number their answers
("1)", "3.", "Sual 5:", "5-ci sual", "Question 2", "#4"); the site splits by those numbers. Short numbered WhatsApp messages count
as homework when the student has an open five-question assignment, and further messages/emails within 3 days are merged into the
same not-yet-reviewed submission. Unknown senders still go to `/admin/inbound`, where Bruce files them to a student.
