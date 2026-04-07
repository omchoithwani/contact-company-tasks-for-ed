require("dotenv").config();

const { startOfWeek, endOfWeek } = require("date-fns");
const { toZonedTime, fromZonedTime } = require("date-fns-tz");

const {
  getTasksDueThisWeek,
  getTaskAssociations,
  getContact,
  getCompany,
  getLastNoteForObject,
  getLastEdNoteForObject,
  getLastEmailForObject,
} = require("./hubspot");

const { formatEmail, sendEmail } = require("./email");

const TZ = "America/New_York";

// Process tasks in batches to avoid HubSpot rate limits (10 req/s on free tier)
async function batchProcess(items, batchSize, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

async function main() {
  let weekStartZoned, weekEndZoned;

  if (process.env.REPORT_DATE_FROM && process.env.REPORT_DATE_TO) {
    // Explicit from/to dates provided — use them directly at start/end of day EDT
    weekStartZoned = toZonedTime(new Date(process.env.REPORT_DATE_FROM + "T00:00:00"), TZ);
    weekEndZoned   = toZonedTime(new Date(process.env.REPORT_DATE_TO   + "T23:59:59"), TZ);
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
  const tasksWithAssociations = await batchProcess(
    rawTasks,
    10,
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

  // 4. Enrich each qualifying task with contact, company, and notes (batched)
  const enriched = await batchProcess(qualifying, 5, async ({ task, associations }) => {
    const contactId = associations.contacts[0] ?? null;
    const companyId = associations.companies[0] ?? null;

    // Fetch contact and company in parallel
    const [contact, company] = await Promise.all([
      contactId ? getContact(contactId) : Promise.resolve(null),
      companyId ? getCompany(companyId) : Promise.resolve(null),
    ]);

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
      [lastNote, edNote, lastEmail] = await Promise.all([
        getLastNoteForObject(noteObjectType, noteObjectId),
        getLastEdNoteForObject(noteObjectType, noteObjectId),
        getLastEmailForObject(noteObjectType, noteObjectId),
      ]);

      // If contact had no results, fall back to company
      if (noteObjectType === "contacts" && companyId) {
        if (!lastNote) lastNote = await getLastNoteForObject("companies", companyId);
        if (!edNote) edNote = await getLastEdNoteForObject("companies", companyId);
        if (!lastEmail) lastEmail = await getLastEmailForObject("companies", companyId);
      }
    }

    return {
      id: task.id,
      subject: task.properties.hs_task_subject,
      status: task.properties.hs_task_status,
      dueDate: task.properties.hs_timestamp,
      contact,
      company,
      lastNote,
      edNote,
      lastEmail,
    };
  });

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
