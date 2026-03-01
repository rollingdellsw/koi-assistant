/**
 * Sales Report Generator
 *
 * Queries PostgreSQL via Remote MCP (Gateway) and exports to Google Sheets
 * via Local MCP (browser-sandboxed google_workspace).
 */

const tableName = args.table_name || "sessions";
const limit = parseInt(args.limit || "50", 10);
const sheetTitle = args.sheet_title || `${tableName} Export - ${new Date().toISOString().split('T')[0]}`;
// Max characters per cell (Google Sheets limit is 50,000, but we use less for performance)
const maxCellLength = parseInt(args.max_cell_length || "500", 10);
// Columns to exclude (comma-separated)
const excludeColumns = (args.exclude_columns || "").split(",").map(c => c.trim()).filter(Boolean);

console.log("🚀 Starting sales-report generation");
console.log(`   Table: ${tableName}`);
console.log(`   Limit: ${limit}`);
console.log(`   Sheet Title: ${sheetTitle}`);
console.log(`   Max Cell Length: ${maxCellLength}`);
if (excludeColumns.length > 0) {
  console.log(`   Excluding columns: ${excludeColumns.join(", ")}`);
}

// Load dependencies
console.log("\n📦 Loading Shared MCPs...");
await tools.readSkill({ name: "google-workspace" });
await tools.readSkill({ name: "postgresql" });
console.log("   ✓ Dependencies loaded");

// Step 1: Query table schema to get column names
console.log("\n📊 Step 1: Fetching table schema from PostgreSQL...");

const schemaResult = await tools.query({
  sql: `SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_name = '${tableName}' AND table_schema = 'public'
        ORDER BY ordinal_position`
});

if (schemaResult.isError) {
  const errorText = schemaResult.content?.[0]?.text || "Unknown error";
  console.error("❌ Schema query failed:", errorText);
  return { success: false, error: "Failed to fetch table schema" };
}

let columns;
try {
  const schemaText = schemaResult.content?.[0]?.text || "[]";
  columns = JSON.parse(schemaText);

  // Filter out excluded columns
  if (excludeColumns.length > 0) {
    columns = columns.filter(c => !excludeColumns.includes(c.column_name));
  }

  console.log(`   Found ${columns.length} columns:`, columns.map(c => c.column_name).join(", "));
} catch (e) {
  console.error("❌ Failed to parse schema:", e.message);
  return { success: false, error: "Schema parsing failed" };
}

if (columns.length === 0) {
  console.error(`❌ Table '${tableName}' not found or has no columns`);
  return { success: false, error: `Table '${tableName}' not found` };
}

// Step 2: Query actual data
console.log("\n📊 Step 2: Fetching data...");

const columnNames = columns.map(c => c.column_name);
const dataResult = await tools.query({
  sql: `SELECT ${columnNames.join(", ")} FROM ${tableName} ORDER BY 1 DESC LIMIT ${limit}`
});

if (dataResult.isError) {
  const errorText = dataResult.content?.[0]?.text || "Unknown error";
  console.error("❌ Data query failed:", errorText);
  return { success: false, error: "Data query failed" };
}

let rows;
try {
  const dataText = dataResult.content?.[0]?.text || "[]";
  rows = JSON.parse(dataText);
  console.log(`   Retrieved ${rows.length} rows`);
} catch (e) {
  console.error("❌ Failed to parse data:", e.message);
  return { success: false, error: "Data parsing failed" };
}

if (rows.length === 0) {
  console.log("⚠️  No data found in table");
  return { success: true, message: "No data to export", rowCount: 0 };
}

// Step 3: Create Google Sheet
console.log("\n📝 Step 3: Creating Google Sheet...");

const createResult = await tools.sheets_create({ title: sheetTitle });
const createText = createResult.content?.[0]?.text || "";

const idMatch = createText.match(/spreadsheet: (\S+)/);
const urlMatch = createText.match(/URL: (\S+)/);
const spreadsheetId = idMatch?.[1];
const spreadsheetUrl = urlMatch?.[1];

if (!spreadsheetId) {
  console.error("❌ Failed to create spreadsheet:", createText);
  return { success: false, error: "Spreadsheet creation failed" };
}

console.log(`   Created: ${spreadsheetId}`);

// Step 4: Write data
console.log("\n📝 Step 4: Writing data to sheet...");

/**
 * Format a cell value for Google Sheets
 * - Truncates long strings
 * - Handles JSON objects
 * - Handles null/undefined
 */
function formatCell(val, maxLen) {
  if (val === null || val === undefined) return "";

  let str;
  if (typeof val === "object") {
    str = JSON.stringify(val);
  } else {
    str = String(val);
  }

  // Truncate if too long
  if (str.length > maxLen) {
    // Check if it looks like base64 image data
    if (str.includes("base64,") || str.match(/^[A-Za-z0-9+/=]{100,}/)) {
      return "[BASE64 DATA - truncated]";
    }
    return str.substring(0, maxLen - 20) + "... [truncated]";
  }

  return str;
}

// Prepare data: headers + rows
const headers = columnNames;
const dataRows = rows.map(row => headers.map(h => formatCell(row[h], maxCellLength)));

const allData = [headers, ...dataRows];

// Calculate range - handle columns beyond Z (AA, AB, etc.)
function columnLetter(n) {
  let result = "";
  while (n > 0) {
    n--;
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26);
  }
  return result;
}

const range = `Sheet1!A1:${columnLetter(headers.length)}${allData.length}`;
console.log(`   Writing to range: ${range}`);

await tools.sheets_write_range({
  spreadsheetId,
  range,
  values: allData
});

console.log(`   Wrote ${allData.length} rows (1 header + ${dataRows.length} data)`);

// Open the sheet in browser
console.log("\n👀 Opening spreadsheet in browser...");
const finalUrl = spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
await tools.newPage(finalUrl);

// Done!
console.log("\n✅ Export complete!");
console.log(`   Spreadsheet: ${finalUrl}`);

return {
  success: true,
  spreadsheetId,
  spreadsheetUrl: finalUrl,
  rowCount: rows.length,
  columns: headers
};
