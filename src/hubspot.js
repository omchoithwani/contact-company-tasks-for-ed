const axios = require("axios");

const BASE_URL = "https://api.hubapi.com";

// Cache owner names to avoid repeated API calls within a single run
const ownerCache = new Map();

function getClient() {
  return axios.create({
    baseURL: BASE_URL,
    headers: {
      Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
  });
}

/**
 * Fetch all pending tasks due within the given week boundaries.
 * @param {number} weekStart  - Unix ms timestamp for Monday 00:00 UTC
 * @param {number} weekEnd    - Unix ms timestamp for Sunday 23:59:59 UTC
 */
async function getTasksDueThisWeek(weekStart, weekEnd) {
  const client = getClient();
  const tasks = [];
  let after = undefined;

  do {
    const body = {
      filterGroups: [
        {
          filters: [
            {
              propertyName: "hs_task_status",
              operator: "IN",
              values: ["NOT_STARTED", "IN_PROGRESS"],
            },
            {
              propertyName: "hs_timestamp",
              operator: "GTE",
              value: String(weekStart),
            },
            {
              propertyName: "hs_timestamp",
              operator: "LTE",
              value: String(weekEnd),
            },
            {
              propertyName: "hubspot_owner_id",
              operator: "EQ",
              value: "1517615118",
            },
          ],
        },
      ],
      properties: ["hs_task_subject", "hs_task_status", "hs_timestamp"],
      limit: 200,
      ...(after ? { after } : {}),
    };

    const { data } = await client.post("/crm/v3/objects/tasks/search", body);
    tasks.push(...data.results);
    after = data.paging?.next?.after;
  } while (after);

  return tasks;
}

/**
 * Fetch association IDs for a task across contacts, companies, and deals.
 * Returns { contacts: [...ids], companies: [...ids], deals: [...ids] }
 */
async function getTaskAssociations(taskId) {
  const client = getClient();

  const [contactsRes, companiesRes, dealsRes] = await Promise.allSettled([
    client.get(`/crm/v4/objects/tasks/${taskId}/associations/contacts`),
    client.get(`/crm/v4/objects/tasks/${taskId}/associations/companies`),
    client.get(`/crm/v4/objects/tasks/${taskId}/associations/deals`),
  ]);

  const extractIds = (res) => {
    if (res.status === "fulfilled") {
      return (res.value.data.results || []).map((r) => r.toObjectId);
    }
    return [];
  };

  return {
    contacts: extractIds(contactsRes),
    companies: extractIds(companiesRes),
    deals: extractIds(dealsRes),
  };
}

/**
 * Fetch a contact's firstname and lastname.
 * Returns { id, name } or null.
 */
async function getContact(contactId) {
  const client = getClient();
  try {
    const { data } = await client.get(
      `/crm/v3/objects/contacts/${contactId}?properties=firstname,lastname`
    );
    const { firstname = "", lastname = "" } = data.properties;
    const name = [firstname, lastname].filter(Boolean).join(" ") || "(unknown)";
    return { id: contactId, name };
  } catch {
    return { id: contactId, name: "(unknown)" };
  }
}

/**
 * Fetch a company's name.
 * Returns { id, name } or null.
 */
async function getCompany(companyId) {
  const client = getClient();
  try {
    const { data } = await client.get(
      `/crm/v3/objects/companies/${companyId}?properties=name`
    );
    return { id: companyId, name: data.properties.name || "(unknown)" };
  } catch {
    return { id: companyId, name: "(unknown)" };
  }
}

/**
 * Resolve a HubSpot owner ID to a full name. Results are cached.
 * Returns "First Last" or null.
 */
async function getOwnerName(ownerId) {
  if (!ownerId) return null;
  if (ownerCache.has(ownerId)) return ownerCache.get(ownerId);

  const client = getClient();
  try {
    const { data } = await client.get(`/crm/v3/owners/${ownerId}`);
    const name =
      [data.firstName, data.lastName].filter(Boolean).join(" ") || null;
    ownerCache.set(ownerId, name);
    return name;
  } catch {
    ownerCache.set(ownerId, null);
    return null;
  }
}

/**
 * Get all associated object IDs for a given record using the v4 associations API.
 * e.g. all note IDs for a contact: getAssociatedIds("contacts", contactId, "notes")
 */
async function getAssociatedIds(fromObjectType, fromObjectId, toObjectType) {
  const client = getClient();
  const ids = [];
  let after = undefined;

  do {
    const params = { limit: 500, ...(after ? { after } : {}) };
    const { data } = await client.get(
      `/crm/v4/objects/${fromObjectType}/${fromObjectId}/associations/${toObjectType}`,
      { params }
    );
    (data.results || []).forEach((r) => ids.push(r.toObjectId));
    after = data.paging?.next?.after;
  } while (after);

  return ids;
}

/**
 * Batch-read CRM objects by ID, chunking into groups of 100 (HubSpot limit).
 * Returns array of raw result objects.
 */
async function batchReadObjects(objectType, ids, properties) {
  if (ids.length === 0) return [];
  const client = getClient();
  const results = [];

  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const { data } = await client.post(
      `/crm/v3/objects/${objectType}/batch/read`,
      {
        inputs: chunk.map((id) => ({ id: String(id) })),
        properties,
      }
    );
    results.push(...(data.results || []));
  }

  return results;
}

/**
 * Strip HTML tags and decode common entities from a string.
 */
function stripHtml(html) {
  if (!html) return null;
  return html
    .replace(/<[^>]+>/g, " ")  // replace tags with a space to avoid word merging
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, " ")   // collapse multiple spaces
    .trim() || null;
}

/**
 * Strip the quoted/threaded portion from an email body, keeping only the
 * latest message (the content before the first reply separator).
 */
function stripEmailThread(text) {
  if (!text) return null;

  // Common separators used by email clients and HubSpot
  const separatorPattern =
    /(\r?\n){1,2}(On .+wrote:|From:\s|-{3,}|_{3,}|>{1})/;

  const match = text.search(separatorPattern);
  const latest = match > 0 ? text.substring(0, match) : text;

  return latest.trim() || null;
}

/**
 * Build a note object { body, timestamp, ownerName } from a raw HubSpot note result.
 */
async function buildNoteObject(raw) {
  if (!raw) return null;
  const { hs_note_body, hs_timestamp, hubspot_owner_id } = raw.properties;
  const ownerName = await getOwnerName(hubspot_owner_id);
  return {
    body: stripHtml(hs_note_body) || null,
    timestamp: hs_timestamp || null,  // engagement date, used for display
    ownerName: ownerName || null,
  };
}

/** Sort an array of raw HubSpot objects newest-first by createdate. */
function sortByCreateDate(items) {
  return items.slice().sort(
    (a, b) => new Date(b.properties.createdate) - new Date(a.properties.createdate)
  );
}

/**
 * Get the most recent note for a contact or company.
 * Uses v4 associations API + batch read to avoid unreliable search filters.
 * Returns { body, timestamp, ownerName } or null.
 */
async function getLastNoteForObject(objectType, objectId) {
  try {
    const noteIds = await getAssociatedIds(objectType, objectId, "notes");
    if (noteIds.length === 0) return null;

    const notes = await batchReadObjects("notes", noteIds, [
      "hs_note_body",
      "hs_timestamp",
      "hubspot_owner_id",
      "createdate",
    ]);

    const sorted = sortByCreateDate(notes);
    return buildNoteObject(sorted[0] ?? null);
  } catch {
    return null;
  }
}

/**
 * Get the most recent note containing "Ed's Note" for a contact or company.
 * Returns { body, timestamp, ownerName } or null.
 */
async function getLastEdNoteForObject(objectType, objectId) {
  try {
    const noteIds = await getAssociatedIds(objectType, objectId, "notes");
    if (noteIds.length === 0) return null;

    const allNotes = await batchReadObjects("notes", noteIds, [
      "hs_note_body",
      "hs_timestamp",
      "hubspot_owner_id",
      "createdate",
    ]);

    const edNotes = allNotes.filter((n) =>
      n.properties.hs_note_body?.includes("Ed's Note")
    );

    const sorted = sortByCreateDate(edNotes);
    return buildNoteObject(sorted[0] ?? null);
  } catch {
    return null;
  }
}

/**
 * Get the most recent logged email for a contact or company.
 * Uses v4 associations API + batch read to avoid unreliable search filters.
 * Returns { subject, body, senderName, senderEmail, timestamp, direction } or null.
 */
async function getLastEmailForObject(objectType, objectId) {
  try {
    const emailIds = await getAssociatedIds(objectType, objectId, "emails");
    if (emailIds.length === 0) return null;

    const emails = await batchReadObjects("emails", emailIds, [
      "hs_email_subject",
      "hs_email_text",
      "hs_timestamp",
      "hs_email_sender_firstname",
      "hs_email_sender_lastname",
      "hs_email_sender_email",
      "hs_email_direction",
      "createdate",
    ]);

    const sorted = sortByCreateDate(emails);
    const raw = sorted[0];
    if (!raw) return null;

    const p = raw.properties;
    const senderName =
      [p.hs_email_sender_firstname, p.hs_email_sender_lastname]
        .filter(Boolean)
        .join(" ") || null;

    return {
      subject: p.hs_email_subject || null,
      body: stripEmailThread(p.hs_email_text) || null,
      senderName,
      senderEmail: p.hs_email_sender_email || null,
      timestamp: p.hs_timestamp || null,
      direction: p.hs_email_direction || null,
    };
  } catch {
    return null;
  }
}

module.exports = {
  getTasksDueThisWeek,
  getTaskAssociations,
  getContact,
  getCompany,
  getLastNoteForObject,
  getLastEdNoteForObject,
  getLastEmailForObject,
};
