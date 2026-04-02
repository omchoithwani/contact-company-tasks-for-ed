const axios = require("axios");

const BASE_URL = "https://api.hubapi.com";

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
 * Search notes associated with a contact or company, sorted newest first.
 * objectType: "contacts" | "companies"
 */
async function searchNotes(objectType, objectId, extraFilters = []) {
  const client = getClient();

  const associationFilter = {
    propertyName: `associations.${objectType}`,
    operator: "EQ",
    value: String(objectId),
  };

  const body = {
    filterGroups: [
      {
        filters: [associationFilter, ...extraFilters],
      },
    ],
    properties: ["hs_note_body", "hs_timestamp"],
    sorts: [{ propertyName: "hs_timestamp", direction: "DESCENDING" }],
    limit: 1,
  };

  const { data } = await client.post("/crm/v3/objects/notes/search", body);
  return data.results || [];
}

/**
 * Get the body of the most recent note for a contact or company.
 * Returns note body string, or null if none found.
 */
async function getLastNoteForObject(objectType, objectId) {
  try {
    const results = await searchNotes(objectType, objectId);
    return results[0]?.properties?.hs_note_body || null;
  } catch {
    return null;
  }
}

/**
 * Get the body of the most recent note containing "Ed's Note" for a contact or company.
 * Returns note body string, or null if none found.
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
    return results[0]?.properties?.hs_note_body || null;
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
};
