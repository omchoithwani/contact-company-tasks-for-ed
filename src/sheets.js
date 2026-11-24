const axios = require("axios");
const { formatInTimeZone } = require("date-fns-tz");
const { format } = require("date-fns");

const TZ = "America/New_York";

function formatDateOnly(timestamp) {
  if (!timestamp) return "";
  try {
    return formatInTimeZone(new Date(timestamp), TZ, "EEE, MMM d, yyyy");
  } catch {
    return "";
  }
}

function formatDateTime(timestamp) {
  if (!timestamp) return "";
  try {
    return formatInTimeZone(new Date(timestamp), TZ, "MMM d, yyyy 'at' h:mm a zzz");
  } catch {
    return "";
  }
}

function taskUrl(taskId) {
  const portalId = process.env.HUBSPOT_PORTAL_ID;
  if (!portalId || !taskId) return "";
  return `https://app.hubspot.com/tasks/${portalId}/view/all/task/${taskId}`;
}

/**
 * Post enriched task data to the Google Apps Script web app.
 * The Apps Script creates a new sheet tab for the week and writes the rows.
 */
async function writeToSheet(tasks, weekStartZoned, weekEndZoned) {
  const webhookUrl = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn("[SHEETS] GOOGLE_SHEETS_WEBHOOK_URL not set — skipping sheet write.");
    return;
  }

  const weekLabel = `${format(weekStartZoned, "MMM d")} – ${format(weekEndZoned, "MMM d, yyyy")}`;

  const rows = tasks.map((task) => {
    const lastNote = task.lastNote;
    const edNote = task.edNote;
    const email = task.lastEmail;

    const lastNoteText = lastNote?.body
      ? lastNote.body +
        (lastNote.ownerName ? `\n[Added by: ${lastNote.ownerName}` +
          (lastNote.timestamp ? ` on ${formatDateTime(lastNote.timestamp)}` : "") + "]"
          : "")
      : "";

    const edNoteText = edNote?.body
      ? edNote.body +
        (edNote.ownerName ? `\n[Added by: ${edNote.ownerName}` +
          (edNote.timestamp ? ` on ${formatDateTime(edNote.timestamp)}` : "") + "]"
          : "")
      : "";

    const emailSender = [
      email?.senderName,
      email?.senderEmail ? `<${email.senderEmail}>` : null,
    ]
      .filter(Boolean)
      .join(" ");

    return {
      contactName: task.contact?.name || "",
      contactOwner: task.contact?.ownerName || "",
      companyName: task.company?.name || "",
      taskName: task.subject || "",
      taskUrl: taskUrl(task.id),
      dueDate: formatDateOnly(task.dueDate),
      lastNote: lastNoteText,
      edNote: edNoteText,
      emailSubject: email?.subject || "",
      emailFrom: emailSender,
      emailDate: email?.timestamp ? formatDateTime(email.timestamp) : "",
    };
  });

  const payload = { weekLabel, rows };

  try {
    const response = await axios.post(webhookUrl, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 30000,
    });
    console.log("[SHEETS] Sheet written successfully:", response.data);
  } catch (err) {
    console.error("[SHEETS] Failed to write to sheet:", err.response?.data ?? err.message);
  }
}

module.exports = { writeToSheet };
