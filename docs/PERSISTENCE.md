# Keeping BBI data across restarts

**Why data is lost today:** the Render service runs on the *free* web plan, which has no persistent disk;
its filesystem is wiped on every restart, redeploy and spin-down (after ~15 min idle). The SQLite file lives
at `data/bbi.sqlite` on that ephemeral disk, and the start command is `npm run seed && npm start`, where
`seed` deletes the file and recreates demo staff/classes plus `BBI_EXTRA_USERS`. (`render.yaml` describes a
1 GB disk at `/data`, but the live service is not managed by that blueprint and free services cannot have disks.)

**Durable mode (one env var):** set `DATABASE_URL` to a Postgres connection string. Then
- `npm run seed` restores the newest saved copy of the whole database (students, roster, enrollments,
  grades, attendance, assignments, homework, WhatsApp inbox, audit log) instead of wiping it;
  if Postgres is unreachable it fails the boot rather than start blank;
- the server saves a compressed snapshot to table `bbi_snapshots` ~2 s after every change and on shutdown;
- the last 30 snapshots are kept (`BBI_SNAPSHOT_KEEP`) as a rolling archive / undo history.
Without `DATABASE_URL` nothing changes. `/healthz` shows `"durable": true|false`.
