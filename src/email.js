const { Resend } = require("resend");
const { format } = require("date-fns");

/**
 * Format an ISO timestamp as a readable date string, e.g. "Mar 31, 2026 at 2:45 PM".
 * Returns empty string if timestamp is falsy.
 */
function formatDate(timestamp) {
  if (!timestamp) return "";
  try {
    return format(new Date(timestamp), "MMM d, yyyy 'at' h:mm a");
  } catch {
    return "";
  }
}

/**
 * Build a note's display lines: body text + "Added by X on Y" meta line.
 */
function noteLines(note, fallback = "(none)") {
  if (!note || !note.body) return { text: fallback, html: escapeHtml(fallback) };

  const meta = [
    note.ownerName ? `Added by: ${note.ownerName}` : null,
    note.timestamp ? `on ${formatDate(note.timestamp)}` : null,
  ]
    .filter(Boolean)
    .join(" ");

  const text = note.body + (meta ? `\n  [${meta}]` : "");
  const html =
    `<span style="white-space:pre-wrap;">${escapeHtml(note.body)}</span>` +
    (meta
      ? `<br><span style="font-size:12px;color:#888;">${escapeHtml(meta)}</span>`
      : "");

  return { text, html };
}

/**
 * Build plain-text and HTML versions of the weekly task email.
 * @param {Array} tasks - Array of enriched task objects
 * @param {Date}  weekStart
 * @param {Date}  weekEnd
 */
function formatEmail(tasks, weekStart, weekEnd) {
  const weekRange = `${format(weekStart, "MMM d")} – ${format(weekEnd, "MMM d, yyyy")}`;

  if (tasks.length === 0) {
    const text = `No pending tasks due this week (${weekRange}).`;
    const html = `<p>${text}</p>`;
    return { subject: `Pending Tasks for the Week – ${weekRange}`, text, html };
  }

  const lines = [];
  const htmlParts = [];

  tasks.forEach((task, i) => {
    const num = i + 1;
    const contactName = task.contact?.name || "(none)";
    const companyName = task.company?.name || "(none)";
    const taskName = task.subject || "(no subject)";

    const lastNoteDisplay = noteLines(task.lastNote, "(no note)");
    const edNoteDisplay = noteLines(task.edNote, "(none)");

    // Last logged email fields
    const email = task.lastEmail;
    const emailSubject = email?.subject || "(none)";
    const emailBody = email?.body || "(none)";
    const emailSender = [
      email?.senderName,
      email?.senderEmail ? `<${email.senderEmail}>` : null,
    ]
      .filter(Boolean)
      .join(" ") || "(unknown)";
    const emailDate = email?.timestamp ? formatDate(email.timestamp) : "(unknown)";

    // Plain text
    lines.push(
      `Task ${num}`,
      `Contact Name: ${contactName}`,
      `Company Name: ${companyName}`,
      `Task Name: ${taskName}`,
      `Last Logged Note: ${lastNoteDisplay.text}`,
      `Ed's Note: ${edNoteDisplay.text}`,
      `Last Logged Email`,
      `  Subject: ${emailSubject}`,
      `  From: ${emailSender}`,
      `  Date: ${emailDate}`,
      `  ${emailBody}`,
      ""
    );

    // HTML
    htmlParts.push(`
      <div style="margin-bottom:24px; padding:16px; border:1px solid #e0e0e0; border-radius:6px; font-family:Arial,sans-serif;">
        <p style="margin:0 0 8px 0; font-weight:bold; font-size:15px;">Task ${num}</p>
        <table style="border-collapse:collapse; width:100%;">
          <tr>
            <td style="padding:4px 8px 4px 0; color:#555; width:160px; vertical-align:top;">Contact Name</td>
            <td style="padding:4px 0;">${escapeHtml(contactName)}</td>
          </tr>
          <tr>
            <td style="padding:4px 8px 4px 0; color:#555; vertical-align:top;">Company Name</td>
            <td style="padding:4px 0;">${escapeHtml(companyName)}</td>
          </tr>
          <tr>
            <td style="padding:4px 8px 4px 0; color:#555; vertical-align:top;">Task Name</td>
            <td style="padding:4px 0;">${escapeHtml(taskName)}</td>
          </tr>
          <tr>
            <td style="padding:4px 8px 4px 0; color:#555; vertical-align:top;">Last Logged Note</td>
            <td style="padding:4px 0;">${lastNoteDisplay.html}</td>
          </tr>
          <tr>
            <td style="padding:4px 8px 4px 0; color:#555; vertical-align:top;">Ed's Note</td>
            <td style="padding:4px 0;">${edNoteDisplay.html}</td>
          </tr>
          <tr>
            <td style="padding:4px 8px 4px 0; color:#555; vertical-align:top;">Last Logged Email</td>
            <td style="padding:4px 0;">
              <strong>${escapeHtml(emailSubject)}</strong><br>
              <span style="font-size:12px;color:#888;">From: ${escapeHtml(emailSender)} &nbsp;|&nbsp; ${escapeHtml(emailDate)}</span><br>
              <span style="white-space:pre-wrap; font-size:13px;">${escapeHtml(emailBody)}</span>
            </td>
          </tr>
        </table>
      </div>
    `);
  });

  const subject = `Pending Tasks for the Week – ${weekRange}`;

  const text = `Pending Tasks for the Week – ${weekRange}\n\n${lines.join("\n")}`;

  const html = `
    <!DOCTYPE html>
    <html>
    <body style="font-family:Arial,sans-serif; max-width:700px; margin:0 auto; padding:24px; color:#333;">
      <h2 style="margin-bottom:24px;">Pending Tasks for the Week – ${weekRange}</h2>
      ${htmlParts.join("")}
    </body>
    </html>
  `;

  return { subject, text, html };
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Send the formatted email via Resend.
 */
async function sendEmail(subject, html, text) {
  const resend = new Resend(process.env.RESEND_API_KEY);

  const { data, error } = await resend.emails.send({
    from: process.env.EMAIL_FROM,
    to: process.env.EMAIL_TO,
    subject,
    html,
    text,
  });

  if (error) {
    throw new Error(`Resend error: ${JSON.stringify(error)}`);
  }

  return data;
}

module.exports = { formatEmail, sendEmail };
