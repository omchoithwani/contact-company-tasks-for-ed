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
 * Search notes associated with a contact or company, sorted newest first.
 * objectType: "contacts" | "companies"
 * Returns raw HubSpot results array.
 */
async function searchNotes(objectType, objectId, extraFilters = []) {
  const client = getClient();

  const body = {
    filterGroups: [
      {
        filters: [
          {
            propertyName: `associations.${objectType}`,
            operator: "EQ",
            value: String(objectId),
          },
          ...extraFilters,
        ],
      },
    ],
    properties: ["hs_note_body", "hs_timestamp", "hubspot_owner_id"],
    sorts: [{ propertyName: "hs_timestamp", direction: "DESCENDING" }],
    limit: 1,
  };

  const { data } = await client.post("/crm/v3/objects/notes/search", body);
  return data.results || [];
}

/**
 * Build a note object { body, timestamp, ownerName } from a raw HubSpot note result.
 */
async function buildNoteObject(raw) {
  if (!raw) return null;
  const { hs_note_body, hs_timestamp, hubspot_owner_id } = raw.properties;
  const ownerName = await getOwnerName(hubspot_owner_id);
  return {
    body: hs_note_body || null,
    timestamp: hs_timestamp || null,
    ownerName: ownerName || null,
  };
}

/**
 * Get the most recent note for a contact or company.
 * Returns { body, timestamp, ownerName } or null.
 */
async function getLastNoteForObject(objectType, objectId) {
  try {
    const results = await searchNotes(objectType, objectId);
    return buildNoteObject(results[0] ?? null);
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
    const results = await searchNotes(objectType, objectId, [
      {
        propertyName: "hs_note_body",
        operator: "CONTAINS_TOKEN",
        value: "Ed's Note",
      },
    ]);
    return buildNoteObject(results[0] ?? null);
  } catch {
    return null;
  }
}

/**
 * Get the most recent logged email for a contact or company.
 * Returns { subject, body, senderName, senderEmail, timestamp, direction } or null.
 */
async function getLastEmailForObject(objectType, objectId) {
  const client = getClient();
  try {
    const body = {
      filterGroups: [
        {
          filters: [
            {
              propertyName: `associations.${objectType}`,
              operator: "EQ",
              value: String(objectId),
            },
          ],
        },
      ],
      properties: [
        "hs_email_subject",
        "hs_email_text",
        "hs_timestamp",
        "hs_email_sender_firstname",
        "hs_email_sender_lastname",
        "hs_email_sender_email",
        "hs_email_direction",
      ],
      sorts: [{ propertyName: "hs_timestamp", direction: "DESCENDING" }],
      limit: 1,
    };

    const { data } = await client.post("/crm/v3/objects/emails/search", body);
    const raw = data.results?.[0];
    if (!raw) return null;

    const p = raw.properties;
    const senderName = [p.hs_email_sender_firstname, p.hs_email_sender_lastname]
      .filter(Boolean)
      .join(" ") || null;

    return {
      subject: p.hs_email_subject || null,
      body: p.hs_email_text || null,
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
