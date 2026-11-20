import XLSX from 'xlsx';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import VendorRecord from '../models/VendorRecord.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ─── INIT EXCEL FILES IF THEY DONT EXIST ──────────────────────────────────────────

function initExcelFile(filePath, headers) {
  if (!fs.existsSync(filePath)) {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([headers]);
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    XLSX.writeFile(wb, filePath);
    console.log(`[ExcelService] Created ${filePath}`);
  }
}

// ─── SERVICES ──────────────────────────────────────────────────────────────────

/**
 * Returns a combined list of active vendors for the frontend dropdown.
 * Fetches LIVE from MongoDB VendorRecord.
 */
export async function getVendorsList() {
  const vendors = await VendorRecord.find({});
  return vendors.map(v => ({
    added_by: v.addedBy,
    code_prefix: v.codePrefix,
    vendor_details: v.vendorDetails,
    vendor_contact: v.vendorContact,
    sheet_filename: v.sheetFilename || `${v.addedBy}_products.xlsx`
  }));
}

/**
 * Appends a product to the specific vendor's Excel sheet.
 * The product object must be mapped to the 21 columns exact schema before passing.
 */
export async function appendRowToVendorSheet(vendorId, productRowArray) {
  // 1. Find the filename
  const vendors = await getVendorsList();
  const vendor = vendors.find(v => String(v.added_by) === String(vendorId));
  
  if (!vendor || !vendor.sheet_filename) {
    throw new Error(`Vendor ${vendorId} not found or has no assigned sheet filename.`);
  }

  const vendorFilePath = path.join(DATA_DIR, vendor.sheet_filename);

  // 2. Initialize the file if it doesn't exist
  if (!fs.existsSync(vendorFilePath)) {
    const COLUMNS_SCHEMA = [
      'Added by', 'Communets Code', 'Product Name', 'Status', 'Product Code',
      'Unit', 'Stock Quantity', 'Catogory', 'Sub Catogory', 'description',
      'Wholesale price', 'Wholesale Quantity', 'Retaila Price', 'Vendor Details',
      'Vendor Contact', 'Cost Price', 'Brand/Manuafacture', 'Image 1', 'Image 2',
      'Image 3', 'Image 4'
    ];
    initExcelFile(vendorFilePath, COLUMNS_SCHEMA);
  }

  // 3. Append row
  const wb = XLSX.readFile(vendorFilePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  XLSX.utils.sheet_add_aoa(ws, [productRowArray], { origin: -1 }); // append to end
  XLSX.writeFile(wb, vendorFilePath);
  
  console.log(`[ExcelService] Appended 1 row to ${vendor.sheet_filename}`);
  return true;
}
