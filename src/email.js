const { Resend } = require("resend");
const { format } = require("date-fns");

/**
 * Format an ISO timestamp as a readable date string, e.g. "Mar 31, 2026 at 2:45 PM".
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
 * Render a labelled field block: bold label on its own line, value below.
 * Safe for all screen widths.
 */
function field(label, valueHtml) {
  return `
    <div style="margin-bottom:10px; word-break:break-word; overflow-wrap:break-word;">
      <div style="font-size:11px; font-weight:bold; color:#888; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:2px;">${label}</div>
      <div style="font-size:14px; color:#333;">${valueHtml}</div>
    </div>`;
}

/**
 * Build note html: body text + "Added by X on Y" meta line.
 */
function noteHtml(note, fallback = "(none)") {
  if (!note || !note.body) return escapeHtml(fallback);

  const meta = [
    note.ownerName ? `Added by: ${note.ownerName}` : null,
    note.timestamp ? `on ${formatDate(note.timestamp)}` : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    `<span style="white-space:pre-wrap;">${escapeHtml(note.body)}</span>` +
    (meta ? `<br><span style="font-size:12px; color:#999;">${escapeHtml(meta)}</span>` : "")
  );
}

/**
 * Build note plain-text.
 */
function noteText(note, fallback = "(none)") {
  if (!note || !note.body) return fallback;
  const meta = [
    note.ownerName ? `Added by: ${note.ownerName}` : null,
    note.timestamp ? `on ${formatDate(note.timestamp)}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  return note.body + (meta ? `\n  [${meta}]` : "");
}

/**
 * Build plain-text and HTML versions of the weekly task email.
 */
function formatEmail(tasks, weekStart, weekEnd) {
  const weekRange = `${format(weekStart, "MMM d")} – ${format(weekEnd, "MMM d, yyyy")}`;

  if (tasks.length === 0) {
    const text = `No pending tasks due this week (${weekRange}).`;
    const html = `<p style="font-family:Arial,sans-serif;">${text}</p>`;
    return { subject: `Pending Tasks for the Week – ${weekRange}`, text, html };
  }

  const lines = [];
  const htmlParts = [];

  tasks.forEach((task, i) => {
    const num = i + 1;
    const contactName = task.contact?.name || "(none)";
    const companyName = task.company?.name || "(none)";
    const taskName = task.subject || "(no subject)";

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

    const emailValueHtml =
      `<strong style="font-size:14px;">${escapeHtml(emailSubject)}</strong><br>` +
      `<span style="font-size:12px; color:#999;">${escapeHtml(emailSender)} &nbsp;·&nbsp; ${escapeHtml(emailDate)}</span><br>` +
      `<span style="white-space:pre-wrap; font-size:13px;">${escapeHtml(emailBody)}</span>`;

    // Plain text
    lines.push(
      `Task ${num}`,
      `Contact Name: ${contactName}`,
      `Company Name: ${companyName}`,
      `Task Name: ${taskName}`,
      `Last Logged Note: ${noteText(task.lastNote, "(no note)")}`,
      `Ed's Note: ${noteText(task.edNote, "(none)")}`,
      `Last Logged Email`,
      `  Subject: ${emailSubject}`,
      `  From: ${emailSender}`,
      `  Date: ${emailDate}`,
      `  ${emailBody}`,
      ""
    );

    // HTML — stacked layout, no fixed-width columns
    htmlParts.push(`
      <div style="margin-bottom:20px; padding:14px 16px; border:1px solid #e0e0e0; border-radius:8px; font-family:Arial,sans-serif; box-sizing:border-box; width:100%;">
        <div style="font-weight:bold; font-size:15px; margin-bottom:12px; color:#111;">Task ${num}</div>
        ${field("Contact Name", escapeHtml(contactName))}
        ${field("Company Name", escapeHtml(companyName))}
        ${field("Task Name", escapeHtml(taskName))}
        ${field("Last Logged Note", noteHtml(task.lastNote, "(no note)"))}
        ${field("Ed's Note", noteHtml(task.edNote, "(none)"))}
        ${field("Last Logged Email", emailValueHtml)}
      </div>
    `);
  });

  const subject = `Pending Tasks for the Week – ${weekRange}`;
  const text = `Pending Tasks for the Week – ${weekRange}\n\n${lines.join("\n")}`;
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0; padding:0; background:#f5f5f5;">
  <div style="max-width:600px; margin:0 auto; padding:16px; box-sizing:border-box; width:100%;">
    <h2 style="font-family:Arial,sans-serif; font-size:18px; margin:0 0 20px 0; color:#111;">
      Pending Tasks for the Week – ${weekRange}
    </h2>
    ${htmlParts.join("")}
  </div>
</body>
</html>`;

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
