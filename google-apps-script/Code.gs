/**
 * Ed's Contact/Company Tasks – Weekly sheet
 *
 * Every Friday ~4:30pm ET this adds a tab "Week of <next Mon>" listing open
 * HubSpot tasks that are linked to a contact or company (NOT deals).
 *
 * Columns: Contact Name · Contact Owner · Company · Task · Due Date ·
 *          Last Logged Note · Ed's Note · Last Logged Email
 *
 * "Ed's Note"      = most recent note whose body contains "ed's note" (case-insensitive).
 * "Last Logged Note" = most recent note that is NOT an Ed's Note.
 * Notes and emails are fetched from the contact first, then company as fallback.
 *
 * Setup (once):
 *   1. Open the Google Sheet → Extensions → Apps Script → paste this file → Save
 *   2. HubSpot Tasks menu → "Set HubSpot token"
 *   3. HubSpot Tasks menu → "Set owner IDs"
 *   4. HubSpot Tasks menu → "Install weekly schedule (Fri 4:30pm ET)"
 *   5. Run "Update now" to verify.
 */

var CONFIG = {
  PORTAL_ID:     '47530880',
  UI_DOMAIN:     'app.hubspot.com',
  TIME_ZONE:     'America/New_York',
  NOTE_MAX_CHARS: 2000,
};

var HEADERS    = ['Contact Name', 'Contact Owner', 'Company', 'Task', 'Due Date',
  'Last Logged Note', "Ed's Note", 'Last Logged Email'];
var COL_WIDTHS = [160, 130, 160, 260, 120, 320, 320, 320];
var HEADER_ROW = 4;

/* ------------------------------------------------------------------ menu */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('HubSpot Tasks')
    .addItem('Update now', 'updateWeeklyTasks')
    .addSeparator()
    .addItem('Set HubSpot token',               'setHubSpotToken')
    .addItem('Set owner IDs',                   'setOwnerIds')
    .addItem('Install weekly schedule (Fri 4:30pm ET)', 'installWeeklyTrigger')
    .addToUi();
}

function setHubSpotToken() {
  var ui = SpreadsheetApp.getUi();
  var res = ui.prompt('HubSpot private app token',
    'Paste the private app token (needs contacts, companies, owners read scopes).',
    ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  var token = res.getResponseText().replace(/^\s*(bearer\s+)?/i, '').replace(/["'\s]/g, '');
  if (!token) return;

  var check = UrlFetchApp.fetch('https://api.hubapi.com/crm/v3/objects/tasks/search', {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ limit: 1, properties: ['hs_task_subject'] }),
    muteHttpExceptions: true,
  });
  var code = check.getResponseCode();
  if (code === 401) { ui.alert('HubSpot rejected this token (401). Nothing was saved.'); return; }
  if (code === 403) {
    ui.alert('Token is missing permissions (403).\nAdd: crm.objects.contacts.read, crm.objects.companies.read, crm.objects.owners.read\n\n' +
      check.getContentText()); return;
  }
  if (code < 200 || code >= 300) { ui.alert('HubSpot returned ' + code + '. Nothing was saved.\n\n' + check.getContentText()); return; }

  PropertiesService.getScriptProperties().setProperty('HUBSPOT_ACCESS_TOKEN', token);
  ui.alert('Token works and is saved. Run "Update now" to test.');
}

function setOwnerIds() {
  var ui = SpreadsheetApp.getUi();
  var current = PropertiesService.getScriptProperties().getProperty('HUBSPOT_OWNER_IDS') || 'none';
  var res = ui.prompt('HubSpot owner IDs',
    'Comma-separated owner IDs to include in the digest (current: ' + current + ').',
    ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  var ids = res.getResponseText().split(',').map(function (s) { return s.trim(); }).filter(Boolean).join(',');
  if (!ids) return;
  PropertiesService.getScriptProperties().setProperty('HUBSPOT_OWNER_IDS', ids);
  ui.alert('Owner IDs saved: ' + ids);
}

function installWeeklyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'updateWeeklyTasks') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('updateWeeklyTasks')
    .timeBased().onWeekDay(ScriptApp.WeekDay.FRIDAY)
    .atHour(16).nearMinute(30).inTimezone(CONFIG.TIME_ZONE)
    .create();
  SpreadsheetApp.getUi().alert('Scheduled: every Friday around 4:30pm Eastern.');
}

/* ---------------------------------------------------------------- dates */

/**
 * Next week Mon 00:00 UTC → Sun 23:59:59.999 UTC.
 * HubSpot stores date-only due dates at midnight UTC, so this window
 * includes Monday tasks and excludes the following Monday.
 */
function digestWindow_(now) {
  var parts = Utilities.formatDate(now, CONFIG.TIME_ZONE, 'yyyy-MM-dd').split('-').map(Number);
  var y = parts[0], m = parts[1], d = parts[2];
  var dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun … 6=Sat
  var daysToNextMonday = dow === 1 ? 7 : (8 - dow) % 7;
  var monday = new Date(Date.UTC(y, m - 1, d + daysToNextMonday));
  var sunday = new Date(Date.UTC(y, m - 1, d + daysToNextMonday + 6, 23, 59, 59, 999));
  return {
    start:    monday,
    end:      sunday,
    label:    Utilities.formatDate(monday, 'UTC', 'MMM d') + ' – ' +
              Utilities.formatDate(sunday, 'UTC', 'MMM d, yyyy'),
    tabLabel: Utilities.formatDate(monday, 'UTC', 'MMM d, yyyy'),
  };
}

function dueDateDisplay_(raw) {
  if (!raw) return '';
  var d = new Date(raw);
  if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0) {
    return Utilities.formatDate(d, 'UTC', 'EEE, MMM d, yyyy');
  }
  return Utilities.formatDate(d, CONFIG.TIME_ZONE, 'EEE, MMM d, yyyy h:mm a z');
}

/* -------------------------------------------------------------- HubSpot */

function getOwnerIds_() {
  var stored = PropertiesService.getScriptProperties().getProperty('HUBSPOT_OWNER_IDS') || '';
  return stored.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}

function hs_(method, path, body) {
  var token = PropertiesService.getScriptProperties().getProperty('HUBSPOT_ACCESS_TOKEN');
  if (!token) throw new Error('No HubSpot token saved. Use HubSpot Tasks → Set HubSpot token.');
  var opts = {
    method: method, contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true,
  };
  if (body) opts.payload = JSON.stringify(body);
  for (var attempt = 0; ; attempt++) {
    var res = UrlFetchApp.fetch('https://api.hubapi.com' + path, opts);
    var code = res.getResponseCode();
    if (code >= 200 && code < 300) return code === 204 ? null : JSON.parse(res.getContentText());
    if (code === 401) throw new Error('HubSpot rejected the token (401). Re-run "Set HubSpot token".');
    var transient = [429, 500, 502, 503, 504].indexOf(code) !== -1;
    if (!transient || attempt >= 5) throw new Error('HubSpot ' + method + ' ' + path + ' → ' + code + ': ' + res.getContentText());
    Utilities.sleep(1000 * Math.pow(2, attempt));
  }
}

function chunk_(arr, n) {
  var out = [];
  for (var i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function unique_(arr) {
  var seen = {};
  return arr.map(String).filter(function (x) { return seen[x] ? false : (seen[x] = true); });
}

/** Search open tasks in the given UTC window, filtered by configured owner IDs. */
function searchTasks_(start, end) {
  var ownerIds = getOwnerIds_();
  if (!ownerIds.length) throw new Error('No owner IDs set. Use HubSpot Tasks → Set owner IDs.');
  var ownerFilter = ownerIds.length === 1
    ? { propertyName: 'hubspot_owner_id', operator: 'EQ',  value: ownerIds[0] }
    : { propertyName: 'hubspot_owner_id', operator: 'IN',  values: ownerIds };

  var tasks = [], after;
  do {
    var body = {
      filterGroups: [{ filters: [
        { propertyName: 'hs_task_status', operator: 'IN', values: ['NOT_STARTED', 'IN_PROGRESS'] },
        { propertyName: 'hs_timestamp',   operator: 'GTE', value: String(start.getTime()) },
        { propertyName: 'hs_timestamp',   operator: 'LTE', value: String(end.getTime()) },
        ownerFilter,
      ]}],
      properties: ['hs_task_subject', 'hs_task_status', 'hs_timestamp'],
      sorts: [{ propertyName: 'hs_timestamp', direction: 'ASCENDING' }],
      limit: 100,
    };
    if (after) body.after = after;
    var data = hs_('post', '/crm/v3/objects/tasks/search', body);
    tasks = tasks.concat(data.results || []);
    after = data.paging && data.paging.next && data.paging.next.after;
  } while (after);
  return tasks;
}

/** Batch associations: { fromId: [toId, …] }. */
function batchAssoc_(fromType, toType, ids) {
  var map = {};
  chunk_(unique_(ids), 1000).forEach(function (part) {
    var data = hs_('post', '/crm/v4/associations/' + fromType + '/' + toType + '/batch/read',
      { inputs: part.map(function (id) { return { id: id }; }) });
    (data.results || []).forEach(function (r) {
      map[String(r.from.id)] = (r.to || []).map(function (t) { return String(t.toObjectId); });
    });
  });
  return map;
}

/** Batch read CRM objects: { id: fullResult }. fullResult has .properties and .createdAt. */
function batchRead_(objectType, ids, properties) {
  var map = {};
  chunk_(unique_(ids.filter(Boolean)), 100).forEach(function (part) {
    var data = hs_('post', '/crm/v3/objects/' + objectType + '/batch/read', {
      inputs: part.map(function (id) { return { id: id }; }),
      properties: properties,
    });
    (data.results || []).forEach(function (r) { map[String(r.id)] = r; });
  });
  return map;
}

/** Paginated single-object associations. */
function assocIds_(fromType, fromId, toType) {
  var ids = [], after;
  do {
    var url = '/crm/v4/objects/' + fromType + '/' + fromId + '/associations/' + toType +
      '?limit=500' + (after ? '&after=' + encodeURIComponent(after) : '');
    var data = hs_('get', url);
    (data.results || []).forEach(function (r) { ids.push(String(r.toObjectId)); });
    after = data.paging && data.paging.next && data.paging.next.after;
  } while (after);
  return ids;
}

var ownerCache_ = {};
function ownerName_(ownerId) {
  if (!ownerId) return '';
  if (ownerId in ownerCache_) return ownerCache_[ownerId];
  var name = '';
  try {
    var o = hs_('get', '/crm/v3/owners/' + ownerId);
    name = [o.firstName, o.lastName].filter(Boolean).join(' ') || o.email || '';
  } catch (e) { /* deactivated / unknown owner */ }
  ownerCache_[ownerId] = name;
  return name;
}

function stripHtml_(html) {
  if (!html) return '';
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

/** Format a note result as a readable cell string: "MMM d, yyyy — Owner\nbody". */
function noteCell_(r) {
  if (!r) return '';
  var text = stripHtml_(r.properties.hs_note_body);
  if (text.length > CONFIG.NOTE_MAX_CHARS) text = text.slice(0, CONFIG.NOTE_MAX_CHARS) + '…';
  var when = r.properties.hs_timestamp || r.properties.hs_createdate;
  var meta = (when ? Utilities.formatDate(new Date(when), CONFIG.TIME_ZONE, 'MMM d, yyyy') : '') +
    (r.properties.hubspot_owner_id ? ' — ' + ownerName_(r.properties.hubspot_owner_id) : '');
  return (meta ? meta + '\n' : '') + text;
}

/** Format an email result as a readable cell string. */
function emailCell_(r) {
  if (!r) return '';
  var p = r.properties;
  var subject = p.hs_email_subject || '(no subject)';
  var senderName = [p.hs_email_sender_firstname, p.hs_email_sender_lastname].filter(Boolean).join(' ');
  var from = senderName + (p.hs_email_sender_email ? ' <' + p.hs_email_sender_email + '>' : '') || p.hs_email_sender_email || '';
  var when = p.hs_timestamp ? Utilities.formatDate(new Date(p.hs_timestamp), CONFIG.TIME_ZONE, 'MMM d, yyyy') : '';
  var header = subject + (from ? ' — ' + from : '') + (when ? ' — ' + when : '');

  // Strip quoted/threaded portion, keep only the latest message
  var body = stripHtml_(p.hs_email_text || '');
  var sep = body.search(/(\r?\n){1,2}(On .+wrote:|From:\s|-{3,}|_{3,})/);
  if (sep > 0) body = body.substring(0, sep).trim();
  if (body.length > CONFIG.NOTE_MAX_CHARS) body = body.slice(0, CONFIG.NOTE_MAX_CHARS) + '…';

  return header + (body ? '\n' + body : '');
}

/** Returns { lastNote, edNote } result objects; tries contact then falls back to company. */
function taskNotes_(contactId, companyId) {
  var lastNote = null, edNote = null;

  function pickFromNotes(noteMap) {
    var sorted = Object.keys(noteMap).map(function (k) { return noteMap[k]; })
      .sort(function (a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });
    for (var i = 0; i < sorted.length; i++) {
      var body = (sorted[i].properties.hs_note_body || '').toLowerCase();
      var isEdNote = body.indexOf("ed's note") !== -1;
      if (!lastNote && !isEdNote) lastNote = sorted[i];
      if (!edNote  &&  isEdNote) edNote  = sorted[i];
      if (lastNote && edNote) break;
    }
  }

  if (contactId) {
    try {
      var cIds = assocIds_('contacts', contactId, 'notes');
      if (cIds.length) pickFromNotes(batchRead_('notes', cIds, ['hs_note_body', 'hs_timestamp', 'hs_createdate', 'hubspot_owner_id']));
    } catch (e) { console.warn('Notes for contact ' + contactId + ': ' + e.message); }
  }

  if (companyId && (!lastNote || !edNote)) {
    try {
      var coIds = assocIds_('companies', companyId, 'notes');
      if (coIds.length) pickFromNotes(batchRead_('notes', coIds, ['hs_note_body', 'hs_timestamp', 'hs_createdate', 'hubspot_owner_id']));
    } catch (e) { console.warn('Notes for company ' + companyId + ': ' + e.message); }
  }

  return { lastNote: lastNote, edNote: edNote };
}

/** Returns the most recent email result object; tries contact then falls back to company. */
function taskLastEmail_(contactId, companyId) {
  var emailIds = [];
  if (contactId) {
    try { emailIds = assocIds_('contacts', contactId, 'emails'); } catch (e) {}
  }
  if (!emailIds.length && companyId) {
    try { emailIds = assocIds_('companies', companyId, 'emails'); } catch (e) {}
  }
  if (!emailIds.length) return null;

  var emails = batchRead_('emails', emailIds, [
    'hs_email_subject', 'hs_email_text', 'hs_timestamp',
    'hs_email_sender_firstname', 'hs_email_sender_lastname', 'hs_email_sender_email',
  ]);
  var sorted = Object.keys(emails).map(function (k) { return emails[k]; })
    .sort(function (a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });
  return sorted[0] || null;
}

function hsLink_(kind, id) {
  var base = 'https://' + CONFIG.UI_DOMAIN + '/contacts/' + CONFIG.PORTAL_ID + '/record/';
  if (kind === 'task')    return 'https://' + CONFIG.UI_DOMAIN + '/tasks/' + CONFIG.PORTAL_ID + '/view/all/task/' + id;
  if (kind === 'contact') return base + '0-1/' + id;
  return base + '0-2/' + id; // company
}

/* ------------------------------------------------------------- main job */

function updateWeeklyTasks(arg) {
  var now = arg instanceof Date ? arg : new Date();
  var win = digestWindow_(now);
  console.log('Fetching tasks for ' + win.label + ' …');

  var tasks = searchTasks_(win.start, win.end);
  console.log('Found ' + tasks.length + ' raw tasks. Fetching associations…');

  if (!tasks.length) { writeWeekTab_(win, [], now); return; }

  // Batch associations for all tasks at once
  var taskIds      = tasks.map(function (t) { return t.id; });
  var taskContacts = batchAssoc_('tasks', 'contacts',  taskIds);
  var taskCompanies = batchAssoc_('tasks', 'companies', taskIds);
  var taskDeals    = batchAssoc_('tasks', 'deals',     taskIds);

  // Filter: has contact or company AND no deal
  var qualifying = tasks.filter(function (t) {
    var hasAssoc = ((taskContacts[t.id]  || []).length > 0) || ((taskCompanies[t.id] || []).length > 0);
    var hasDeal  = (taskDeals[t.id] || []).length > 0;
    return hasAssoc && !hasDeal;
  });
  console.log(qualifying.length + ' tasks qualify (contact/company, no deal). Enriching…');

  // Batch fetch contacts
  var contactIds = qualifying.map(function (t) { return (taskContacts[t.id] || [])[0]; }).filter(Boolean);
  var contacts   = batchRead_('contacts', contactIds,
    ['firstname', 'lastname', 'hubspot_owner_id', 'associatedcompanyid']);

  // Determine company per task (task-direct first, then contact's associatedcompanyid)
  var companyFor = {};
  qualifying.forEach(function (t) {
    var cid = (taskContacts[t.id] || [])[0];
    companyFor[t.id] = (taskCompanies[t.id] || [])[0] ||
      (cid && contacts[cid] && contacts[cid].properties.associatedcompanyid) || null;
  });

  var companyIds = qualifying.map(function (t) { return companyFor[t.id]; }).filter(Boolean);
  var companies  = batchRead_('companies', companyIds, ['name']);

  // Enrich one task at a time (notes + emails cannot be batched across records)
  var records = [];
  qualifying.forEach(function (t, idx) {
    console.log('Enriching task ' + (idx + 1) + '/' + qualifying.length + ' id=' + t.id);
    var contactId = (taskContacts[t.id] || [])[0] || null;
    var companyId = companyFor[t.id] ? String(companyFor[t.id]) : null;
    var contact   = contactId ? contacts[contactId] : null;
    var company   = companyId ? companies[companyId] : null;

    var contactName  = contact
      ? ([contact.properties.firstname, contact.properties.lastname].filter(Boolean).join(' ') || '(unnamed)')
      : '';
    var contactOwner = contact ? ownerName_(contact.properties.hubspot_owner_id) : '';
    var companyName  = company ? (company.properties.name || '') : '';

    var notes     = taskNotes_(contactId, companyId);
    var lastEmail = taskLastEmail_(contactId, companyId);

    records.push({
      contactId:    contactId,
      contactName:  contactName,
      contactOwner: contactOwner,
      companyId:    companyId,
      companyName:  companyName,
      taskId:       t.id,
      taskText:     (t.properties.hs_task_subject || '(no subject)').trim(),
      dueDate:      dueDateDisplay_(t.properties.hs_timestamp),
      lastNote:     noteCell_(notes.lastNote),
      edNote:       noteCell_(notes.edNote),
      lastEmail:    emailCell_(lastEmail),
    });
  });

  writeWeekTab_(win, records, now);
  console.log('Done. Wrote ' + records.length + ' row(s).');
}

/* -------------------------------------------------------------- sheet */

function writeWeekTab_(win, records, now) {
  var ss = SpreadsheetApp.getActive();
  ss.setSpreadsheetTimeZone(CONFIG.TIME_ZONE);
  var tabName = 'Week of ' + win.tabLabel;

  var existing = ss.getSheetByName(tabName);
  if (existing) ss.deleteSheet(existing);
  var sheet = ss.insertSheet(tabName, 0);

  // Remove blank starter tab once real data exists
  var starter = ss.getSheetByName('Sheet1');
  if (starter && starter.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(starter);

  var ownerIds  = getOwnerIds_();
  var ownerLabel = ownerIds.map(ownerName_).filter(Boolean).join(', ') || ownerIds.join(', ');

  sheet.getRange(1, 1).setValue('Weekly Tasks — ' + ownerLabel + ' — ' + win.label)
    .setFontSize(14).setFontWeight('bold');
  sheet.getRange(2, 1).setValue(
    'Updated ' + Utilities.formatDate(now, CONFIG.TIME_ZONE, 'EEE MMM d, yyyy h:mm a z') +
    '  ·  ' + records.length + ' task(s)')
    .setFontColor('#666666');

  var nCols = HEADERS.length;
  sheet.getRange(HEADER_ROW, 1, 1, nCols).setValues([HEADERS])
    .setFontWeight('bold').setBackground('#1f3b57').setFontColor('#ffffff').setVerticalAlignment('middle');

  if (!records.length) {
    sheet.getRange(HEADER_ROW + 1, 1).setValue('No open tasks due next week.');
  } else {
    var n      = records.length;
    var values = records.map(function (r) {
      // Col 1 (contact), 3 (company), 4 (task) will be overwritten with rich text
      return [r.contactName, r.contactOwner, r.companyName, r.taskText,
        r.dueDate, r.lastNote, r.edNote, r.lastEmail].map(safeCell_);
    });

    sheet.getRange(HEADER_ROW + 1, 1, n, nCols)
      .setValues(values).setVerticalAlignment('top').setWrap(true);

    // Hyperlinked columns: Contact Name (1), Company (3), Task (4)
    var contactRich = records.map(function (r) {
      return [richLink_(r.contactName, r.contactId ? hsLink_('contact', r.contactId) : null)];
    });
    sheet.getRange(HEADER_ROW + 1, 1, n, 1).setRichTextValues(contactRich);

    var companyRich = records.map(function (r) {
      return [richLink_(r.companyName, r.companyId ? hsLink_('company', r.companyId) : null)];
    });
    sheet.getRange(HEADER_ROW + 1, 3, n, 1).setRichTextValues(companyRich);

    var taskRich = records.map(function (r) {
      return [richLink_(r.taskText, hsLink_('task', r.taskId))];
    });
    sheet.getRange(HEADER_ROW + 1, 4, n, 1).setRichTextValues(taskRich);

    sheet.getRange(HEADER_ROW, 1, n + 1, nCols).createFilter();
  }

  sheet.setFrozenRows(HEADER_ROW);
  COL_WIDTHS.forEach(function (w, i) { sheet.setColumnWidth(i + 1, w); });
  sheet.activate();
}

function safeCell_(v) {
  return typeof v === 'string' && /^[=+\-@]/.test(v) ? "'" + v : v;
}

function richLink_(text, url) {
  var b = SpreadsheetApp.newRichTextValue().setText(text || '');
  if (url) b = b.setLinkUrl(url);
  return b.build();
}
