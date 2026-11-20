import express from 'express';
import axios from 'axios';
import multer from 'multer';
import FormData from 'form-data';
import https from 'https';
import XLSX from 'xlsx';
import AdmZip from 'adm-zip';
import { v4 as uuidv4 } from 'uuid';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), '../../backend/.env') });

import Manufacturer from '../models/Manufacturer.js';
const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });
const RESERVED_MIN = 2604000000;
const RESERVED_MAX = 2604010000;
const INTERNAL_CALL_TIMEOUT_MS = Number.parseInt(process.env.INTERNAL_CALL_TIMEOUT_MS || '25000', 10);
const PREVIEW_PARSE_TIMEOUT_MS = Number.parseInt(process.env.PREVIEW_PARSE_TIMEOUT_MS || '120000', 10);
const PREVIEW_ROWS_CAP = Math.max(1, Number.parseInt(process.env.RESERVED_PREVIEW_ROWS_CAP || '5000', 10));
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
const BUCKET_NAME = process.env.AWS_S3_BUCKET_NAME || process.env.S3_BUCKET_NAME || 'communets-lightsail-bucket';
let sharpModulePromise = null;

function normalizeGs(code = '') {
  return String(code).trim().toUpperCase();
}

function hasUsableLegacyCode(code = '') {
  return Boolean(String(code).trim());
}

function normalizeHeaderKey(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function getNormalizedRowValue(row = {}, keys = []) {
  const normalizedMap = new Map();
  Object.entries(row || {}).forEach(([key, value]) => {
    const normalizedKey = normalizeHeaderKey(key);
    if (normalizedKey && !normalizedMap.has(normalizedKey)) {
      normalizedMap.set(normalizedKey, value);
    }
  });

  for (const key of keys) {
    const direct = row[key];
    if (direct !== undefined && direct !== null && String(direct).trim() !== '') {
      return String(direct).trim();
    }

    const normalized = normalizedMap.get(normalizeHeaderKey(key));
    if (normalized !== undefined && normalized !== null && String(normalized).trim() !== '') {
      return String(normalized).trim();
    }
  }

  return '';
}


function getContentTypeFromFilename(filename = '') {
  const lower = String(filename).toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.bmp')) return 'image/bmp';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  return 'image/jpeg';
}

async function enhanceImageLocally(buffer) {
  const sharp = await loadSharp();
  if (!sharp) {
    return buffer;
  }

  return sharp(buffer)
    .rotate()
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();
}

async function uploadBufferToS3(imageBuffer, filename) {
  try {
    if (!imageBuffer || imageBuffer.length === 0) return '';

    const sharp = await loadSharp();
    const originalName = String(filename || 'image.jpg');
    const originalExt = path.extname(originalName) || '.jpg';
    const safeName = path.basename(originalName, originalExt)
      .replace(/[^a-zA-Z0-9-_]/g, '_')
      .slice(0, 60);
    let body = imageBuffer;
    let ext = originalExt;
    let contentType = getContentTypeFromFilename(originalName);

    if (sharp) {
      body = await sharp(imageBuffer)
        .rotate()
        .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer();
      ext = '.webp';
      contentType = 'image/webp';
    }

    const key = `product-images/${Date.now()}_${uuidv4().slice(0, 8)}_${safeName}${ext}`;

    await s3.send(new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      Body: body,
      ContentType: contentType,
      ContentDisposition: 'inline',
    }));

    return `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${key}`;
  } catch (err) {
    console.error('[Direct S3 Upload]', err.message);
    return '';
  }
}

async function loadSharp() {
  if (!sharpModulePromise) {
    sharpModulePromise = import('sharp')
      .then((module) => module?.default || module)
      .catch((err) => {
        console.warn('[sharp] disabled:', err.message);
        return null;
      });
  }

  return sharpModulePromise;
}

function pickFirstText(row, keys = []) {
  return getNormalizedRowValue(row, keys);
}

function pickFirstNumber(row, keys = []) {
  for (const key of keys) {
    const value = getNormalizedRowValue(row, [key]);
    if (value === undefined || value === null || value === '') continue;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

async function extractEmbeddedImageUrlsByRow(fileBuffer, headerIndex = 0, options = {}) {
  const result = new Map();
  const allowedRows = options.allowedRows || null;
  const maxUploads = Number.isFinite(options.maxUploads) ? options.maxUploads : Infinity;
  const zip = new AdmZip(fileBuffer);
  const entries = zip.getEntries();

  const mediaMap = {};
  entries
    .filter((e) => e.entryName.startsWith('xl/media/'))
    .forEach((e) => {
      const filename = e.entryName.split('/').pop();
      mediaMap[filename] = e.getData();
    });

  if (Object.keys(mediaMap).length === 0) return result;

  const relMap = {};
  const relEntries = entries.filter((e) => /xl\/drawings\/_rels\/drawing\d+\.xml\.rels/.test(e.entryName));
  for (const relEntry of relEntries) {
    const relName = relEntry.entryName.split('/').pop() || '';
    const drawingBase = relName.replace('.xml.rels', '');
    const relXml = relEntry.getData().toString('utf8');
    const relMatches = [...relXml.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)];
    relMatches.forEach(([, rId, target]) => {
      if (!target.includes('media/')) return;
      const filename = target.split('/').pop();
      if (!filename) return;
      relMap[`${drawingBase}:${rId}`] = filename;
      // Fallback for workbooks where rid values are globally unique.
      if (!relMap[rId]) relMap[rId] = filename;
    });
  }

  const imageRefs = [];
  const drawingEntries = entries.filter((e) => /xl\/drawings\/drawing\d+\.xml$/.test(e.entryName));
  for (const drawingEntry of drawingEntries) {
    const drawingName = (drawingEntry.entryName.split('/').pop() || '').replace('.xml', '');
    const drawXml = drawingEntry.getData().toString('utf8');
    const anchors = [...drawXml.matchAll(/<xdr:(?:oneCellAnchor|twoCellAnchor)[^>]*>([\s\S]*?)<\/xdr:(?:oneCellAnchor|twoCellAnchor)>/g)];
    for (const [, block] of anchors) {
      const fromRowMatch = block.match(/<xdr:from>[\s\S]*?<xdr:row>(\d+)<\/xdr:row>[\s\S]*?<\/xdr:from>/);
      const fallbackRowMatch = block.match(/<xdr:row>(\d+)<\/xdr:row>/);
      const rowMatch = fromRowMatch || fallbackRowMatch;
      const embedMatches = [...block.matchAll(/r:embed="(rId\d+)"/g)];
      if (rowMatch && embedMatches.length > 0) {
        const excelRow = parseInt(rowMatch[1], 10) + 1;
        embedMatches.forEach((m) => {
          imageRefs.push({ excelRow, rId: m[1], drawingName });
        });
      }
    }
  }

  // Keep only image refs that belong to parsed data rows to avoid uploading unrelated sheet assets.
  const filteredRefs = imageRefs
    .filter((ref) => {
      if (ref.excelRow <= headerIndex + 1) return false;
      if (allowedRows && !allowedRows.has(ref.excelRow)) return false;
      return true;
    })
    .sort((a, b) => a.excelRow - b.excelRow);

  let uploadedCount = 0;
  const tasks = [];
  for (const ref of filteredRefs) {
    if (uploadedCount >= maxUploads) break;

    const existing = result.get(ref.excelRow) || [];
    if (existing.length >= 4) continue;

    const mediaFilename = relMap[`${ref.drawingName}:${ref.rId}`] || relMap[ref.rId];
    const mediaBuffer = mediaMap[mediaFilename];
    if (!mediaBuffer) continue;

    uploadedCount += 1;
    tasks.push({ ref, mediaFilename, mediaBuffer });
  }

  // Upload in small concurrent batches so preview does not stall on large workbooks.
  const concurrency = 4;
  for (let i = 0; i < tasks.length; i += concurrency) {
    const chunk = tasks.slice(i, i + concurrency);
    const uploaded = await Promise.all(
      chunk.map(async (task) => {
        try {
          const url = await uploadBufferToS3(task.mediaBuffer, `registry_${task.mediaFilename}`);
          return { row: task.ref.excelRow, url };
        } catch (_) {
          return { row: task.ref.excelRow, url: '' };
        }
      })
    );

    uploaded.forEach(({ row, url }) => {
      if (!url) return;
      const list = result.get(row) || [];
      if (list.length < 4) {
        list.push(url);
        result.set(row, list);
      }
    });
  }

  return result;
}

async function parseMappingRowsFromBuffer(fileBuffer, options = {}) {
  const includeEmbeddedImages = Boolean(options.includeEmbeddedImages);
  const maxRowsForPreview = Number.isFinite(Number(options.maxRowsForPreview))
    ? Math.max(1, Number(options.maxRowsForPreview))
    : null;

  const parseStartedAt = Date.now();
  const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(firstSheet, { defval: '' });
  const parseMs = Date.now() - parseStartedAt;

  const slicedRows = maxRowsForPreview ? rows.slice(0, maxRowsForPreview) : rows;

  let imageExtractionMs = 0;
  let imageUploadMs = 0;
  let embeddedImagesByRow = new Map();

  if (includeEmbeddedImages) {
    const extractionStartedAt = Date.now();
    const rowNumbers = new Set(slicedRows.map((_, idx) => idx + 2));
    embeddedImagesByRow = await extractEmbeddedImageUrlsByRow(fileBuffer, 0, {
      allowedRows: rowNumbers,
      maxUploads: slicedRows.length * 4,
    });
    imageExtractionMs = Date.now() - extractionStartedAt;
    // Extraction helper currently includes upload time in the same phase.
    imageUploadMs = imageExtractionMs;
  }

  const mappedRows = slicedRows.map((row, idx) => {
    const rowNumber = idx + 2;
    const oldGs = normalizeGs(pickFirstText(row, [
      'SKU no(old gs)',
      'SKU',
      'sku',
      'Old GS',
      'old_gs',
      'Communets Code',
      'Communets Code (GS)',
      'CommunetsCode',
      'Communets code',
      'Communets code (GS)',
      'GS Code',
      'GS code',
    ]));
    const productName = pickFirstText(row, ['Product Name', 'product_name', 'Description', 'Product Description', 'description']);
    const brandManufacturer = pickFirstText(row, ['Brand / Manufacturer', 'Brand', 'brand']);
    const category = pickFirstText(row, ['Category', 'category']);
    const subcategory = pickFirstText(row, ['Subcategory', 'Sub Category', 'subcategory']);
    const unit = pickFirstText(row, ['Unit', 'unit']);
    const stockQuantity = pickFirstNumber(row, ['Stock Quantity', 'stockQuantity', 'stock']);
    const minWholesaleQty = pickFirstNumber(row, ['Min. Wholesale Qty', 'Wholesale qty', 'Wholesale Quantity', 'minWholesaleQty']);
    const wholesalePrice = pickFirstNumber(row, ['Wholesale Price', 'Wholesale', 'wholesalePrice']);
    const retailPrice = pickFirstNumber(row, ['Retail Price', 'Retail', 'retailPrice']);
    const costPrice = pickFirstNumber(row, ['Cost Price', 'costPrice']);

    const imageUrls = [
      pickFirstText(row, ['Image URL 1', 'image_url', 'Picture']),
      pickFirstText(row, ['Image URL 2', 'image_url_2']),
      pickFirstText(row, ['Image URL 3', 'image_url_3']),
      pickFirstText(row, ['Image URL 4', 'image_url_4']),
    ].filter(Boolean);

    const embedded = embeddedImagesByRow.get(rowNumber) || [];
    const mergedImages = [...imageUrls, ...embedded].slice(0, 4);

    return {
      rowNumber,
      oldGs,
      productName,
      brandManufacturer,
      category,
      subcategory,
      unit,
      stockQuantity,
      minWholesaleQty,
      wholesalePrice,
      retailPrice,
      costPrice,
      imageUrl1: mergedImages[0] || '',
      imageUrl2: mergedImages[1] || '',
      imageUrl3: mergedImages[2] || '',
      imageUrl4: mergedImages[3] || '',
    };
  }).filter((r) => r.productName || r.oldGs);

  return {
    rows: mappedRows,
    totalInputRows: rows.length,
    timings: {
      parseMs,
      imageExtractionMs,
      imageUploadMs,
    },
  };
}

async function assignReservedCodesForPreviewRows(parsedRows, backendUrl) {
  const candidateOldGs = [...new Set(
    parsedRows
      .map((row) => normalizeGs(row.oldGs))
      .filter((code) => hasUsableLegacyCode(code))
  )];

  const existingOldGsSet = new Set();
  if (candidateOldGs.length > 0) {
    const existingRes = await axios.post(
      `${backendUrl}/v1/products/reserved-mapping/existing-old-gs`,
      { oldGsCodes: candidateOldGs },
      {
        timeout: INTERNAL_CALL_TIMEOUT_MS,
        headers: {
          'x-internal-call': '1',
          'x-internal-user-id': 'system',
          'x-internal-email': 'system@communets.local',
        }
      }
    );
    const existingOldGs = Array.isArray(existingRes?.data?.existingOldGs)
      ? existingRes.data.existingOldGs
      : [];
    existingOldGs.forEach((code) => {
      const normalized = normalizeGs(code);
      if (normalized) existingOldGsSet.add(normalized);
    });
  }

  const eligibleRowCount = parsedRows.filter((row) => {
    const oldGs = normalizeGs(row.oldGs);
    if (!hasUsableLegacyCode(oldGs) || !hasUsableLegacyCode(row.productName)) return false;
    if (existingOldGsSet.has(oldGs)) return false;
    return true;
  }).length;

  const nextCodesRes = await axios.get(`${backendUrl}/v1/products/reserved-mapping/next-codes`, {
    timeout: INTERNAL_CALL_TIMEOUT_MS,
    params: { count: eligibleRowCount },
    headers: { 'x-internal-call': '1' }
  });
  const assignedCodes = nextCodesRes.data?.codes || [];
  let assignedIndex = 0;

  return parsedRows.map((row) => {
    const normalizedOldGs = normalizeGs(row.oldGs);
    const isDuplicateOldGs = hasUsableLegacyCode(normalizedOldGs) && existingOldGsSet.has(normalizedOldGs);
    const canAssign = hasUsableLegacyCode(normalizedOldGs) && hasUsableLegacyCode(row.productName) && !isDuplicateOldGs;
    const newGs = canAssign ? (assignedCodes[assignedIndex++] || '') : '';
    const status = isDuplicateOldGs
      ? 'duplicate_old_gs'
      : ((hasUsableLegacyCode(normalizedOldGs) && hasUsableLegacyCode(row.productName) && hasUsableLegacyCode(newGs)) ? 'ok' : 'invalid_row');
    const message = isDuplicateOldGs ? 'Skipped: old GS already processed previously' : '';

    return {
      rowNumber: row.rowNumber,
      oldGs: row.oldGs,
      newGs,
      productName: row.productName,
      brandManufacturer: row.brandManufacturer,
      category: row.category,
      subcategory: row.subcategory,
      unit: row.unit,
      stockQuantity: row.stockQuantity,
      minWholesaleQty: row.minWholesaleQty,
      wholesalePrice: row.wholesalePrice,
      retailPrice: row.retailPrice,
      costPrice: row.costPrice,
      imageUrl1: row.imageUrl1,
      imageUrl2: row.imageUrl2,
      imageUrl3: row.imageUrl3,
      imageUrl4: row.imageUrl4,
      claimed: false,
      byWhom: '',
      status,
      message
    };
  });
}

// GET /api/reserved-mapping/template
// Downloads an Excel template for Reserved Buffer Publish.
router.get('/reserved-mapping/template', (_req, res) => {
  const templateHeaders = [
    'Product Name',
    'SKU',
    'Brand / Manufacturer',
    'Category',
    'Subcategory',
    'Unit',
    'Stock Quantity',
    'Min. Wholesale Qty',
    'Wholesale Price',
    'Retail Price',
    'Cost Price',
    'Image URL 1',
    'Image URL 2',
    'Image URL 3',
    'Image URL 4',
  ];

  const sampleRow = [
    'Sample Reserved Product',
    'OLDGS-1001',
    'Sample Brand',
    'Computer Products',
    'Computer Accessories',
    'Piece',
    '100',
    '5',
    '450.00',
    '599.00',
    '320.00',
    'https://example.com/image1.jpg',
    '',
    '',
    '',
  ];

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([templateHeaders, sampleRow]);
  ws['!cols'] = templateHeaders.map(() => ({ wch: 22 }));
  XLSX.utils.book_append_sheet(wb, ws, 'ReservedBufferPublish');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="reserved_buffer_template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  return res.send(buf);
});

// POST /api/reserved-mapping/preview-single
// Returns reserved GS assignment preview for one product entry.
router.post('/reserved-mapping/preview-single', async (req, res) => {
  const requestStartedAt = Date.now();
  try {
    const body = req.body || {};
    const oldGs = normalizeGs(body.oldGs || body.sku || '');
    const productName = String(body.productName || body.product_name || '').trim();

    if (!oldGs || !productName) {
      return res.status(400).json({ error: 'productName and oldGs are required' });
    }

    const parsedRow = {
      rowNumber: 2,
      oldGs,
      productName,
      brandManufacturer: String(body.brandManufacturer || body.brand || '').trim(),
      category: String(body.category || '').trim(),
      subcategory: String(body.subcategory || '').trim(),
      unit: String(body.unit || 'Piece').trim() || 'Piece',
      stockQuantity: body.stockQuantity ?? '',
      minWholesaleQty: body.minWholesaleQty ?? '',
      wholesalePrice: body.wholesalePrice ?? '',
      retailPrice: body.retailPrice ?? '',
      costPrice: body.costPrice ?? '',
      imageUrl1: String(body.imageUrl1 || body.image_url || '').trim(),
      imageUrl2: String(body.imageUrl2 || body.image_url_2 || '').trim(),
      imageUrl3: String(body.imageUrl3 || body.image_url_3 || '').trim(),
      imageUrl4: String(body.imageUrl4 || body.image_url_4 || '').trim(),
    };

    const backendUrl = process.env.INTERNAL_BACKEND_URL || 'http://localhost:5274';
    const codeAllocationStartedAt = Date.now();
    const previewRows = await assignReservedCodesForPreviewRows([parsedRow], backendUrl);
    const codeAllocationMs = Date.now() - codeAllocationStartedAt;

    return res.json({
      totalRows: 1,
      validRows: previewRows.filter((r) => r.status === 'ok').length,
      skippedRows: previewRows.filter((r) => r.status === 'duplicate_old_gs').length,
      rows: previewRows,
      row: previewRows[0] || null,
      timings: {
        parseMs: 0,
        imageExtractionMs: 0,
        imageUploadMs: 0,
        codeAllocationMs,
        totalMs: Date.now() - requestStartedAt,
      },
    });
  } catch (error) {
    console.error('[reserved-mapping/preview-single] error:', error.message);
    const isTimeout = error.code === 'ECONNABORTED' || /timed out/i.test(String(error.message || ''));
    return res.status(isTimeout ? 504 : 500).json({
      error: isTimeout
        ? 'Single-entry preview timed out while contacting backend services. Please retry.'
        : error.message
    });
  }
});

// GET /api/vendor-info/:vendorId - Fetch real vendor name & contact from Main Backend DB
router.get('/vendor-info/:vendorId', async (req, res) => {
  const vendorId = String(req.params.vendorId || '').trim();
  try {
    const backendUrl = process.env.INTERNAL_BACKEND_URL || 'http://localhost:5274';
    const response = await axios.get(`${backendUrl}/v1/profile`, {
      headers: { 'x-internal-call': '1', 'x-internal-user-id': vendorId }
    });
    const seller = response.data?.user || response.data?.seller || response.data || {};
    const contact = seller.phoneNo
      ? `${seller.phoneNo}${seller.email ? ' ' + seller.email : ''}`.trim()
      : (seller.email || 'N/A');
    const fullName = [seller.firstName, seller.lastName].filter(Boolean).join(' ').trim();
    res.json({ name: seller.name || seller.fullName || fullName || `Seller ${vendorId}`, contact });
  } catch (err) {
    console.error('[vendor-info] error:', err.response?.data || err.message);
    // Never fail UI on vendor-info lookup; provide a safe fallback.
    res.json({ name: `Seller ${vendorId || 'Unknown'}`, contact: 'N/A' });
  }
});


// GET /api/check-communets-code?code=X&vendorId=Y
// Checks if a given Communets Code already exists globally in the main backend
router.get('/check-communets-code', async (req, res) => {
  try {
    const { code, vendorId } = req.query;
    const actorRole = String(req.query.actorRole || req.query.role || '').trim().toLowerCase();
    if (!code) return res.json({ exists: false });

    const backendUrl = process.env.INTERNAL_BACKEND_URL || 'http://localhost:5274';
    const response = await axios.get(`${backendUrl}/v1/products/check-communets-code`, {
      params: { code, vendorId, actorRole },
      headers: { 'x-internal-call': '1' }
    });

    res.json(response.data);
  } catch (err) {
    console.error('[check-communets-code] error:', err.message);
    res.json({ exists: false }); // fail-open so form doesn't get stuck
  }
});

// GET /api/next-communets-code
// Proxy to main backend for atomic GS generation
router.get('/next-communets-code', async (req, res) => {
  try {
    const { count } = req.query;
    const backendUrl = process.env.INTERNAL_BACKEND_URL || 'http://localhost:5274';
    const response = await axios.get(`${backendUrl}/v1/products/next-communets-code`, {
      params: { count },
      headers: { 'x-internal-call': '1' }
    });
    res.json(response.data);
  } catch (err) {
    console.error('[next-communets-code] proxy error:', err.message);
    res.status(500).json({ error: 'Failed to generate code' });
  }
});

// POST /api/check-communets-codes/batch
// Batch check for existing Communets Codes; proxies to main backend
router.post('/check-communets-codes/batch', async (req, res) => {
  try {
    const { codes = [] } = req.body;
    const vendorId = req.query.vendorId || req.body.vendorId || '';
    const actorRole = req.query.actorRole || req.body.actorRole || 'seller';

    if (!Array.isArray(codes)) {
      return res.status(400).json({ message: 'codes must be an array' });
    }

    const backendUrl = process.env.INTERNAL_BACKEND_URL || 'http://localhost:5274';
    const response = await axios.post(`${backendUrl}/v1/products/check-communets-codes/batch`, 
      { codes },
      { 
        params: { vendorId, actorRole },
        headers: { 'x-internal-call': '1' }
      }
    );

    res.json(response.data);
  } catch (err) {
    console.error('[check-communets-codes/batch] proxy error:', err.message);
    res.status(500).json({ error: 'Failed to batch check codes' });
  }
});

// POST /api/reserved-mapping/preview
// Accepts .xlsx/.csv with Product Description and SKU, assigns GS2604 reserved codes for preview.
router.post('/reserved-mapping/preview', upload.single('file'), async (req, res) => {
  const requestStartedAt = Date.now();
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'file is required' });
    }

    const ext = req.file.originalname.split('.').pop()?.toLowerCase();
    if (!['xlsx', 'csv'].includes(ext)) {
      return res.status(400).json({ error: 'Only .xlsx or .csv is supported' });
    }

    const parseResult = await Promise.race([
      parseMappingRowsFromBuffer(req.file.buffer, {
        includeEmbeddedImages: true,
      }),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Preview parsing timed out. Please reduce file size and retry.')), PREVIEW_PARSE_TIMEOUT_MS);
      })
    ]);
    const parsed = Array.isArray(parseResult?.rows) ? parseResult.rows : [];
    if (!parsed.length) {
      return res.status(422).json({ error: 'No valid rows found. Required columns: Product Description, SKU' });
    }

    const maxRows = RESERVED_MAX - RESERVED_MIN + 1;
    if (parsed.length > maxRows) {
      return res.status(400).json({ error: `Max ${maxRows} rows allowed for reserved mapping` });
    }

      const backendUrl = process.env.INTERNAL_BACKEND_URL || 'http://localhost:5274';
      const codeAllocationStartedAt = Date.now();
      const previewRows = await assignReservedCodesForPreviewRows(parsed, backendUrl);

    const codeAllocationMs = Date.now() - codeAllocationStartedAt;
    const capped = previewRows.length > PREVIEW_ROWS_CAP;
    const rowsForUi = capped ? previewRows.slice(0, PREVIEW_ROWS_CAP) : previewRows;

    const responsePayload = {
      totalRows: previewRows.length,
      returnedRows: rowsForUi.length,
      capped,
      capLimit: PREVIEW_ROWS_CAP,
      validRows: previewRows.filter((r) => r.status === 'ok').length,
      skippedRows: previewRows.filter((r) => r.status === 'duplicate_old_gs').length,
      rows: rowsForUi,
      timings: {
        parseMs: Number(parseResult?.timings?.parseMs || 0),
        imageExtractionMs: Number(parseResult?.timings?.imageExtractionMs || 0),
        imageUploadMs: Number(parseResult?.timings?.imageUploadMs || 0),
        codeAllocationMs,
        totalMs: Date.now() - requestStartedAt,
      },
    };

    const payloadBytes = Buffer.byteLength(JSON.stringify(responsePayload), 'utf8');
    console.info(`[reserved-mapping/preview] latencyMs=${responsePayload.timings.totalMs} payloadBytes=${payloadBytes} parseMs=${responsePayload.timings.parseMs} imageExtractionMs=${responsePayload.timings.imageExtractionMs} imageUploadMs=${responsePayload.timings.imageUploadMs} codeAllocationMs=${responsePayload.timings.codeAllocationMs} totalRows=${responsePayload.totalRows} returnedRows=${responsePayload.returnedRows} capped=${responsePayload.capped}`);

    return res.json(responsePayload);
  } catch (error) {
    console.error('[reserved-mapping/preview] error:', error.message);
    const isTimeout = error.code === 'ECONNABORTED' || /timed out/i.test(String(error.message || ''));
    return res.status(isTimeout ? 504 : 500).json({
      error: isTimeout
        ? 'Preview request timed out while contacting backend services. Please retry.'
        : error.message
    });
  }
});

// POST /api/reserved-mapping/submit
// Persists old->new GS mappings in main backend and optionally forwards to n8n.
router.post('/reserved-mapping/submit', async (req, res) => {
  try {
    const { mappings, actorEmail, actorId } = req.body || {};
    if (!Array.isArray(mappings) || mappings.length === 0) {
      return res.status(400).json({ error: 'mappings[] is required' });
    }

    const backendUrl = process.env.INTERNAL_BACKEND_URL || 'http://localhost:5274';

    const mainBackendRes = await axios.post(
      `${backendUrl}/v1/products/reserved-mapping/apply-batch`,
      {
        mappings,
        actorEmail,
        actorId,
        source: 'microservice-reserved-mapping'
      },
      {
        headers: {
          'x-internal-call': '1',
          'x-internal-user-id': actorId || 'system'
        }
      }
    );

    let n8nStatus = 'skipped';
    if (process.env.N8N_RESERVED_MAPPING_WEBHOOK) {
      try {
        await axios.post(process.env.N8N_RESERVED_MAPPING_WEBHOOK, {
          source: 'microservice-reserved-mapping',
          submittedAt: new Date().toISOString(),
          actorEmail,
          actorId,
          mappings
        });
        n8nStatus = 'sent';
      } catch (n8nError) {
        n8nStatus = `failed: ${n8nError.message}`;
      }
    }

    return res.json({
      message: 'Reserved mapping processed',
      n8nStatus,
      result: mainBackendRes.data
    });
  } catch (error) {
    console.error('[reserved-mapping/submit] error:', error.response?.data || error.message);
    return res.status(500).json({
      error: error.response?.data?.message || error.message,
      details: error.response?.data || null
    });
  }
});

// POST /api/access/request
// Body: { gsCode, reason, sellerId, sellerEmail }
router.post('/access/request', async (req, res) => {
  try {
    const { gsCode, reason, sellerId } = req.body || {};
    if (!sellerId || !gsCode) {
      return res.status(400).json({ error: 'sellerId and gsCode are required' });
    }

    const backendUrl = process.env.INTERNAL_BACKEND_URL || 'http://localhost:5274';
    const response = await axios.post(
      `${backendUrl}/v1/products/access/request`,
      { gsCode, reason },
      {
        headers: {
          'x-internal-call': '1',
          'x-internal-user-id': sellerId
        }
      }
    );

    return res.json(response.data);
  } catch (error) {
    console.error('[access/request] proxy error:', error.response?.data || error.message);
    return res.status(error.response?.status || 500).json({
      error: error.response?.data?.message || error.message,
      details: error.response?.data || null
    });
  }
});

// POST /api/access/request-batch
// Body: { gsCodes, reason, sellerId }
router.post('/access/request-batch', async (req, res) => {
  try {
    const { gsCodes, reason, sellerId } = req.body || {};
    if (!sellerId || !Array.isArray(gsCodes) || gsCodes.length === 0) {
      return res.status(400).json({ error: 'sellerId and gsCodes[] are required' });
    }

    const backendUrl = process.env.INTERNAL_BACKEND_URL || 'http://localhost:5274';
    const response = await axios.post(
      `${backendUrl}/v1/products/access/request-batch`,
      { gsCodes, reason },
      {
        headers: {
          'x-internal-call': '1',
          'x-internal-user-id': sellerId
        }
      }
    );

    return res.json(response.data);
  } catch (error) {
    console.error('[access/request-batch] proxy error:', error.response?.data || error.message);
    return res.status(error.response?.status || 500).json({
      error: error.response?.data?.message || error.message,
      details: error.response?.data || null
    });
  }
});

// GET /api/access/requests?status=pending&role=admin|seller&actorId=...
router.get('/access/requests', async (req, res) => {
  try {
    const status = req.query.status || 'pending';
    const actorId = req.query.actorId;
    if (!actorId) {
      return res.status(400).json({ error: 'actorId is required' });
    }

    const backendUrl = process.env.INTERNAL_BACKEND_URL || 'http://localhost:5274';
    const response = await axios.get(`${backendUrl}/v1/products/access/requests`, {
      params: { status },
      headers: {
        'x-internal-call': '1',
        'x-internal-user-id': actorId
      }
    });

    return res.json(response.data);
  } catch (error) {
    console.error('[access/requests] proxy error:', error.response?.data || error.message);
    return res.status(error.response?.status || 500).json({
      error: error.response?.data?.message || error.message,
      details: error.response?.data || null
    });
  }
});

// POST /api/access/requests/:requestId/decision
// Body: { decision, note, actorId }
router.post('/access/requests/:requestId/decision', async (req, res) => {
  try {
    const { requestId } = req.params;
    const { decision, note, actorId } = req.body || {};

    if (!actorId || !decision) {
      return res.status(400).json({ error: 'actorId and decision are required' });
    }

    const backendUrl = process.env.INTERNAL_BACKEND_URL || 'http://localhost:5274';
    const response = await axios.post(
      `${backendUrl}/v1/products/access/requests/${requestId}/decision`,
      { decision, note },
      {
        headers: {
          'x-internal-call': '1',
          'x-internal-user-id': actorId
        }
      }
    );

    return res.json(response.data);
  } catch (error) {
    console.error('[access decision] proxy error:', error.response?.data || error.message);
    return res.status(error.response?.status || 500).json({
      error: error.response?.data?.message || error.message,
      details: error.response?.data || null
    });
  }
});

// GET /api/access/audit?actorId=...
router.get('/access/audit', async (req, res) => {
  try {
    const actorId = req.query.actorId;
    if (!actorId) {
      return res.status(400).json({ error: 'actorId is required' });
    }

    const backendUrl = process.env.INTERNAL_BACKEND_URL || 'http://localhost:5274';
    const response = await axios.get(`${backendUrl}/v1/products/access/audit`, {
      headers: {
        'x-internal-call': '1',
        'x-internal-user-id': actorId
      }
    });

    return res.json(response.data);
  } catch (error) {
    console.error('[access/audit] proxy error:', error.response?.data || error.message);
    return res.status(error.response?.status || 500).json({
      error: error.response?.data?.message || error.message,
      details: error.response?.data || null
    });
  }
});

// GET /api/existing-product/by-gs?code=GS...&vendorId=...
// Resolves old/new GS, validates seller access, and returns editable product payload.
router.get('/existing-product/by-gs', async (req, res) => {
  try {
    const code = String(req.query.code || '').trim();
    const vendorId = String(req.query.vendorId || '').trim();
    const actorRole = String(req.query.role || req.query.actorRole || '').trim().toLowerCase();
    const isSeller = actorRole === 'seller';

    if (!code) {
      return res.status(400).json({ error: 'code is required' });
    }

    if (isSeller && !vendorId) {
      return res.status(400).json({ error: 'vendorId is required for seller lookups' });
    }

    const backendUrl = process.env.INTERNAL_BACKEND_URL || 'http://localhost:5274';
    const response = await axios.get(`${backendUrl}/v1/products/check-communets-code`, {
      params: { code, vendorId, actorRole },
      headers: { 'x-internal-call': '1' }
    });

    const data = response.data || {};
    if (!data.exists || data.source !== 'main') {
      return res.status(404).json({ error: 'No such GS code in main product table' });
    }

    if (isSeller && !data.isMine) {
      return res.status(403).json({
        error: 'You do not have access to this GS code',
        exists: true,
        enteredCode: data.enteredCode,
        resolvedCode: data.resolvedCode,
        source: data.source,
        isMine: false,
        canEdit: false,
        product: data.product || null
      });
    }

    return res.json({
      exists: Boolean(data.exists),
      source: data.source,
      enteredCode: data.enteredCode,
      resolvedCode: data.resolvedCode,
      isAliasLookup: data.isAliasLookup,
      isMine: Boolean(data.isMine),
      canEdit: Boolean(data.isMine && data.fullProduct),
      product: data.fullProduct || data.product || null
    });
  } catch (error) {
    console.error('[existing-product/by-gs] proxy error:', error.response?.data || error.message);
    return res.status(error.response?.status || 500).json({
      error: error.response?.data?.message || error.message,
      details: error.response?.data || null
    });
  }
});

// GET /api/products/search?q=...&vendorId=...&role=...
// Search products by product name, new GS code, or old GS code for variant parent selection.
router.get('/products/search', async (req, res) => {
  try {
    const query = String(req.query.q || '').trim();
    const vendorId = String(req.query.vendorId || '').trim();
    const actorRole = String(req.query.role || req.query.actorRole || '').trim().toLowerCase();
    const isSeller = actorRole === 'seller';

    if (!query) {
      return res.json({ products: [] });
    }

    if (isSeller && !vendorId) {
      return res.status(400).json({ error: 'vendorId is required for seller searches' });
    }

    const backendUrl = process.env.INTERNAL_BACKEND_URL || 'http://localhost:5274';
    const response = await axios.get(`${backendUrl}/v1/products/`, {
      params: {
        search: query,
        page: 1,
        limit: 60,
        sellerId: isSeller ? vendorId : undefined,
      },
      headers: { 'x-internal-call': '1' }
    });

    const rawProducts = Array.isArray(response?.data?.products) ? response.data.products : [];
    const q = query.toLowerCase();
    const products = rawProducts
      .filter((p) => {
        const haystack = [p.productName, p.communetCode, p.legacyGsCode]
          .map((v) => String(v || '').toLowerCase());
        return haystack.some((txt) => txt.includes(q));
      })
      .map((p) => ({
        productId: p.productId,
        productName: p.productName,
        communetCode: p.communetCode,
        legacyGsCode: p.legacyGsCode || null,
        isVariant: Boolean(p.isVariant),
        isVariantParent: Boolean(p.isVariantParent),
        variantGroupId: p.variantGroupId || null,
        categoryName: p.categoryName || null,
      }));

    return res.json({ products });
  } catch (error) {
    console.error('[products/search] proxy error:', error.response?.data || error.message);
    return res.status(error.response?.status || 500).json({
      error: error.response?.data?.message || error.message,
      details: error.response?.data || null
    });
  }
});

// GET /api/variant-parent/:productId
// Fetch full parent product + variant family for prefill UI.
router.get('/variant-parent/:productId', async (req, res) => {
  try {
    const { productId } = req.params;
    const backendUrl = process.env.INTERNAL_BACKEND_URL || 'http://localhost:5274';
    const response = await axios.get(`${backendUrl}/v1/products/${encodeURIComponent(productId)}`, {
      headers: { 'x-internal-call': '1' }
    });
    return res.json(response.data || null);
  } catch (error) {
    console.error('[variant-parent] proxy error:', error.response?.data || error.message);
    return res.status(error.response?.status || 500).json({
      error: error.response?.data?.message || error.message,
      details: error.response?.data || null
    });
  }
});

// POST /api/product/finalize-variant
// Body: { vendorId, parentProductId, productData, variantAttributes, actorRole, actorId }
router.post('/product/finalize-variant', async (req, res) => {
  try {
    const {
      vendorId,
      parentProductId,
      productData,
      variantAttributes,
      actorRole,
      actorId,
    } = req.body || {};

    if (!parentProductId || !productData) {
      return res.status(400).json({ error: 'Missing parentProductId or productData.' });
    }

    const role = String(actorRole || '').trim().toLowerCase();
    const isSeller = role === 'seller';
    if (isSeller && !vendorId) {
      return res.status(400).json({ error: 'vendorId is required for seller variant creation.' });
    }

    const effectiveActorId = String(vendorId || actorId || 'system').trim();
    const backendUrl = process.env.INTERNAL_BACKEND_URL || 'http://localhost:5274';

    const rawImages = Array.isArray(productData.images)
      ? productData.images
      : String(productData.image_urls || productData.imageUrls || '')
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean);

    const payload = {
      productName: productData.productName,
      productOGCode: productData.productOGCode || null,
      unit: productData.unit,
      stockQuantity: productData.stockQuantity,
      wholeSale: productData.wholeSale,
      wholeSaleQuantity: productData.wholeSaleQuantity,
      retail: productData.retail,
      costPrice: productData.costPrice,
      description: productData.description,
      images: rawImages,
      variantAttributes: variantAttributes || {},
    };

    const response = await axios.post(
      `${backendUrl}/v1/products/${encodeURIComponent(parentProductId)}/variants`,
      payload,
      {
        headers: {
          'x-internal-call': '1',
          'x-internal-user-id': effectiveActorId,
          'Content-Type': 'application/json'
        }
      }
    );

    return res.json({ message: 'Variant saved successfully!', product: response?.data?.product || null });
  } catch (error) {
    console.error('[product/finalize-variant] proxy error:', error.response?.data || error.message);
    return res.status(error.response?.status || 500).json({
      error: error.response?.data?.message || error.message,
      details: error.response?.data || null
    });
  }
});

// PUT /api/existing-product/edit/:productId
// Body: { vendorId, updateData }
router.put('/existing-product/edit/:productId', async (req, res) => {
  try {
    const { productId } = req.params;
    const { vendorId, updateData, actorRole, actorId } = req.body || {};
    const role = String(actorRole || '').trim().toLowerCase();
    const isSeller = role === 'seller';
    const effectiveActorId = String(vendorId || actorId || 'system').trim();

    if (!updateData) {
      return res.status(400).json({ error: 'updateData is required' });
    }

    if (isSeller && !vendorId) {
      return res.status(400).json({ error: 'vendorId is required for seller edits' });
    }

    const backendUrl = process.env.INTERNAL_BACKEND_URL || 'http://localhost:5274';
    const response = await axios.put(
      `${backendUrl}/v1/products/edit/${encodeURIComponent(productId)}`,
      updateData,
      {
        headers: {
          'x-internal-call': '1',
          'x-internal-user-id': effectiveActorId,
          'Content-Type': 'application/json'
        }
      }
    );

    return res.json(response.data);
  } catch (error) {
    console.error('[existing-product/edit] proxy error:', error.response?.data || error.message);
    return res.status(error.response?.status || 500).json({
      error: error.response?.data?.message || error.message,
      details: error.response?.data || null
    });
  }
});



// POST /api/upload - Handle image enhancement and proxy to Communets S3
router.post('/upload', upload.array('images', 4), async (req, res) => {
  try {
    const files = req.files;
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No files provided' });
    }
    
    // Check if image enhancement is disabled or configured individually via query parameter
    const enhanceParam = req.query.enhance || 'true';
    const enhanceFlags = enhanceParam.includes(',')
      ? enhanceParam.split(',').map(v => v.trim() !== 'false')
      : [];

    const uploadedUrls = [];
    const fileErrors = [];

    for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
      const file = files[fileIdx];
      try {
        let currentFileBuffer = file.buffer;
        let filename = file.originalname;
        let targetMimeType = file.mimetype || 'image/jpeg';
        let enhanced = false;

        const isImageEnhanced = enhanceFlags.length > 0
          ? enhanceFlags[fileIdx] === true
          : (enhanceParam !== 'false');

        const enhanceApiUrl = isImageEnhanced ? process.env.ENHANCE_API_URL : null;
        const skipEnhance = !isImageEnhanced;

        if (enhanceApiUrl) {
          try {
            const cleanEnhanceUrl = enhanceApiUrl.trim();
            const form = new FormData();
            form.append('file', currentFileBuffer, {
              filename: filename,
              contentType: targetMimeType
            });
            form.append('format', 'webp');

            const formHeaders = form.getHeaders();
            formHeaders['Content-Length'] = form.getLengthSync();

            console.log(`[Enhancer] Enhancing ${filename} via ${cleanEnhanceUrl}...`);
            const enhanceRes = await axios.post(cleanEnhanceUrl, form, {
              headers: formHeaders,
              responseType: 'arraybuffer',
              timeout: 120000,
              httpsAgent: new https.Agent({ rejectUnauthorized: false })
            });
            currentFileBuffer = Buffer.from(enhanceRes.data);
            filename = filename.replace(/\.[^.]+$/, '') + '_enhanced.webp';
            targetMimeType = 'image/webp';
            enhanced = true;
            console.log(`[Enhancer] Success for ${filename}`);
          } catch (enhanceErr) {
            console.error('[Enhancer] FAILED code:', enhanceErr.code);
            console.error('[Enhancer] FAILED message:', enhanceErr.message);
            console.error('[Enhancer] HTTP status:', enhanceErr.response?.status);
          }
        }

        // Fallback: local enhancement on this server so uploads still get optimized.
        if (!enhanced && !skipEnhance) {
          try {
            currentFileBuffer = await enhanceImageLocally(currentFileBuffer);
            filename = filename.replace(/\.[^.]+$/, '') + '_enhanced.webp';
            targetMimeType = 'image/webp';
            console.log(`[Enhancer] Local fallback success for ${filename}`);
          } catch (localEnhanceErr) {
            console.error('[Enhancer] Local fallback failed:', localEnhanceErr.message);
          }
        }

        // Upload compressed result directly to S3.
        const previewUrl = await uploadBufferToS3(currentFileBuffer, filename);
        if (previewUrl) uploadedUrls.push(previewUrl);
      } catch (fileErr) {
        console.error(`[Upload] File failed (${file?.originalname || 'unknown'}):`, fileErr.message);
        fileErrors.push({
          fileName: String(file?.originalname || 'unknown'),
          error: fileErr.message,
          status: fileErr.response?.status || null,
          details: fileErr.response?.data || null,
        });
      }
    }

    if (uploadedUrls.length === 0) {
      return res.status(500).json({
        error: 'All image uploads failed',
        fileErrors,
      });
    }

    res.json({ urls: uploadedUrls, fileErrors });
  } catch (error) {
    console.error('Upload Error:', error.message, error.response?.data || '');
    res.status(500).json({ error: error.message, details: error.response?.data || null });
  }
});
// GET /api/manufacturers - Read directly from the unified MongoDB
router.get('/manufacturers', async (req, res) => {
  try {
    const manufacturers = await Manufacturer.find({}).sort({ manufacturerId: 1 }).select('-_id manufacturerId manufacturerName');
    res.json(manufacturers);
  } catch (err) {
    console.error('Fetch Manufacturers Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});



// POST /api/product/generate
function isUsableGeneratedText(value = '') {
  const text = String(value || '').trim();
  if (!text) return false;
  if (/^(auto[-\s]?generated|fallback|n\/a|none)$/i.test(text)) return false;
  return text.length >= 8;
}

function getFallbackTitle(original = {}) {
  const candidate = String(
    original?.product_name ||
    original?.productName ||
    original?.description ||
    ''
  ).trim();
  return candidate || 'Untitled Product';
}

function normalizeAiContentWithFallback(finalData = {}, original = {}) {
  const base = (finalData && typeof finalData === 'object') ? { ...finalData } : {};
  const hasGeneratedContent = base.generated_content && typeof base.generated_content === 'object';
  const uiData = hasGeneratedContent ? { ...base.generated_content } : { ...base };

  const fallbackTitle = getFallbackTitle(original);
  const rawTitle = String(uiData.seo_title || uiData.title || '').trim();
  const safeTitle = rawTitle || fallbackTitle;

  const overview = String(uiData.overview || '').trim();
  const detailed = String(uiData.detailed_description || uiData.description || '').trim();
  const safeDescription = detailed || overview || `Product information for ${safeTitle}.`;

  uiData.seo_title = safeTitle;
  if (!String(uiData.title || '').trim()) uiData.title = safeTitle;

  const originalName = String(original.product_name || original.productName || '').trim();
  if (original.keepOriginalName && originalName) {
    uiData.seo_title = originalName;
    uiData.title = originalName;
  }

  uiData.detailed_description = safeDescription;
  if (!String(uiData.overview || '').trim()) uiData.overview = safeDescription;

  if (hasGeneratedContent) {
    base.generated_content = uiData;
    return base;
  }

  return uiData;
}

function isUsableAiResult(finalData = {}, original = {}) {
  if (!finalData || typeof finalData !== 'object') return false;
  if (finalData.fallback === true) return false;

  const uiData = finalData.generated_content || finalData || {};
  const title = String(uiData.seo_title || uiData.title || '').trim();
  const overview = String(uiData.overview || '').trim();
  const desc = String(uiData.detailed_description || '').trim();
  const combined = `${overview} ${desc}`.trim();

  if (!isUsableGeneratedText(title)) return false;
  if (!isUsableGeneratedText(combined)) return false;

  const originalName = String(original?.product_name || original?.productName || '').trim().toLowerCase();
  const titleLower = title.toLowerCase();
  if (originalName && (titleLower === originalName || titleLower === `${originalName} | general`)) {
    return false;
  }

  return true;
}

function buildAiFailure(err) {
  if (err?.reasonCode === 'AI_INVALID_RESPONSE') {
    return {
      status: 502,
      reasonCode: 'AI_INVALID_RESPONSE',
      retryable: true,
      error: String(err?.message || 'AI returned incomplete content. Please retry.')
    };
  }

  const status = Number(err?.response?.status || err?.status || 0);
  const detailRaw = err?.response?.data?.message || err?.response?.data?.error || err?.message || '';
  const detail = String(detailRaw || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  const suffix = detail ? ` Details: ${detail}` : '';

  if (status === 429) {
    return { status: 429, reasonCode: 'AI_RATE_LIMIT', retryable: true, error: `AI service is rate-limited (429). Please retry shortly.${suffix}` };
  }
  if (status === 530) {
    return { status: 503, reasonCode: 'AI_UPSTREAM_UNAVAILABLE', retryable: true, error: `AI service is unavailable (Cloudflare 530). Please retry after a short wait.${suffix}` };
  }
  if (status === 401 || status === 403) {
    return { status: 502, reasonCode: 'AI_AUTH_ERROR', retryable: false, error: `AI service rejected the request (${status}). Check webhook authentication/configuration.${suffix}` };
  }
  if (status >= 500) {
    return { status: 503, reasonCode: 'AI_UPSTREAM_UNAVAILABLE', retryable: true, error: `AI service upstream error (${status}). Please retry shortly.${suffix}` };
  }
  if (status >= 400) {
    return { status: 400, reasonCode: 'AI_BAD_REQUEST', retryable: false, error: `AI service rejected the payload (${status}). Please verify product input fields and retry.${suffix}` };
  }

  const code = String(err?.code || '').toUpperCase();
  const message = String(err?.message || '').trim();
  if (code === 'ECONNABORTED' || /timeout/i.test(message)) {
    return { status: 504, reasonCode: 'AI_TIMEOUT', retryable: true, error: 'AI request timed out while generating content. Please retry.' };
  }
  if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT'].includes(code)) {
    return { status: 503, reasonCode: 'AI_NETWORK_ERROR', retryable: true, error: `Could not reach AI service (${code}). Check network/tunnel and retry.` };
  }

  return { status: 503, reasonCode: 'AI_UNAVAILABLE', retryable: true, error: `AI generation failed. ${message || 'Please retry.'}` };
}

router.post('/product/generate', async (req, res) => {
  try {
    const payload = req.body;
    if (!process.env.N8N_SEARCH_WEBHOOK) {
      return res.status(503).json({
        reasonCode: 'AI_CONFIG_ERROR',
        retryable: false,
        error: 'AI webhook is not configured. Contact admin to set N8N_SEARCH_WEBHOOK.'
      });
    }

    // Retry transient upstream failures before hard-failing.
    const maxAttempts = 3;
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await axios.post(process.env.N8N_SEARCH_WEBHOOK, payload, { timeout: 45000 });
        const normalized = Array.isArray(response.data) && response.data[0] && response.data[0].json
          ? response.data[0].json
          : response.data;
        const withFallback = normalizeAiContentWithFallback(normalized, payload);

        return res.json(withFallback);
      } catch (err) {
        lastError = err;
        if (err?.reasonCode === 'AI_INVALID_RESPONSE') {
          if (attempt === maxAttempts) break;
          await new Promise((resolve) => setTimeout(resolve, attempt * 1200));
          continue;
        }

        const status = err.response?.status;
        const retryable = !status || status >= 500 || status === 429;
        if (!retryable || attempt === maxAttempts) break;
        await new Promise((resolve) => setTimeout(resolve, attempt * 1200));
      }
    }

    console.error('Generate Error:', lastError?.message || 'Unknown upstream failure');
    if (lastError?.response?.data) {
      console.error('n8n Response Body:', JSON.stringify(lastError.response.data, null, 2));
    }

    const failure = buildAiFailure(lastError || new Error('AI generation failed'));
    return res.status(failure.status).json(failure);
  } catch (error) {
    console.error('Generate Error:', error.message);
    if (error.response && error.response.data) {
      console.error('n8n Response Body:', JSON.stringify(error.response.data, null, 2));
    }
    const failure = buildAiFailure(error);
    return res.status(failure.status).json(failure);
  }
});

// POST /api/product/finalize
router.post('/product/finalize', async (req, res) => {
  try {
    const { vendorId, productData } = req.body;
    if (!vendorId || !productData) {
      return res.status(400).json({ error: "Missing vendorId or productData." });
    }

    const payload = { ...productData };
    const idempotencyKey = String(payload.idempotencyKey || '').trim();
    delete payload.idempotencyKey;
    delete payload.communetsCode;

    const backendUrl = process.env.INTERNAL_BACKEND_URL || 'http://localhost:5274';

    // ── EAN/SKU Duplicate Check → Upsert Logic (same as bulk finalize) ──
    const eanToCheck = String(payload.productOGCode || payload.ean || '').trim();
    let saveFlow = 'new-product';

    console.log(`[single-finalize] vendorId=${vendorId} eanToCheck="${eanToCheck}" (productOGCode="${payload.productOGCode}" ean="${payload.ean}")`);

    if (eanToCheck) {
      try {
        const checkRes = await axios.get(`${backendUrl}/v1/products/check-ean`, {
          params: { ean: eanToCheck, vendorId },
          headers: { 'x-internal-call': '1', 'x-internal-user-id': vendorId }
        });

        console.log(`[single-finalize] check-ean response:`, JSON.stringify(checkRes.data));

        if (checkRes.data?.exists && checkRes.data?.isMine && checkRes.data?.product) {
          // Product with same EAN already exists for this seller → UPDATE instead of CREATE
          const existingProduct = checkRes.data.product;
          const productId = existingProduct.productId || existingProduct._id;

          console.log(`[single-finalize] EAN "${eanToCheck}" already exists for vendor ${vendorId} (productId: ${productId}). Updating instead of creating.`);

          // Build edit payload — send all fields that were provided
          const editPayload = { ...payload };
          delete editPayload.productOGCode; // don't override EAN on update

          await axios.put(
            `${backendUrl}/v1/products/edit/${encodeURIComponent(productId)}`,
            editPayload,
            {
              headers: {
                'x-internal-call': '1',
                'x-internal-user-id': vendorId,
                'Content-Type': 'application/json'
              }
            }
          );

          return res.json({
            message: "Product already existed — updated successfully! (No duplicate created)",
            saveFlow: 'preexist-override',
            overrideApplied: true,
            existingProductId: productId,
            product: {
              communetCode: existingProduct.communetCode || existingProduct.communetsCode || '',
              productId: productId,
            }
          });
        } else {
          console.log(`[single-finalize] No override: exists=${checkRes.data?.exists} isMine=${checkRes.data?.isMine} hasProduct=${Boolean(checkRes.data?.product)}`);
        }
      } catch (eanErr) {
        // EAN check failed — proceed with normal add (fail-open)
        console.warn('[single-finalize] EAN check failed, proceeding with add:', eanErr.message);
      }
    } else {
      console.log(`[single-finalize] eanToCheck is empty — skipping EAN check, will create new product`);
    }

    // ── Normal flow: create new product ──
    const response = await axios.post(`${backendUrl}/v1/products/add`, payload, {
      headers: {
        'x-internal-call': '1',
        'x-internal-user-id': vendorId,
        ...(idempotencyKey ? { 'x-idempotency-key': idempotencyKey } : {}),
      }
    });

    res.json({ message: "Successfully saved to Catalog!", product: response.data.product, saveFlow });
  } catch (error) {
    console.error('Finalize Error:', error.message);
    const backendErrorMsg = error.response?.data?.message || error.response?.data?.error || error.message;
    res.status(500).json({ error: backendErrorMsg });
  }
});

// Catch-all proxy to main backend for unhandled routes (categories, subcategories, manufacturers, etc)
router.all(/.*/, async (req, res) => {
  try {
    const backendUrl = process.env.INTERNAL_BACKEND_URL || 'http://localhost:5274';
    let path = req.path;
    const queryString = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';

    // Forward categories/subcategories/manufacturers requests to /v1/ endpoints.
    // Main backend expects subcategories as /v1/categories?parentId=<id>.
    if (path.startsWith('/categories/')) {
      const parentId = path.split('/')[2];
      path = `/v1/categories?parentId=${encodeURIComponent(parentId || '')}`;
    } else if (path === '/categories') {
      path = '/v1/categories';
    } else if (path.startsWith('/manufacturers')) {
      path = `/v1${path}`;
    }
    
    const fullUrl = `${backendUrl}${path}${queryString && !path.includes('?') ? queryString : ''}`;
    
    const config = {
      method: req.method,
      url: fullUrl,
      headers: {
        'x-internal-call': '1',
        'Content-Type': req.get('content-type') || 'application/json',
      },
      timeout: INTERNAL_CALL_TIMEOUT_MS,
    };
    
    if (req.body && Object.keys(req.body).length > 0) {
      config.data = req.body;
    }
    
    const response = await axios(config);
    res.status(response.status).json(response.data);
  } catch (error) {
    console.error(`[catch-all proxy] error for ${req.method} ${req.path}:`, error.message);
    const status = error.response?.status || 500;
    const data = error.response?.data || { error: error.message };
    res.status(status).json(data);
  }
});

export default router;
