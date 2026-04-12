require("dotenv").config();

const { startOfWeek, endOfWeek } = require("date-fns");
const { toZonedTime, fromZonedTime } = require("date-fns-tz");

const {
  getTasksDueThisWeek,
  getTaskAssociations,
  getContact,
  getCompany,
  getAssociatedIds,
  getNotesForObject,
  getLastEmailForObject,
} = require("./hubspot");

const { formatEmail, sendEmail } = require("./email");

const TZ = "America/New_York";

// Process tasks in batches to avoid HubSpot rate limits (10 req/s on free tier).
// Uses Promise.allSettled so one failing item doesn't abort the whole batch.
// Adds a short delay between batches to stay well under the rolling rate limit.
async function batchProcess(items, batchSize, fn, delayMs = 0) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const settled = await Promise.allSettled(batch.map(fn));
    for (const outcome of settled) {
      if (outcome.status === "fulfilled") {
        results.push(outcome.value);
      } else {
        console.error("[ERROR] batchProcess item failed:", outcome.reason?.message ?? outcome.reason);
      }
    }
    if (delayMs > 0 && i + batchSize < items.length) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return results;
}

async function main() {
  let weekStartZoned, weekEndZoned;

  if (process.env.REPORT_DATE_FROM && process.env.REPORT_DATE_TO) {
    // Parse the date strings as Eastern time (not UTC) then convert to zoned display dates.
    // fromZonedTime("2026-03-01T00:00:00", TZ) treats the string as ET midnight → UTC instant.
    // toZonedTime then converts that UTC instant back to a zoned Date for correct display.
    weekStartZoned = toZonedTime(fromZonedTime(process.env.REPORT_DATE_FROM + "T00:00:00", TZ), TZ);
    weekEndZoned   = toZonedTime(fromZonedTime(process.env.REPORT_DATE_TO   + "T23:59:59", TZ), TZ);
  } else {
    // Default: current week (Mon–Sun) in EDT
    const zonedNow = toZonedTime(new Date(), TZ);
    weekStartZoned = startOfWeek(zonedNow, { weekStartsOn: 1 });
    weekEndZoned   = endOfWeek(zonedNow,   { weekStartsOn: 1 });
  }

  // Convert to UTC for HubSpot API timestamps
  const weekStart = fromZonedTime(weekStartZoned, TZ);
  const weekEnd   = fromZonedTime(weekEndZoned,   TZ);

  console.log(
    `Fetching tasks due ${weekStartZoned.toDateString()} – ${weekEndZoned.toDateString()} (EDT)...`
  );

  // 1. Fetch all pending tasks due this week
  const rawTasks = await getTasksDueThisWeek(
    weekStart.getTime(),
    weekEnd.getTime()
  );

  console.log(`Found ${rawTasks.length} raw tasks. Fetching associations...`);

  // 2. Fetch associations for every task (batched)
  // Each getTaskAssociations fires 3 concurrent requests; batch of 3 = 9 concurrent max.
  const tasksWithAssociations = await batchProcess(
    rawTasks,
    3,
    async (task) => {
      const associations = await getTaskAssociations(task.id);
      return { task, associations };
    }
  );

  // 3. Filter: keep only tasks with contact/company but NO deal association
  const qualifying = tasksWithAssociations.filter(({ associations }) => {
    const hasContactOrCompany =
      associations.contacts.length > 0 || associations.companies.length > 0;
    const hasDeal = associations.deals.length > 0;
    return hasContactOrCompany && !hasDeal;
  });

  console.log(
    `${qualifying.length} tasks qualify (contact/company, no deal). Enriching...`
  );

  // 4. Enrich each qualifying task one at a time to avoid HubSpot rate limits.
  // All API calls within each task are sequential — no concurrent bursting.
  const enriched = [];
  for (let i = 0; i < qualifying.length; i++) {
    const { task, associations } = qualifying[i];
    // Pause between tasks to stay under HubSpot's ten_secondly_rolling limit.
    // Each task makes ~7-8 sequential API calls; 500ms spacing keeps us safe.
    if (i > 0) await new Promise((r) => setTimeout(r, 500));
    try {
      const contactId = associations.contacts[0] ?? null;
      let companyId = associations.companies[0] ?? null;

      // If the task has no direct company association, look up the contact's company.
      // Tasks are often linked only to a contact, not the company directly.
      if (!companyId && contactId) {
        const contactCompanyIds = await getAssociatedIds("contacts", contactId, "companies");
        companyId = contactCompanyIds[0] ?? null;
      }

      console.log(`[TASK ${task.id}] "${task.properties.hs_task_subject}" — contactId=${contactId} companyId=${companyId}`);

      const contact = contactId ? await getContact(contactId) : null;
      const company = companyId ? await getCompany(companyId) : null;

      console.log(`[TASK ${task.id}] contact="${contact?.name}" company="${company?.name}"`);

      // Prefer contact for notes/emails; fall back to company
      let noteObjectType = null;
      let noteObjectId = null;

      if (contactId) {
        noteObjectType = "contacts";
        noteObjectId = contactId;
      } else if (companyId) {
        noteObjectType = "companies";
        noteObjectId = companyId;
      }

      let lastNote = null;
      let edNote = null;
      let lastEmail = null;

      if (noteObjectType && noteObjectId) {
        // getNotesForObject fetches note IDs only ONCE and derives both lastNote + edNote
        const notes = await getNotesForObject(noteObjectType, noteObjectId);
        lastNote = notes.lastNote;
        edNote = notes.edNote;
        lastEmail = await getLastEmailForObject(noteObjectType, noteObjectId);

        // If contact had no results, fall back to company
        if (noteObjectType === "contacts" && companyId) {
          if (!lastNote || !edNote) {
            const companyNotes = await getNotesForObject("companies", companyId);
            if (!lastNote) lastNote = companyNotes.lastNote;
            if (!edNote) edNote = companyNotes.edNote;
          }
          if (!lastEmail) lastEmail = await getLastEmailForObject("companies", companyId);
        }
      }

      console.log(`[TASK ${task.id}] lastNote=${!!lastNote} edNote=${!!edNote} lastEmail=${!!lastEmail}`);

      enriched.push({
        id: task.id,
        subject: task.properties.hs_task_subject,
        status: task.properties.hs_task_status,
        dueDate: task.properties.hs_timestamp,
        contact,
        company,
        lastNote,
        edNote,
        lastEmail,
      });
    } catch (err) {
      console.error(`[ERROR] Failed to enrich task ${task.id}:`, err.message ?? err);
    }
  }

  console.log(`Enriched ${enriched.length} tasks. Formatting email...`);

  // 5. Format and send email — pass zoned dates so email header shows EDT
  const { subject, html, text } = formatEmail(enriched, weekStartZoned, weekEndZoned);

  console.log(`Sending email: "${subject}"`);
  const result = await sendEmail(subject, html, text);
  console.log("Email sent successfully:", result);
}

main().catch((err) => {
  console.error("Fatal error:", err.message || err);
  process.exit(1);
});
