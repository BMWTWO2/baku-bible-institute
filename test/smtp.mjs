// SMTP provider selection + approval-only behaviour, with nodemailer stubbed (no network). Run: node test/smtp.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const require = createRequire(import.meta.url);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbi-smtp-'));
process.env.DB_PATH = path.join(dir, 'bbi.sqlite'); delete process.env.DATABASE_URL; process.env.NODE_ENV = 'production';
const nm = require('nodemailer'); const sent = []; let opts = null, verified = 0, failVerify = false;
nm.createTransport = o => { opts = o; return { sendMail: async m => { sent.push(m); }, verify: async () => { verified++; if (failVerify) throw new Error('535 bad creds'); return true; } }; };
const outbox = require('../src/outbox');
for (const k of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SENDGRID_API_KEY']) delete process.env[k];
process.env.EMAIL_FROM = 'sender@test.invalid'; process.env.EMAIL_FROM_NAME = 'Baku Bible Institute';
assert.equal(outbox.cfg().hasKey, false);
process.env.SMTP_HOST = 'smtp.gmail.com'; process.env.SMTP_USER = 'sender@test.invalid'; process.env.SMTP_PASS = 'abcd efgh ijkl mnop';
assert.equal(outbox.cfg().hasKey, true); assert.equal(outbox.cfg().provider, 'smtp');
process.env.EMAIL_SENDING_ENABLED = 'false';
const id = outbox.queue({ to: 'who@test.invalid-not', name: 'Test', subject: 'S', text: 'T' });
// 1) switch off -> nothing sent
assert.equal((await outbox.send(id, 'admin')).ok, false); assert.equal(sent.length, 0);
assert.equal((await outbox.sendTransactional({ to: 'a@b.co', subject: 's', text: 't' })).ok, false); assert.equal(sent.length, 0);
// 2) switch on -> send path uses SMTP with spaces stripped, port 465 secure, From name
process.env.EMAIL_SENDING_ENABLED = 'true';
assert.equal((await outbox.send(id, 'admin')).ok, true);
assert.equal(sent.length, 1); assert.equal(opts.auth.pass, 'abcdefghijklmnop'); assert.equal(opts.port, 465); assert.equal(opts.secure, true); assert.equal(opts.host, 'smtp.gmail.com');
assert.deepEqual(sent[0].from, { name: 'Baku Bible Institute', address: 'sender@test.invalid' }); assert.equal(sent[0].subject, 'S');
assert.equal(outbox.counts().sent, 1);
// 3) transactional path
assert.equal((await outbox.sendTransactional({ to: 'a@b.co', subject: 'R', text: 'X' })).ok, true); assert.equal(sent.length, 2);
// 4) verify
assert.equal((await outbox.verify()).ok, true); failVerify = true;
const v = await outbox.verify(); assert.equal(v.ok, false); assert.ok(!v.detail.includes('abcdefgh'));
console.log('smtp tests passed');
process.exit(0);
