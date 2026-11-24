/**
 * Weekly HubSpot Tasks — Google Apps Script receiver
 *
 * Setup:
 *   1. Open your Google Sheet → Extensions → Apps Script
 *   2. Replace the default code with this file's contents
 *   3. Click Deploy → New deployment → Web app
 *      - Execute as: Me
 *      - Who has access: Anyone
 *   4. Copy the web app URL and add it as GOOGLE_SHEETS_WEBHOOK_URL
 *      in your GitHub repo secrets.
 *
 * Each Friday run creates a new sheet tab named "Week of <range>"
 * and writes one header row + one row per task.
 */

var COLUMNS = [
  "Contact Name",
  "Contact Owner",
  "Company Name",
  "Task Name",
  "Task URL",
  "Due Date",
  "Last Logged Note",
  "Ed's Note",
  "Last Email Subject",
  "Last Email From",
  "Last Email Date",
];

function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);
    var weekLabel = payload.weekLabel || "Unknown Week";
    var rows = payload.rows || [];

    var ss = SpreadsheetApp.getActiveSpreadsheet();

    // Create a new tab named "Week of <label>", replacing an existing one if present
    var tabName = "Week of " + weekLabel;
    var existing = ss.getSheetByName(tabName);
    if (existing) {
      ss.deleteSheet(existing);
    }
    var sheet = ss.insertSheet(tabName, 0); // insert at front

    // Header row
    var header = sheet.getRange(1, 1, 1, COLUMNS.length);
    header.setValues([COLUMNS]);
    header.setFontWeight("bold");
    header.setBackground("#4a86e8");
    header.setFontColor("#ffffff");

    // Data rows
    if (rows.length > 0) {
      var data = rows.map(function (r) {
        return [
          r.contactName || "",
          r.contactOwner || "",
          r.companyName || "",
          r.taskName || "",
          r.taskUrl || "",
          r.dueDate || "",
          r.lastNote || "",
          r.edNote || "",
          r.emailSubject || "",
          r.emailFrom || "",
          r.emailDate || "",
        ];
      });
      sheet.getRange(2, 1, data.length, COLUMNS.length).setValues(data);
    }

    // Auto-resize all columns
    for (var i = 1; i <= COLUMNS.length; i++) {
      sheet.autoResizeColumn(i);
    }

    // Freeze header row
    sheet.setFrozenRows(1);

    // Wrap text in note columns (cols 7 and 8: Last Note, Ed's Note)
    sheet.getRange(2, 7, Math.max(rows.length, 1), 2).setWrap(true);

    return ContentService.createTextOutput(
      JSON.stringify({ status: "ok", sheet: tabName, rows: rows.length })
    ).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(
      JSON.stringify({ status: "error", message: err.message })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}

// Test from the Apps Script editor: Run → doGet to verify deployment
function doGet() {
  return ContentService.createTextOutput("HubSpot Tasks receiver is running.");
}
