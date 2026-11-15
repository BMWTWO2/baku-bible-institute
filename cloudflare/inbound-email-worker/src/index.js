// Receives mail for homework@bakubibleinstitute.org and posts it to BBI.
// NEVER reply, forward, or auto-acknowledge.
import PostalMime from 'postal-mime';

export default {
  async email(message, env) {
    const raw = await new Response(message.raw).arrayBuffer();
    const parsed = await PostalMime.parse(raw);
    const from = parsed.from?.address || message.from;
    const subject = parsed.subject || message.headers.get('subject') || '';
    const text = parsed.text || '';
    const html = parsed.html || '';
    const attachments = (parsed.attachments || []).map(a => ({
      filename: a.filename || 'attachment',
      mime: a.mimeType || '',
      size: a.content ? a.content.byteLength || a.content.length : 0
    }));
    const token = env.INBOUND_EMAIL_TOKEN;
    const url = env.BBI_INBOUND_URL || 'https://bakubibleinstitute.org/api/inbound-email';
    if (!token) throw new Error('INBOUND_EMAIL_TOKEN is not set');
    const r = await fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ from, subject, text, html: html || undefined, attachments })
    });
    if (!r.ok) throw new Error('BBI inbound-email HTTP ' + r.status);
  }
};
