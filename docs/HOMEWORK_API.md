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
   student see the feedback and score, and the score is written to the gradebook. No email is sent.

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
