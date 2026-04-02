require("dotenv").config();

const { startOfWeek, endOfWeek } = require("date-fns");

const {
  getTasksDueThisWeek,
  getTaskAssociations,
  getContact,
  getCompany,
  getLastNoteForObject,
  getLastEdNoteForObject,
} = require("./hubspot");

const { formatEmail, sendEmail } = require("./email");

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
  const now = new Date();
  // Week starts on Monday (weekStartsOn: 1)
  const weekStart = startOfWeek(now, { weekStartsOn: 1 });
  const weekEnd = endOfWeek(now, { weekStartsOn: 1 });

  console.log(
    `Fetching tasks due ${weekStart.toDateString()} – ${weekEnd.toDateString()}...`
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

    // Determine the best object to pull notes from.
    // Prefer contact; fall back to company.
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

    if (noteObjectType && noteObjectId) {
      [lastNote, edNote] = await Promise.all([
        getLastNoteForObject(noteObjectType, noteObjectId),
        getLastEdNoteForObject(noteObjectType, noteObjectId),
      ]);

      // If contact had no notes, try the company
      if (!lastNote && noteObjectType === "contacts" && companyId) {
        lastNote = await getLastNoteForObject("companies", companyId);
      }
      if (!edNote && noteObjectType === "contacts" && companyId) {
        edNote = await getLastEdNoteForObject("companies", companyId);
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
    };
  });

  console.log(`Enriched ${enriched.length} tasks. Formatting email...`);

  // 5. Format and send email
  const { subject, html, text } = formatEmail(enriched, weekStart, weekEnd);

  console.log(`Sending email: "${subject}"`);
  const result = await sendEmail(subject, html, text);
  console.log("Email sent successfully:", result);
}

main().catch((err) => {
  console.error("Fatal error:", err.message || err);
  process.exit(1);
});
