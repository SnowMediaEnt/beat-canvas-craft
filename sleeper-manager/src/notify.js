// Sends the email that tells you what the bot did, or what it thinks you
// should do. If email is not configured the report is printed instead, so
// nothing is ever silently lost.
import nodemailer from 'nodemailer';
import { config, emailConfigured } from './config.js';

const escape = (value) =>
  String(value ?? '').replace(/[&<>"]/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch],
  );

const points = (value) => (Number(value) || 0).toFixed(1);

function renderHtml({ title, subtitle, sections }) {
  const blocks = sections
    .map((section) => {
      const rows = section.rows
        .map(
          (row) => `
        <tr>
          <td style="padding:10px 12px;border-bottom:1px solid #eceff3;">${escape(row.label)}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #eceff3;color:#4a5568;">${escape(row.value)}</td>
        </tr>`,
        )
        .join('');

      return `
      <h2 style="font:600 15px system-ui,sans-serif;color:#1a202c;margin:26px 0 8px;">
        ${escape(section.heading)}
      </h2>
      ${section.note ? `<p style="font:13px system-ui,sans-serif;color:#718096;margin:0 0 10px;">${escape(section.note)}</p>` : ''}
      ${
        section.rows.length > 0
          ? `<table style="width:100%;border-collapse:collapse;font:13px system-ui,sans-serif;">${rows}</table>`
          : '<p style="font:13px system-ui,sans-serif;color:#a0aec0;margin:0;">Nothing to report.</p>'
      }`;
    })
    .join('');

  return `<!doctype html><html><body style="margin:0;background:#f7f8fa;padding:24px;">
  <div style="max-width:620px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;">
    <h1 style="font:700 20px system-ui,sans-serif;color:#1a202c;margin:0 0 4px;">${escape(title)}</h1>
    <p style="font:13px system-ui,sans-serif;color:#718096;margin:0;">${escape(subtitle)}</p>
    ${blocks}
    <p style="font:12px system-ui,sans-serif;color:#a0aec0;margin:28px 0 0;border-top:1px solid #eceff3;padding-top:14px;">
      Sent by your Sleeper manager bot. Open the Sleeper app to undo anything you disagree with.
    </p>
  </div></body></html>`;
}

const renderText = ({ title, subtitle, sections }) =>
  [
    title,
    subtitle,
    '',
    ...sections.flatMap((section) => [
      section.heading,
      ...(section.note ? [section.note] : []),
      ...(section.rows.length > 0
        ? section.rows.map((row) => `  ${row.label}  —  ${row.value}`)
        : ['  Nothing to report.']),
      '',
    ]),
  ].join('\n');

export async function sendReport(report) {
  const text = renderText(report);

  if (!emailConfigured()) {
    console.log(`\n${text}\n(Email is not configured, so this was printed instead.)`);
    return { sent: false };
  }

  const transport = nodemailer.createTransport({
    host: config.email.host,
    port: config.email.port,
    secure: config.email.secure,
    auth: { user: config.email.user, pass: config.email.pass },
  });

  await transport.sendMail({
    from: `"Sleeper Bot" <${config.email.user}>`,
    to: config.email.to,
    subject: report.title,
    text,
    html: renderHtml(report),
  });

  return { sent: true };
}

/** Turns lineup changes into report rows. */
export const lineupRows = (changes) =>
  changes.map((change) => ({
    label: `${change.slot}: start ${change.in?.name ?? 'nobody'}`,
    value:
      `out ${change.out?.name ?? 'empty'}` +
      `${change.out?.status ? ` (${change.out.status})` : ''}` +
      ` · +${points(change.gain)} pts`,
  }));

/** Turns waiver recommendations into report rows. */
export const waiverRows = (claims) =>
  claims.map((claim) => ({
    label: `Add ${claim.add.name} (${claim.add.position} ${claim.add.team})`,
    value:
      `drop ${claim.drop?.name ?? 'nobody'} · bid $${claim.bid} of $${claim.faabRemaining}` +
      ` · ${claim.add.adds.toLocaleString()} adds today`,
  }));

export { points };
