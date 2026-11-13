# Keeping BBI data across restarts

**Why data is lost today:** the Render service runs on the *free* web plan, which has no persistent disk;
its filesystem is wiped on every restart, redeploy and spin-down (after ~15 min idle). The SQLite file lives
at `data/bbi.sqlite` on that ephemeral disk. (Until Nov 2026 the start command's `npm run seed` also deleted the
file on every boot; `seed` is now non-destructive.) (`render.yaml` describes a
1 GB disk at `/data`, but the live service is not managed by that blueprint and free services cannot have disks.)

**Durable mode (one env var):** set `DATABASE_URL` to a Postgres connection string. Then
- `npm run seed` restores the newest saved copy of the whole database (students, roster, enrollments,
  grades, attendance, assignments, homework, WhatsApp inbox, audit log) instead of wiping it;
  if Postgres is unreachable it fails the boot rather than start blank;
- the server saves a compressed snapshot to table `bbi_snapshots` ~2 s after every change and on shutdown;
- the last 30 snapshots are kept (`BBI_SNAPSHOT_KEEP`) as a rolling archive / undo history.
Without `DATABASE_URL` nothing changes. `/healthz` shows `"durable": true|false`.

**Boot (`npm run seed`, then `npm start`):** never wipes and never creates sample data. It restores the saved copy,
ensures the admin, Pastor Bruce Wright, THG 101 Theology of Grace and ECC 101 Body Life exist, removes leftover
fictional demo rows once, and adds accounts from `BBI_EXTRA_USERS` (only missing ones). Local demo data:
`npm run seed:demo` (wipes; refuses in production or with `DATABASE_URL`).

**Test accounts:** `BBI_TEST_USERS` (same JSON as `BBI_EXTRA_USERS`, emails must end in `@test.invalid`) puts test
students in a separate `TEST 000` class so real students never see test work. When the variable is cleared, the
next boot removes those accounts, their homework, queued emails and the TEST class.

Production: `DATABASE_URL` points at a separate `bbi` database in the existing free Neon project (1 GB storage and
100 CU-hours/month shared with that project; scales to zero when idle).
