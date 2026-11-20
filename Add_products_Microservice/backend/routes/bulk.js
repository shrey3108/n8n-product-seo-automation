import express from 'express';
import multer from 'multer';
import path from 'path';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import crypto from 'crypto';
import XLSX from 'xlsx';
import AdmZip from 'adm-zip';
import axios from 'axios';
import FormData from 'form-data';
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { createJob, getJob, getAllJobs, stopJob, setJobAutoSave } from '../services/queue.js';

dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), '../../backend/.env') });

const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
const BUCKET_NAME = process.env.AWS_S3_BUCKET_NAME || process.env.S3_BUCKET_NAME || 'communets-lightsail-bucket';

// ── Direct S3 uploader (no temp-media staging) ───────────────
async function uploadBufferToS3(imageBuffer, filename) {
  try {
    if (!imageBuffer || imageBuffer.length === 0) return null;

    // Compress to webp if Sharp is available
    let compressed = imageBuffer;
    try {
      const { default: sharp } = await import('sharp');
      compressed = await sharp(imageBuffer)
        .webp({ quality: 75 })
        .toBuffer();
    } catch (_) {
      // Sharp is optional; use raw buffer if unavailable
    }

    const ext = '.webp';
    const safeName = path.basename(String(filename || 'image'), path.extname(filename))
      .replace(/[^a-zA-Z0-9-_]/g, '_')
      .slice(0, 60);
    const key = `product-images/${Date.now()}_${uuidv4().slice(0, 8)}_${safeName}${ext}`;

    await s3.send(new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      Body: compressed,
      ContentType: 'image/webp',
      ContentDisposition: 'inline',
    }));

    return `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${key}`;
  } catch (err) {
    console.error('[Direct S3 Upload]', err.message);
    return null;
  }
}

const router = express.Router();
const DEFAULT_PRODUCT_IMAGE_URL = '/v1/public/default-no-image.png';

const sanitizeImageUrl = (value = '') => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw;
};

const resolveImageUrl = async (url) => {
  const trimmed = String(url || '').trim();
  if (!trimmed) return '';

  const kommodoMatch = trimmed.match(/https?:\/\/(?:www\.)?(?:kommodo\.ai|komododecks\.com)\/i\/([a-zA-Z0-9_-]+)/);
  if (!kommodoMatch) return trimmed;

  try {
    const response = await axios.get(trimmed, { timeout: 5000 });
    const html = response.data;
    const ogImageMatch = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i) 
      || html.match(/<meta\s+content="([^"]+)"\s+property="og:image"/i)
      || html.match(/"imageUrl"\s*:\s*"([^"]+)"/i);
      
    if (ogImageMatch && ogImageMatch[1]) {
      return ogImageMatch[1];
    }
  } catch (err) {
    console.warn(`[resolveImageUrl] Failed to resolve Kommodo URL ${trimmed}:`, err.message);
  }
  return trimmed;
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB max
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.xlsx' || ext === '.pdf') return cb(null, true);
    cb(new Error('Only .xlsx and .pdf files are allowed'));
  }
});

async function extractEmbeddedImageUrlsByRow(fileBuffer, headerIndex = 0, options = {}) {
  const result = new Map();
  const allowedRows = options.allowedRows instanceof Set ? options.allowedRows : null;
  const maxUploads = Number.isFinite(options.maxUploads) && options.maxUploads > 0
    ? options.maxUploads
    : Number.MAX_SAFE_INTEGER;

  const zip = new AdmZip(fileBuffer);
  const entries = zip.getEntries();

  const mediaMap = {};
  for (const entry of entries) {
    if (!entry.entryName.startsWith('xl/media/')) continue;
    const filename = path.basename(entry.entryName);
    const ext = path.extname(filename).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext)) continue;
    mediaMap[filename] = entry.getData();
  }

  const relMap = {};
  for (const entry of entries.filter((e) => /xl\/drawings\/_rels\/drawing\d+\.xml\.rels$/.test(e.entryName))) {
    const drawingName = path.basename(entry.entryName).replace('.rels', '');
    const xml = entry.getData().toString('utf8');
    const relRegex = /<Relationship[^>]*Id="([^"]+)"[^>]*Target="\.\.\/media\/([^"]+)"/g;
    for (const match of xml.matchAll(relRegex)) {
      const rId = match[1];
      const mediaFilename = match[2];
      relMap[`${drawingName}:${rId}`] = mediaFilename;
      if (!relMap[rId]) relMap[rId] = mediaFilename;
    }
  }

  const refs = [];
  for (const entry of entries.filter((e) => /xl\/drawings\/drawing\d+\.xml$/.test(e.entryName))) {
    const drawingName = path.basename(entry.entryName);
    const xml = entry.getData().toString('utf8');
    const anchorRegex = /<xdr:(?:oneCellAnchor|twoCellAnchor)[^>]*>([\s\S]*?)<\/xdr:(?:oneCellAnchor|twoCellAnchor)>/g;
    for (const anchor of xml.matchAll(anchorRegex)) {
      const block = anchor[1];
      const rowMatch = block.match(/<xdr:row>(\d+)<\/xdr:row>/);
      const embedMatches = [...block.matchAll(/r:embed="([^"]+)"/g)];
      if (!rowMatch || embedMatches.length === 0) continue;
      const excelRow = parseInt(rowMatch[1], 10) + 1;
      for (const em of embedMatches) {
        refs.push({ drawingName, rId: em[1], excelRow });
      }
    }
  }

  const filteredRefs = refs
    .filter((ref) => {
      if (ref.excelRow <= headerIndex + 1) return false;
      if (allowedRows && !allowedRows.has(ref.excelRow)) return false;
      return true;
    })
    .sort((a, b) => a.excelRow - b.excelRow);

  const tasks = [];
  let queued = 0;
  for (const ref of filteredRefs) {
    if (queued >= maxUploads) break;
    const mediaFilename = relMap[`${ref.drawingName}:${ref.rId}`] || relMap[ref.rId];
    const mediaBuffer = mediaMap[mediaFilename];
    if (!mediaBuffer) continue;
    queued += 1;
    tasks.push({ row: ref.excelRow, mediaFilename, mediaBuffer });
  }

  const concurrency = 4;
  for (let i = 0; i < tasks.length; i += concurrency) {
    const chunk = tasks.slice(i, i + concurrency);
    const uploaded = await Promise.all(
      chunk.map(async (task) => {
        try {
          let buf = task.mediaBuffer;
          try {
            const { default: sharp } = await import('sharp');
            buf = await sharp(buf)
              .resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality: 75 })
              .toBuffer();
          } catch (_) {
            // sharp is optional in local dev
          }

          const url = await uploadBufferToS3(buf, `xlsx_${task.mediaFilename}`);
          return { row: task.row, url: url || '' };
        } catch (_) {
          return { row: task.row, url: '' };
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

// ─── EXCEL TEMPLATE DOWNLOAD ────────────────────────────────────────────────
// GET /api/bulk/template  → downloads a pre-formatted xlsx with all 21 headers
router.get('/template', (req, res) => {
  const templateHeaders = [
    'Product Name', 'Communets Code', 'SKU / EAN', 'Brand / Manufacturer', 'Category', 'Subcategory',
    'Unit', 'Stock Quantity', 'Min. Wholesale Qty',
    'Wholesale Price', 'Retail Price', 'Cost Price',
    'Image URL 1', 'Image URL 2', 'Image URL 3', 'Image URL 4',
  ];

  const wb = XLSX.utils.book_new();
  // Row 1: headers, Row 2: example row
  const wsData = [
    templateHeaders,
    [
      'Sample Product A', '', 'SKU-001', 'Acme Corp', 'Computer Products', 'Computer Accessories',
      'Piece', '100', '5',
      '450.00', '599.00', '320.00',
      'https://example.com/img1.jpg', '', '', ''
    ]
  ];
  const ws = XLSX.utils.aoa_to_sheet(wsData);

  // Style: make header row wider
  ws['!cols'] = templateHeaders.map(() => ({ wch: 22 }));
  XLSX.utils.book_append_sheet(wb, ws, 'Products');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="communets_bulk_template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ─── XLSX PARSER ─────────────────────────────────────────────────────────────
router.post('/parse-xlsx', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    if (raw.length < 2) {
      return res.status(422).json({ error: 'Spreadsheet appears to be empty or has no data rows.' });
    }

    // First non-empty row is assumed to be the header
    const headerRow = raw.find(r => r.some(c => c !== ''));
    const headerIndex = raw.indexOf(headerRow);
    const headers = headerRow.map((h, idx) => {
      const name = String(h ?? '').trim();
      return name ? { name, idx } : null;
    });
    const dataRows = raw.slice(headerIndex + 1).filter(r => r.some(c => c !== ''));

    // Map each data row to an object using headers
    const rows = dataRows.map(row => {
      const obj = {};
      headers.forEach((header) => {
        if (!header || !header.name) return;
        obj[header.name] = String(row[header.idx] ?? '').trim();
      });
      return obj;
    });

    // Attempt column matching against our known fields
    // Ordered to check most specific terms first
    const fieldMap = [
      { field: 'product_name', aliases: ['product name', 'name', 'product', 'item name', 'item', 'title'] },
      { field: 'communetsCode', aliases: ['communets code', 'communet code', 'communetscode', 'communets-code', 'communets code (gs)', 'communets code gs', 'gs code', 'new gs', 'new gs code', 'gs', 'communets'] },
      { field: 'brand', aliases: ['brand', 'manufacturer', 'make'] },
      { field: 'ean', aliases: ['ean', 'barcode', 'upc', 'gtin', 'sku', 'model code', 'model'] },
      { field: 'subcategory', aliases: ['sub-category', 'sub category', 'subcategory'] },
      { field: 'category', aliases: ['category', 'cat', 'type'] }, // category must be after subcategory for .includes
      { field: 'unit', aliases: ['selling unit', 'unit', 'uom'] },
      { field: 'stockQty', aliases: ['stock quantity', 'stock qty', 'stock', 'qty', 'inventory', 'available qty'] },
      { field: 'wholesale_qty', aliases: ['wholesale min qty', 'wholesale qty', 'min qty', 'min order', 'minimum qty'] },
      { field: 'price_retail', aliases: ['retail price', 'msrp', 'rrp', 'selling price', 'mrp'] },
      { field: 'costPrice', aliases: ['cost price', 'cost', 'purchase price', 'buying price', 'landed cost'] },
      { field: 'price_wholesale', aliases: ['wholesale price', 'trader price', 'dealer price', 'price'] }, // price last
      // Image URLs ordered so that 2/3/4 must match before generic 'image' matches image_url
      { field: 'image_url_4', aliases: ['image uri 4', 'image url 4', 'image 4', 'photo 4', 'picture 4'] },
      { field: 'image_url_3', aliases: ['image uri 3', 'image url 3', 'image 3', 'photo 3', 'picture 3'] },
      { field: 'image_url_2', aliases: ['image uri 2', 'image url 2', 'image 2', 'photo 2', 'picture 2'] },
      { field: 'image_url', aliases: ['image uri 1', 'image uri', 'image url 1', 'image url', 'image link', 'image 1', 'image', 'photo', 'picture'] },
    ];

    const detectedMapping = {};
    const unmappedColumns = [];

    headers.forEach((header) => {
      if (!header?.name) return;
      const h = header.name;
      const lower = h.toLowerCase();
      let matched = false;

      // Pass 1: exact match
      for (const { field, aliases } of fieldMap) {
        if (detectedMapping[field]) continue; // already found a column for this field
        if (aliases.some(a => lower === a)) {
          detectedMapping[field] = h;
          matched = true;
          break;
        }
      }

      // Pass 2: substring match (fallback)
      if (!matched) {
        for (const { field, aliases } of fieldMap) {
          if (detectedMapping[field]) continue;
          if (aliases.some(a => lower.includes(a))) {
            detectedMapping[field] = h;
            matched = true;
            break;
          }
        }
      }

      if (!matched) unmappedColumns.push(h);
    });

    const missingRequired = ['product_name'].filter(f => !detectedMapping[f]);

    let embeddedImageCount = 0;
    try {
      const allowedRows = new Set(rows.map((_, idx) => headerIndex + 2 + idx));
      const embeddedByRow = await extractEmbeddedImageUrlsByRow(req.file.buffer, headerIndex, {
        allowedRows,
        maxUploads: rows.length * 4,
      });

      embeddedImageCount = Array.from(embeddedByRow.values()).reduce((sum, arr) => sum + arr.length, 0);

      if (embeddedImageCount > 0) {
        const imageFields = ['image_url', 'image_url_2', 'image_url_3', 'image_url_4'];
        rows.forEach((rowObj, idx) => {
          const excelRow = headerIndex + 2 + idx;
          const embeddedList = embeddedByRow.get(excelRow) || [];
          if (embeddedList.length === 0) return;

          embeddedList.forEach((url) => {
            for (const field of imageFields) {
              const mappedCol = detectedMapping[field];
              if (mappedCol && !rowObj[mappedCol]) {
                rowObj[mappedCol] = url;
                return;
              }
              if (!mappedCol) {
                const syntheticCol = `__emb_${field}`;
                detectedMapping[field] = syntheticCol;
                if (!rowObj[syntheticCol]) {
                  rowObj[syntheticCol] = url;
                  return;
                }
              }
            }
          });
        });
      }
    } catch (imgErr) {
      console.warn('[parse-xlsx] Embedded image extraction failed:', imgErr.message);
    }

    // Resolve any Kommodo image URLs in parallel before returning
    try {
      const imageFields = ['image_url', 'image_url_2', 'image_url_3', 'image_url_4'];
      const resolveTasks = [];
      rows.forEach((rowObj) => {
        imageFields.forEach((field) => {
          const colName = detectedMapping[field];
          if (colName && rowObj[colName]) {
            const originalUrl = rowObj[colName];
            resolveTasks.push((async () => {
              const resolved = await resolveImageUrl(originalUrl);
              if (resolved !== originalUrl) {
                console.log(`[resolve-kommodo] Resolved ${originalUrl} -> ${resolved}`);
                rowObj[colName] = resolved;
              }
            })());
          }
        });
      });
      if (resolveTasks.length > 0) {
        await Promise.all(resolveTasks);
      }
    } catch (resolveErr) {
      console.warn('[parse-xlsx] URL resolution error:', resolveErr.message);
    }

    res.json({
      type: 'xlsx',
      sheetName,
      columns: headers,
      detectedMapping,
      unmappedColumns,
      missingRequired,
      count: rows.length,
      rows,
      embeddedImageCount,
    });
  } catch (err) {
    console.error('[parse-xlsx]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── PDF PARSER ──────────────────────────────────────────────────────────────
router.post('/parse-pdf', upload.single('file'), async (req, res) => {
  let tmpDir = null;
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    // 1. Save PDF to temp file
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bulkpdf-'));
    const pdfPath = path.join(tmpDir, 'input.pdf');
    await fs.writeFile(pdfPath, req.file.buffer);

    // 2. Extract text using pdftotext -layout (handles RTL/bidi layout correctly)
    const text = await new Promise((resolve, reject) => {
      execFile('pdftotext', ['-layout', pdfPath, '-'], { maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    });

    // 3. Parse product rows from text
    const rows = parsePdfCatalogText(text);

    // 4. Extract images using pdfimages
    const imagePrefix = path.join(tmpDir, 'img');
    await new Promise((resolve) => {
      execFile('pdfimages', ['-j', pdfPath, imagePrefix], () => resolve());
    });

    // 5. Collect extracted image files (sorted so order matches PDF order)
    const allFiles = await fs.readdir(tmpDir);
    const imgFiles = allFiles
      .filter(f => /\.(jpg|jpeg|png|ppm|pbm)$/i.test(f))
      .sort()
      .map(f => path.join(tmpDir, f));

    // 6. Compress + upload images to S3 in batches of 10
    const uploadOne = async (imgPath) => {
      try {
        const raw = await fs.readFile(imgPath);
        const { default: sharp } = await import('sharp');
        const compressed = await sharp(raw)
          .resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 75 })
          .toBuffer();
        const url = await uploadBufferToS3(compressed, path.basename(imgPath) + '.jpg');
        console.log(`[s3] ✅ ${path.basename(imgPath)} → ${(url||'').slice(-40)}`);
        return url || '';
      } catch (e) {
        console.error(`[s3] ❌ ${path.basename(imgPath)}: ${e.message}`);
        return '';
      }
    };

    // Upload in parallel batches of 10 (safe for free tier + laptop memory)
    const BATCH = 10;
    const imageUrls = [];
    for (let i = 0; i < imgFiles.length; i += BATCH) {
      const batch = imgFiles.slice(i, i + BATCH);
      console.log(`[s3] batch ${Math.floor(i/BATCH)+1}/${Math.ceil(imgFiles.length/BATCH)} — uploading ${batch.length} images...`);
      const batchUrls = await Promise.all(batch.map(uploadOne));
      imageUrls.push(...batchUrls);
    }
    console.log(`[s3] ✅ ${imageUrls.filter(Boolean).length}/${imgFiles.length} uploaded`);

    // 7. Assign uploaded image URLs to product rows (1 image per product, in order)
    let imgIdx = 0;
    for (const row of rows) {
      if (imgIdx < imageUrls.length && imageUrls[imgIdx]) {
        row.image_url = imageUrls[imgIdx++];
      } else {
        imgIdx++;
      }
    }

    // 8. Cleanup temp files
    fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    tmpDir = null;

    const detectedMapping = {
      product_name: 'Product Name',
      ean: 'Model/SKU',
      price_wholesale: 'Wholesale Price',
      price_retail: 'Retail Price',
    };

    res.json({
      type: 'pdf',
      columns: ['Row#', 'Model/SKU', 'Product Name', 'Wholesale Price', 'Retail Price', 'Image'],
      detectedMapping,
      unmappedColumns: [],
      missingRequired: [],
      count: rows.length,
      rows,
      // No more images array — URLs are embedded in each row
    });
  } catch (err) {
    console.error('[parse-pdf]', err);
    if (tmpDir) fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

// ─── PDF TEXT ROW PARSER ─────────────────────────────────────────────────────
function parsePdfCatalogText(text) {
  const rows = [];
  const seenProducts = new Set();

  // Strip ONLY the RTL/Arabic characters; keep all latin text and spacing intact
  const stripNonLatin = (s) => s
    .replace(/[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/g, '') // Arabic script
    .replace(/[\u200F\u200E\u202A-\u202E\u2066-\u2069\u206A-\u206F\u202C\u202D\u202B\uFEFF]/g, '') // bidi controls
    .replace(/\u2013|\u2014/g, '-') // em/en dashes
    .replace(/[()]/g, ' ') // remove parentheses (appear around Deco pack counts)
    .replace(/\s+/g, ' ')
    .trim();

  const lines = text.split('\n');

  const priceEndRe = /(\d{2,6}\.\d{2})\s+(\d{2,6}\.\d{2})\s*$/;
  const skuRe = /^((?:Archer|Deco|EAP|TL-|RE|CPE|SG-|TF-|MC|UE|Tapo|WR)\s*[A-Za-z0-9][A-Za-z0-9\-+]*(?:\s+(?:Plus|Pro|Lite|V\d))?)\s+(.+)/i;
  const codeRe = /^([A-Z]{2,5}[A-Z0-9\-]{2,})\s+([A-Z].+)/;
  const isHeader = (s) => /^\s*(s\/n|product\s+number|price|description|picture|with\s+vat|out\s+vat|tp-link\s+price)/i.test(s);

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = stripNonLatin(rawLine);
    if (!line || line.length < 8) continue;
    if (isHeader(line)) continue;

    // Remove leading row number for sku check
    const nameCheck = line.replace(/^\d{1,3}\s+/, '').replace(/^\)\s*\d*\s*/, '').trim();
    const hasSku = skuRe.test(nameCheck) || codeRe.test(nameCheck);
    const priceM = line.match(priceEndRe);

    let wp, rp;
    let fullLine = line;

    if (hasSku && !priceM) {
      // Name/SKU is on this line, but prices wrapped to next line
      let foundPrices = false;
      for (let j = 1; j <= 2; j++) {
        if (i + j >= lines.length) break;
        const look = stripNonLatin(lines[i + j]);
        const lookM = look.match(priceEndRe);
        if (lookM) {
          wp = lookM[1];
          rp = lookM[2];
          foundPrices = true;
          // Important: advance 'i' so we don't process the price line independently
          i = i + j;
          break;
        }
      }
      if (!foundPrices) continue;
    } else if (priceM) {
      // Prices are on exactly this line (maybe with SKU, maybe not, but it's a valid row)
      wp = priceM[1];
      rp = priceM[2];
      fullLine = line.replace(priceEndRe, '').trim(); // strip prices for parsing name
    } else {
      continue;
    }

    let left = fullLine;

    // Extract row number
    let rn = '';
    const rnM = left.match(/^(\d{1,3})\s+(.*)/);
    if (rnM) { rn = rnM[1]; left = rnM[2].trim(); }
    left = left.replace(/^\)\s*\d*\s*/, '').trim();

    // Extract SKU / model code
    let sku = '';
    let name = left;

    const skuMatch = name.match(skuRe);
    if (skuMatch) {
      sku = skuMatch[1].trim();
      name = skuMatch[2].trim();
    } else {
      const codeMatch = name.match(codeRe);
      if (codeMatch) {
        sku = codeMatch[1].trim();
        name = codeMatch[2].trim();
      }
    }

    // Deduplicate by SKU (if found) or by Name+Price to avoid dropping different products with identical prices
    const dedupKey = sku ? `sku:${sku}` : `name:${fullLine}|price:${wp}`;
    if (seenProducts.has(dedupKey)) continue;
    seenProducts.add(dedupKey);

    // Strip artifacts from name
    name = name.replace(/\s+\d+\s*\*\s*\d.*$/, '').trim(); // "3*1" pattern
    name = name.replace(/\s+[A-Z]{1,3}\d{3,5}$/, '').trim(); // trailing model ref

    if (!name || name.length < 4 || !/[a-zA-Z]{3}/.test(name)) continue;

    rows.push({
      row_number: rn,
      ean: sku,
      product_name: name,
      price_wholesale: wp,
      price_retail: rp,
      image_url: '',
    });
  }

  return rows;
}

// ─── IMAGE UPLOADER (bulk) ────────────────────────────────────────────────────
router.post('/upload-images', express.json({ limit: '50mb' }), async (req, res) => {
  try {
    const { images } = req.body; // [{base64, mime, name}]
    if (!images || !Array.isArray(images)) {
      return res.status(400).json({ error: 'images array required' });
    }

    const urls = [];
    for (const img of images) {
      const buf = Buffer.from(img.base64, 'base64');
      const url = await uploadBufferToS3(buf, img.name);
      if (url) urls.push(url);
    }

    res.json({ urls });
  } catch (err) {
    console.error('[upload-images]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── BULK JOB QUEUE ─────────────────────────────────────────────────────────────
// ─── BULK JOB QUEUE ─────────────────────────────────────────────────────────────
router.post('/start-job', express.json({ limit: '50mb' }), (req, res) => {
  try {
    const { products, vendorId, vendorEmail, actorRole, actorId, autoSaveEnabled } = req.body;
    if (!products || !Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ error: 'Array of products is required' });
    }

    const jobId = createJob(products, vendorId, vendorEmail, actorRole, actorId, Boolean(autoSaveEnabled));
    res.json({ jobId, message: `Started job ${jobId} with ${products.length} products` });
  } catch (err) {
    console.error('[start-job] error:', err);
    const status = Number(err?.status || 0) || 500;
    if (status === 409) {
      return res.status(409).json({
        error: err.message,
        code: String(err?.code || 'JOB_ALREADY_RUNNING'),
        jobId: String(err?.jobId || '').trim() || null,
      });
    }
    res.status(status).json({ error: err.message });
  }
});

router.post('/job-autosave/:jobId', express.json({ limit: '1mb' }), (req, res) => {
  const { jobId } = req.params;
  const { autoSaveEnabled } = req.body || {};

  const job = setJobAutoSave(jobId, Boolean(autoSaveEnabled));
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  res.json({
    message: `Auto-save ${job.autoSaveEnabled ? 'enabled' : 'disabled'} for job ${jobId}`,
    autoSaveEnabled: job.autoSaveEnabled,
  });
});

router.get('/job-status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = getJob(jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  
  res.json(job);
});

// Summary-only endpoint for lightweight polling (no items array)
router.get('/job-summary/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = getJob(jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  // Return metadata without items array (keeps payload ~1-2KB instead of 100+KB for 5k items)
  res.json({
    id: job.id,
    vendorId: job.vendorId,
    vendorEmail: job.vendorEmail,
    actorRole: job.actorRole,
    actorId: job.actorId,
    autoSaveEnabled: job.autoSaveEnabled,
    status: job.status,
    total: job.total,
    processed: job.processed,
    successCount: job.successCount,
    failCount: job.failCount,
    savedCount: job.savedCount,
    saveFailCount: job.saveFailCount,
    cooldownActive: job.cooldownActive,
    cooldownEndsAt: job.cooldownEndsAt,
    cooldownTotalMs: job.cooldownTotalMs,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  });
});

// Paginated items endpoint for loading items on-demand
router.get('/job-items/:jobId', (req, res) => {
  const { jobId } = req.params;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));

  const job = getJob(jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  const allItems = job.items || [];
  const total = allItems.length;
  const pages = Math.ceil(total / limit);
  const start = (page - 1) * limit;
  const end = start + limit;
  const items = allItems.slice(start, end);

  res.json({
    items,
    total,
    page,
    limit,
    pages
  });
});

router.post('/stop-job/:jobId', (req, res) => {
  const { jobId } = req.params;
  const success = stopJob(jobId);
  if (success) {
    res.json({ message: `Job ${jobId} stopped successfully` });
  } else {
    res.status(400).json({ error: `Could not stop job ${jobId}. It may not exist or is already finished.` });
  }
});

router.get('/jobs', (req, res) => {
  res.json(getAllJobs());
});

router.get('/vendor-list', async (req, res) => {
  try {
    const actorId = String(req.query.actorId || '').trim();
    const actorEmail = String(req.query.actorEmail || '').trim();
    const backendUrl = process.env.INTERNAL_BACKEND_URL || 'http://localhost:5274';

    const response = await axios.get(`${backendUrl}/v1/admin/list`, {
      headers: {
        'x-internal-call': '1',
        'x-internal-user-id': actorId || 'system',
        'x-internal-email': actorEmail || 'system@communets.local',
      },
    });

    const rows = Array.isArray(response.data) ? response.data : [];
    const vendors = rows
      .filter((row) => String(row?.role || '').toLowerCase() === 'seller')
      .map((row) => ({
        userId: String(row.userId || row.adminId || row.id || row._id || '').trim(),
        email: String(row.email || '').trim().toLowerCase(),
        firstName: String(row.firstName || '').trim(),
        lastName: String(row.lastName || '').trim(),
        sellerType: row.sellerType || null,
      }))
      .filter((row) => row.userId && row.email)
      .sort((a, b) => `${a.firstName} ${a.lastName}`.trim().localeCompare(`${b.firstName} ${b.lastName}`.trim()));

    res.json({ vendors });
  } catch (err) {
    console.error('[vendor-list] error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error || err.message || 'Failed to fetch vendor list' });
  }
});

async function resolveProductIdsByCodes({ codes = [], actorId = 'system', actorEmail = 'system@communets.local' }) {
  const backendUrl = process.env.INTERNAL_BACKEND_URL || 'http://localhost:5274';
  const uniqueCodes = [...new Set((Array.isArray(codes) ? codes : [])
    .map((code) => String(code || '').trim().toUpperCase())
    .filter(Boolean))];

  const productIds = [];
  const failedCodes = [];

  for (const code of uniqueCodes) {
    try {
      const response = await axios.get(`${backendUrl}/v1/products/check-communets-code`, {
        params: {
          code,
          actorRole: 'admin',
        },
        headers: {
          'x-internal-call': '1',
          'x-internal-user-id': actorId,
          'x-internal-email': actorEmail,
        },
      });

      const data = response.data || {};
      const resolvedProductId = String(
        data?.fullProduct?.productId ||
        data?.product?.productId ||
        ''
      ).trim();

      if (!resolvedProductId) {
        failedCodes.push(code);
      } else {
        productIds.push(resolvedProductId);
      }
    } catch (_) {
      failedCodes.push(code);
    }
  }

  return {
    productIds: [...new Set(productIds)],
    failedCodes,
  };
}

router.post('/assign-products', async (req, res) => {
  try {
    const actorId = String(req.body.actorId || '').trim() || 'system';
    const actorEmail = String(req.body.actorEmail || '').trim() || 'system@communets.local';
    const targetUserId = String(req.body.targetUserId || '').trim();
    const targetEmail = String(req.body.targetEmail || '').trim().toLowerCase();
    const note = String(req.body.note || '').trim();

    if (!targetUserId && !targetEmail) {
      return res.status(400).json({ error: 'targetUserId or targetEmail is required' });
    }

    const explicitProductIds = [...new Set((Array.isArray(req.body.productIds) ? req.body.productIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean))];

    const explicitProductCodes = [...new Set((Array.isArray(req.body.productCodes) ? req.body.productCodes : [])
      .map((code) => String(code || '').trim().toUpperCase())
      .filter(Boolean))];

    let productIds = explicitProductIds;
    let failedCodes = [];

    if (productIds.length === 0 && explicitProductCodes.length > 0) {
      const resolved = await resolveProductIdsByCodes({ codes: explicitProductCodes, actorId, actorEmail });
      productIds = resolved.productIds;
      failedCodes = resolved.failedCodes;
    }

    if (productIds.length === 0) {
      const jobId = String(req.body.jobId || '').trim();
      const itemIndexes = Array.isArray(req.body.itemIndexes)
        ? req.body.itemIndexes.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v >= 0)
        : [];

      if (!jobId || itemIndexes.length === 0) {
        return res.status(400).json({ error: 'Provide productIds[] or productCodes[] or jobId + itemIndexes[]' });
      }

      const job = getJob(jobId);
      if (!job) {
        return res.status(404).json({ error: 'Job not found' });
      }

      const codes = itemIndexes
        .map((idx) => job.items?.[idx])
        .filter(Boolean)
        .map((item) => String(item.assignedCommunetsCode || item.original?.communetsCode || '').trim().toUpperCase())
        .filter(Boolean);

      const resolved = await resolveProductIdsByCodes({ codes, actorId, actorEmail });
      productIds = resolved.productIds;
      failedCodes = resolved.failedCodes;
    }

    if (productIds.length === 0) {
      return res.status(400).json({ error: 'No assignable products found for this selection', failedCodes });
    }

    const backendUrl = process.env.INTERNAL_BACKEND_URL || 'http://localhost:5274';
    const transferResponse = await axios.post(
      `${backendUrl}/v1/products/transfer-authority`,
      {
        targetUserId,
        targetEmail,
        productIds,
        note,
      },
      {
        headers: {
          'x-internal-call': '1',
          'x-internal-user-id': actorId,
          'x-internal-email': actorEmail,
          'Content-Type': 'application/json',
        },
      }
    );

    res.json({
      message: transferResponse.data?.message || 'Products assigned successfully',
      transferredCount: transferResponse.data?.count || productIds.length,
      transferredProductIds: transferResponse.data?.transferredProductIds || productIds,
      failedCodes,
      missingProductIds: transferResponse.data?.missingProductIds || [],
    });
  } catch (err) {
    console.error('[assign-products] error:', err.response?.data || err.message);
    res.status(err.response?.status || 500).json({
      error: err.response?.data?.message || err.response?.data?.error || err.message || 'Failed to assign products',
      details: err.response?.data || null,
    });
  }
});

router.get('/vendor-assigned-products', async (req, res) => {
  const requestStartedAt = Date.now();
  try {
    const actorId = String(req.query.actorId || '').trim();
    const actorEmail = String(req.query.actorEmail || '').trim();
    const vendorUserId = String(req.query.vendorUserId || '').trim();
    const requestedPage = parsePage(req.query.page, 1);
    const requestedLimit = parseLimit(req.query.limit, 50, 200);
    const searchToken = normalizeSearchToken(req.query.search || '');

    if (!vendorUserId) {
      return res.status(400).json({ error: 'vendorUserId is required' });
    }

    const backendUrl = process.env.INTERNAL_BACKEND_URL || 'http://localhost:5274';
    const response = await axios.get(`${backendUrl}/v1/products/authority/vendor-assigned-products`, {
      params: {
        vendorUserId,
        page: requestedPage,
        limit: requestedLimit,
        search: searchToken || undefined,
        includeTotal: true,
      },
      headers: buildInternalHeaders(actorId, actorEmail),
    });

    const responsePayload = {
      products: Array.isArray(response?.data?.products) ? response.data.products : [],
      total: Number(response?.data?.total || 0),
      page: Number(response?.data?.page || requestedPage),
      limit: Number(response?.data?.limit || requestedLimit),
      pages: Number(response?.data?.pages || 1),
    };
    const payloadBytes = Buffer.byteLength(JSON.stringify(responsePayload), 'utf8');
    console.info(`[vendor-assigned-products] latencyMs=${Date.now() - requestStartedAt} payloadBytes=${payloadBytes} page=${responsePayload.page} limit=${responsePayload.limit} total=${responsePayload.total} search="${searchToken}"`);
    res.json(responsePayload);
  } catch (err) {
    console.error('[vendor-assigned-products] error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.message || err.response?.data?.error || err.message || 'Failed to fetch vendor products' });
  }
});

router.post('/revoke-products', async (req, res) => {
  try {
    const actorId = String(req.body.actorId || '').trim() || 'system';
    const actorEmail = String(req.body.actorEmail || '').trim() || 'system@communets.local';
    const note = String(req.body.note || 'Authority revoked by admin').trim();
    const productIds = [...new Set(
      (Array.isArray(req.body.productIds) ? req.body.productIds : [])
        .map((id) => String(id || '').trim())
        .filter(Boolean)
    )];

    if (productIds.length === 0) {
      return res.status(400).json({ error: 'productIds[] is required' });
    }

    const backendUrl = process.env.INTERNAL_BACKEND_URL || 'http://localhost:5274';
    const transferResponse = await axios.post(
      `${backendUrl}/v1/products/transfer-authority`,
      {
        targetUserId: actorId,
        targetEmail: actorEmail,
        productIds,
        note,
      },
      {
        headers: {
          'x-internal-call': '1',
          'x-internal-user-id': actorId,
          'x-internal-email': actorEmail,
          'Content-Type': 'application/json',
        },
      }
    );

    res.json({
      message: transferResponse.data?.message || 'Product access revoked successfully',
      transferredCount: transferResponse.data?.updatedProducts?.length || productIds.length,
      transferredProductIds: (transferResponse.data?.updatedProducts || []).map((p) => p.productId),
      missingProductIds: transferResponse.data?.missingProductIds || [],
    });
  } catch (err) {
    console.error('[revoke-products] error:', err.response?.data || err.message);
    res.status(err.response?.status || 500).json({
      error: err.response?.data?.message || err.response?.data?.error || err.message || 'Failed to revoke products',
      details: err.response?.data || null,
    });
  }
});

const toInt = (value, fallback = 0) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

const isReservedBufferCode = (code = '') => {
  const normalized = String(code || '').trim().toUpperCase();
  if (!/^GS\d+$/.test(normalized)) return false;
  const numeric = Number(normalized.slice(2));
  if (!Number.isFinite(numeric)) return false;
  return numeric >= 2604000000 && numeric <= 2604010000;
};

const getOldGsFromProduct = (product = {}) => {
  const candidates = [
    product?.legacyGsCode,
    product?.oldGs,
    product?.legacyLookupOldGs,
  ];

  for (const value of candidates) {
    const normalized = String(value || '').trim().toUpperCase();
    if (!normalized) continue;
    return normalized;
  }

  return '';
};

const parsePage = (value, fallback = 1) => {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parseLimit = (value, fallback = 50, max = 200) => {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
};

const normalizeSearchToken = (value = '') => String(value || '').trim().toLowerCase();

const matchesProductSearch = (product = {}, token = '') => {
  if (!token) return true;

  const fields = [
    product.productName,
    product.communetCode,
    product.oldGs,
    product.productId,
  ].map((value) => normalizeSearchToken(value));

  return fields.some((value) => value.includes(token));
};

const buildInternalHeaders = (actorId = '', actorEmail = '') => ({
  'x-internal-call': '1',
  'x-internal-user-id': actorId || 'system',
  'x-internal-email': actorEmail || 'system@communets.local',
});

const fetchAllProductsFromBackend = async ({
  backendUrl,
  actorId = '',
  actorEmail = '',
  params = {},
  pageLimit = 500,
  concurrency = 6,
}) => {
  const headers = buildInternalHeaders(actorId, actorEmail);
  const firstResponse = await axios.get(`${backendUrl}/v1/products`, {
    params: { ...params, page: 1, limit: pageLimit },
    headers,
  });

  const firstProducts = Array.isArray(firstResponse?.data?.products) ? firstResponse.data.products : [];
  const totalPages = Math.max(1, Number(firstResponse?.data?.pages || 1));
  if (totalPages <= 1) return firstProducts;

  const allProducts = [...firstProducts];
  for (let startPage = 2; startPage <= totalPages; startPage += concurrency) {
    const endPage = Math.min(totalPages, startPage + concurrency - 1);
    const pageNumbers = [];
    for (let page = startPage; page <= endPage; page += 1) pageNumbers.push(page);

    const pageResponses = await Promise.all(
      pageNumbers.map((page) =>
        axios.get(`${backendUrl}/v1/products`, {
          params: { ...params, page, limit: pageLimit },
          headers,
        })
      )
    );

    for (const response of pageResponses) {
      const products = Array.isArray(response?.data?.products) ? response.data.products : [];
      if (products.length > 0) allProducts.push(...products);
    }
  }

  return allProducts;
};

const sellerIdsCache = {
  value: null,
  expiresAt: 0,
};

const fetchSellerIds = async ({ backendUrl, actorId = '', actorEmail = '' }) => {
  const now = Date.now();
  if (sellerIdsCache.value instanceof Set && sellerIdsCache.expiresAt > now) {
    return sellerIdsCache.value;
  }

  const adminListResponse = await axios.get(`${backendUrl}/v1/admin/list`, {
    headers: buildInternalHeaders(actorId, actorEmail),
  });

  const adminRows = Array.isArray(adminListResponse.data) ? adminListResponse.data : [];
  const sellerIds = new Set(
    adminRows
      .filter((row) => String(row?.role || '').toLowerCase() === 'seller')
      .map((row) => String(row?.userId || row?.adminId || row?.id || row?._id || '').trim())
      .filter(Boolean)
  );

  sellerIdsCache.value = sellerIds;
  sellerIdsCache.expiresAt = now + 30 * 1000;
  return sellerIds;
};

router.post('/reset-reserved-products', async (req, res) => {
  try {
    const actorId = String(req.body.actorId || '').trim();
    const actorEmail = String(req.body.actorEmail || '').trim();
    const scope = String(req.body.scope || 'actor').trim().toLowerCase();

    const backendUrl = process.env.INTERNAL_BACKEND_URL || 'http://localhost:5274';
    const query = {
      page: 1,
      limit: 2000,
    };

    if (scope !== 'all') {
      if (!actorId) {
        return res.status(400).json({ error: 'actorId is required for actor-scoped cleanup' });
      }
      query.addedBy = actorId;
    }

    const response = await axios.get(`${backendUrl}/v1/products`, {
      params: query,
      headers: {
        'x-internal-call': '1',
        'x-internal-user-id': actorId || 'system',
        'x-internal-email': actorEmail || 'system@communets.local',
      },
    });

    const products = Array.isArray(response?.data?.products) ? response.data.products : [];
    const reservedProducts = products.filter((product) => isReservedBufferCode(product?.communetCode));

    if (reservedProducts.length === 0) {
      return res.json({ deletedCount: 0, message: 'No reserved products found to delete.' });
    }

    const deletedProductIds = [];
    const errors = [];

    for (const product of reservedProducts) {
      try {
        await axios.delete(`${backendUrl}/v1/products/${encodeURIComponent(product.productId)}`, {
          headers: {
            'x-internal-call': '1',
            'x-internal-user-id': actorId || 'system',
            'x-internal-email': actorEmail || 'system@communets.local',
          },
        });
        deletedProductIds.push(product.productId);
      } catch (err) {
        errors.push({ productId: product.productId, error: err.response?.data?.message || err.response?.data?.error || err.message });
      }
    }

    res.json({
      message: 'Reserved products reset completed',
      deletedCount: deletedProductIds.length,
      deletedProductIds,
      errors,
    });
  } catch (err) {
    console.error('[reset-reserved-products] error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.message || err.response?.data?.error || err.message || 'Failed to reset reserved products' });
  }
});

router.get('/assignable-products', async (req, res) => {
  const requestStartedAt = Date.now();
  try {
    const actorId = String(req.query.actorId || '').trim();
    const actorEmail = String(req.query.actorEmail || '').trim();
    const requestedPage = parsePage(req.query.page, 1);
    const requestedLimit = parseLimit(req.query.limit, 50, 200);
    const searchToken = normalizeSearchToken(req.query.search || '');
    const backendUrl = process.env.INTERNAL_BACKEND_URL || 'http://localhost:5274';
    const response = await axios.get(`${backendUrl}/v1/products/authority/assignable-products`, {
      params: {
        page: requestedPage,
        limit: requestedLimit,
        search: searchToken || undefined,
        includeTotal: true,
      },
      headers: buildInternalHeaders(actorId, actorEmail),
    });

    const responsePayload = {
      products: Array.isArray(response?.data?.products) ? response.data.products : [],
      total: Number(response?.data?.total || 0),
      page: Number(response?.data?.page || requestedPage),
      limit: Number(response?.data?.limit || requestedLimit),
      pages: Number(response?.data?.pages || 1),
    };
    const payloadBytes = Buffer.byteLength(JSON.stringify(responsePayload), 'utf8');
    console.info(`[assignable-products] latencyMs=${Date.now() - requestStartedAt} payloadBytes=${payloadBytes} page=${responsePayload.page} limit=${responsePayload.limit} total=${responsePayload.total} search="${searchToken}"`);
    res.json(responsePayload);
  } catch (err) {
    console.error('[assignable-products] error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.message || err.response?.data?.error || err.message || 'Failed to fetch assignable products' });
  }
});

const toFloat = (value, fallback = 0) => {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
};

const getActorRole = (job = {}) => String(job.actorRole || 'seller').trim().toLowerCase();
const getActorId = (job = {}) => String(job.actorId || job.vendorId || 'system').trim();
const isReservedBufferGsCode = (code = '') => {
  const normalized = String(code || '').trim().toUpperCase();
  if (!/^GS\d+$/.test(normalized)) return false;
  const numeric = Number(normalized.slice(2));
  if (!Number.isFinite(numeric)) return false;
  return numeric >= 2604000000 && numeric <= 2604010000;
};
const shouldPreserveReservedCode = (job = {}, itemIdx, rawCode = '') => {
  // Any GS inside reserved buffer must be preserved as explicit GS during save.
  return isReservedBufferGsCode(rawCode);
};

const enrichMappedPayloadFromJobOriginal = (job = {}, itemIdx, mappedPayload = {}, rawInputCode = '') => {
  const original = job?.items?.[Number(itemIdx)]?.original || {};
  const oldGs = String(original.oldGs || original.legacyLookupOldGs || '').trim().toUpperCase();
  const explicitCode = String(rawInputCode || original.communetsCode || '').trim().toUpperCase();
  const lookupSource = String(original.lookupSource || '').trim();

  if (oldGs) {
    mappedPayload.productOGCode = oldGs;
    mappedPayload.legacyLookupOldGs = oldGs;
  }

  if (explicitCode) {
    mappedPayload.legacyLookupNewGs = explicitCode;
  }

  if (lookupSource) {
    mappedPayload.lookupSource = lookupSource;
  } else if (isReservedBufferGsCode(explicitCode)) {
    mappedPayload.lookupSource = 'reserved-buffer-publish';
  }

  return mappedPayload;
};
const getInputCodeFromRowArray = (arr = []) => {
  if (!Array.isArray(arr)) return '';

  // Tracker current format (21 columns):
  // 0 vendorId, 1 communetsCode, 2 productName, 3 status, 4 ean, ...
  if (arr.length >= 21 && String(arr[3] || '').trim().toLowerCase() === 'unverified') {
    return String(arr[1] || '').trim().toUpperCase();
  }

  // Legacy Tracker format (20 columns) had no explicit code column.
  if (arr.length === 20 && String(arr[2] || '').trim().toLowerCase() === 'unverified') {
    return '';
  }

  // Fallback for older service contracts where code was placed at index 4.
  return String(arr[4] || '').trim().toUpperCase();
};
const BULK_FINALIZE_PARALLEL = 4;
const sanitizeOgCode = (value = '') => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const isGsLike = /^GS\d+$/i.test(raw);
  return isGsLike ? null : raw;
};

const buildEditPayloadFromMapped = (mappedPayload = {}) => {
  let images = [];
  try {
    const parsed = JSON.parse(mappedPayload.preUploadedImages || '[]');
    images = Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch (e) {
    images = [];
  }

  return {
    productName: mappedPayload.productName,
    productOGCode: mappedPayload.productOGCode || null,
    unit: mappedPayload.unit,
    stockQuantity: mappedPayload.stockQuantity,
    categoryID: mappedPayload.categoryID,
    subCategoryID: mappedPayload.subCategoryID,
    description: mappedPayload.description,
    wholeSale: mappedPayload.wholeSale,
    wholeSaleQuantity: mappedPayload.wholeSaleQuantity,
    retail: mappedPayload.retail,
    manufacturerID: mappedPayload.brand,
    costPrice: mappedPayload.costPrice,
    existingImages: JSON.stringify(images.length > 0 ? images : [DEFAULT_PRODUCT_IMAGE_URL]),
  };
};

const resolveBulkCodeAction = async (job, code) => {
  const normalized = String(code || '').trim().toUpperCase();
  // Product-code checks are disabled for catalog save flows.
  // Always continue with add flow; reserved GS preservation is handled separately.
  if (!normalized) return { action: 'add', warning: null, lookup: null };
  return {
    action: 'add',
    warning: `Code ${normalized} was ignored for save and treated as empty.`,
    lookup: null,
  };
};

const mapRowToPayload = (arr) => {
  // Tracker (current) format:
  // 0 vendorId, 1 communetsCode, 2 productName, 3 status, 4 ean, 5 unit, 6 stock,
  // 7 category, 8 subcategory, 9 description, 10 wholesale, 11 wholesale qty,
  // 12 retail, 13 vendor name, 14 vendor contact, 15 cost, 16 brand, 17..20 images
  if (Array.isArray(arr) && arr.length >= 21 && String(arr[3] || '').trim().toLowerCase() === 'unverified') {
    const rawImages = [arr[17], arr[18], arr[19], arr[20]].map(sanitizeImageUrl).filter(Boolean);
    const images = rawImages.length > 0 ? rawImages : [DEFAULT_PRODUCT_IMAGE_URL];
    return {
      communetsCode: String(arr[1] || '').trim(),
      productName: arr[2] || '',
      productOGCode: sanitizeOgCode(arr[4]),
      unit: arr[5] || 'Piece',
      stockQuantity: toInt(arr[6], 0),
      categoryID: arr[7] || 'General',
      subCategoryID: arr[8] || undefined,
      description: arr[9] || '',
      wholeSale: toFloat(arr[10], 1),
      wholeSaleQuantity: toInt(arr[11], 1),
      retail: toFloat(arr[12], 1),
      costPrice: Number.isFinite(Number(arr[15])) ? Number(arr[15]) : null,
      brand: arr[16] || '',
      productStatus: 'Unverified',
      preUploadedImages: JSON.stringify(images)
    };
  }

  // Legacy BulkTrack row format (21 columns):
  // 0 vendorId, 1 source, 2 title, 3 status, 4 ean, 5 unit, 6 stock,
  // 7 category, 8 subcategory, 9 description, 10 wholesale,
  // 11 wholesale qty, 12 retail, 13 vendor name, 14 vendor contact,
  // 15 cost, 16 brand, 17..20 images
  if (Array.isArray(arr) && arr.length >= 21) {
    const rawImages = [arr[17], arr[18], arr[19], arr[20]].map(sanitizeImageUrl).filter(Boolean);
    const images = rawImages.length > 0 ? rawImages : [DEFAULT_PRODUCT_IMAGE_URL];
    return {
      communetsCode: String(arr[1] || '').trim(),
      productName: arr[2] || '',
      productOGCode: sanitizeOgCode(arr[4]),
      unit: arr[5] || 'Piece',
      stockQuantity: toInt(arr[6], 0),
      categoryID: arr[7] || 'General',
      subCategoryID: arr[8] || undefined,
      description: arr[9] || '',
      wholeSale: toFloat(arr[10], 1),
      wholeSaleQuantity: toInt(arr[11], 1),
      retail: toFloat(arr[12], 1),
      costPrice: Number.isFinite(Number(arr[15])) ? Number(arr[15]) : null,
      brand: arr[16] || '',
      productStatus: 'Unverified',
      preUploadedImages: JSON.stringify(images)
    };
  }

  // Current compact format fallback.
  return {
    communetsCode: arr[0],
    productName: arr[1],
    productOGCode: sanitizeOgCode(arr[2]),
    brand: arr[3],
    subCategoryID: arr[4] || undefined,
    categoryID: arr[5] || 'General',
    unit: arr[6] || 'Piece',
    stockQuantity: toInt(arr[7], 0),
    wholeSaleQuantity: toInt(arr[8], 1),
    wholeSale: toFloat(arr[9], 1),
    retail: toFloat(arr[10], 1),
    costPrice: Number.isFinite(Number(arr[11])) ? Number(arr[11]) : null,
    description: arr[12] || '',
    productStatus: 'Unverified',
    preUploadedImages: JSON.stringify((((arr || []).slice(13).map(sanitizeImageUrl).filter(Boolean)).length > 0
      ? (arr || []).slice(13).map(sanitizeImageUrl).filter(Boolean)
      : [DEFAULT_PRODUCT_IMAGE_URL]))
  };
};

router.post('/finalize/:jobId/:itemIdx', async (req, res) => {
  try {
    const { jobId, itemIdx } = req.params;
    const { productRowArray } = req.body;
    
    if (!productRowArray || !Array.isArray(productRowArray)) {
      return res.status(400).json({ error: 'productRowArray required' });
    }
    
    const job = getJob(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const actorId = getActorId(job);
    if (!actorId) return res.status(400).json({ error: 'Job has no actor identity associated' });
    
    const backendUrl = process.env.INTERNAL_BACKEND_URL || 'http://localhost:5274';
    let mappedPayload = mapRowToPayload(productRowArray);

    const codeAction = await resolveBulkCodeAction(job, getInputCodeFromRowArray(productRowArray));
    const rawInputCode = getInputCodeFromRowArray(productRowArray);
    mappedPayload = enrichMappedPayloadFromJobOriginal(job, itemIdx, mappedPayload, rawInputCode);
    const preserveReservedCode = shouldPreserveReservedCode(job, itemIdx, rawInputCode);
    if (codeAction.warning && !preserveReservedCode && job.items[itemIdx]) {
      job.items[itemIdx].codeWarning = codeAction.warning;
    }

    if (codeAction.action === 'forbidden') {
      return res.status(403).json({ error: codeAction.error || 'Access denied for this code' });
    }

    let hasPreexistingEan = false;
    let preExistingProduct = null;
    if (mappedPayload.productOGCode) {
      try {
        const checkRes = await axios.get(`${backendUrl}/v1/products/check-ean`, {
          params: {
            ean: mappedPayload.productOGCode,
            vendorId: actorId
          },
          headers: {
            'x-internal-call': '1',
            'x-internal-user-id': actorId
          }
        });
        if (checkRes.data && checkRes.data.exists && checkRes.data.isMine && checkRes.data.product) {
          hasPreexistingEan = true;
          preExistingProduct = checkRes.data.product;
        }
      } catch (err) {
        console.error('[bulk-finalize-check-ean] error checking ean', err.message);
      }
    }

    let assignedCommunetsCode = '';
    let saveFlow = 'unknown';

    if (codeAction.action === 'override' || hasPreexistingEan) {
      const targetProductId = hasPreexistingEan
        ? preExistingProduct.productId
        : codeAction.targetProductId;

      const editPayload = buildEditPayloadFromMapped(mappedPayload);
      await axios.put(
        `${backendUrl}/v1/products/edit/${encodeURIComponent(targetProductId)}`,
        editPayload,
        {
          headers: {
            'x-internal-call': '1',
            'x-internal-user-id': actorId,
            'Content-Type': 'application/json'
          }
        }
      );
      if (job.items[itemIdx]) {
        job.items[itemIdx].overrideApplied = true;
      }
      assignedCommunetsCode = hasPreexistingEan
        ? String(preExistingProduct?.communetCode || '').trim()
        : String(codeAction?.lookup?.resolvedCode || codeAction?.lookup?.product?.communetCode || '').trim();
      saveFlow = 'preexist-override';
    } else {
      // Empty/unknown non-reserved input codes are ignored; reserved-buffer publish keeps explicit GS.
      if (!preserveReservedCode) {
        mappedPayload.communetsCode = '';
      }
      const addRes = await axios.post(`${backendUrl}/v1/products/add`, mappedPayload, {
        headers: {
          'x-internal-call': '1',
          'x-internal-user-id': actorId
        }
      });
      assignedCommunetsCode = String(addRes?.data?.product?.communetCode || '').trim();
      const hadInputCode = Boolean(rawInputCode);
      saveFlow = preserveReservedCode
        ? 'reserved-buffer-preserved'
        : (hadInputCode ? 'code-not-found-auto-assigned' : 'code-empty-auto-assigned');
    }
    
    // Mark this specific item as permanently saved so we don't accidentally auto-save it later
    if (job.items[itemIdx]) {
      job.items[itemIdx].status = 'saved_to_catalog';
      job.items[itemIdx].saveFlow = saveFlow;
      job.items[itemIdx].assignedCommunetsCode = assignedCommunetsCode;
      job.savedCount = (job.savedCount || 0) + 1;
      job.updatedAt = new Date();
    }
    
    res.json({ message: 'Saved to catalog successfully', saveFlow, assignedCommunetsCode });
  } catch (err) {
    console.error('[bulk-finalize]', err.response?.data || err.message);
    const detail = err.response?.data?.error || err.response?.data?.message || err.message;
    res.status(500).json({ error: detail });
  }
});

// ─── BULK FINALIZE ALL ────────────────────────────────────────────────────────
router.post('/finalize-all/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { rows } = req.body; // rows: [{ idx: number, productRowArray: [] }]

    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'rows[] required' });
    }

    const job = getJob(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const actorId = getActorId(job);
    if (!actorId) return res.status(400).json({ error: 'Job has no actor identity associated' });

    const validRows = rows.filter(r => Array.isArray(r.productRowArray));
    const backendUrl = process.env.INTERNAL_BACKEND_URL || 'http://localhost:5274';

    let saved = 0;
    const savedItems = [];
    const errors = [];

    // Process in fixed parallel workers for faster bulk finalization.
    for (let i = 0; i < validRows.length; i += BULK_FINALIZE_PARALLEL) {
      const batch = validRows.slice(i, i + BULK_FINALIZE_PARALLEL);
      const outcomes = await Promise.allSettled(batch.map(async (row) => {
        let mappedPayload = mapRowToPayload(row.productRowArray);
        const codeAction = await resolveBulkCodeAction(job, getInputCodeFromRowArray(row.productRowArray));
        const rawInputCode = getInputCodeFromRowArray(row.productRowArray);
        mappedPayload = enrichMappedPayloadFromJobOriginal(job, row.idx, mappedPayload, rawInputCode);
        const preserveReservedCode = shouldPreserveReservedCode(job, row.idx, rawInputCode);
        if (codeAction.warning && !preserveReservedCode && job.items[row.idx]) {
          job.items[row.idx].codeWarning = codeAction.warning;
        }

        if (codeAction.action === 'forbidden') {
          throw new Error(codeAction.error || 'Access denied for this code');
        }

        let hasPreexistingEan = false;
        let preExistingProduct = null;
        if (mappedPayload.productOGCode) {
          try {
            const checkRes = await axios.get(`${backendUrl}/v1/products/check-ean`, {
              params: {
                ean: mappedPayload.productOGCode,
                vendorId: actorId
              },
              headers: {
                'x-internal-call': '1',
                'x-internal-user-id': actorId
              }
            });
            if (checkRes.data && checkRes.data.exists && checkRes.data.isMine && checkRes.data.product) {
              hasPreexistingEan = true;
              preExistingProduct = checkRes.data.product;
            }
          } catch (err) {
            console.error('[bulk-finalize-all-check-ean] error checking ean', err.message);
          }
        }

        if (codeAction.action === 'override' || hasPreexistingEan) {
          const targetProductId = hasPreexistingEan
            ? preExistingProduct.productId
            : codeAction.targetProductId;

          const editPayload = buildEditPayloadFromMapped(mappedPayload);
          await axios.put(
            `${backendUrl}/v1/products/edit/${encodeURIComponent(targetProductId)}`,
            editPayload,
            {
              headers: {
                'x-internal-call': '1',
                'x-internal-user-id': actorId,
                'Content-Type': 'application/json'
              }
            }
          );
          if (job.items[row.idx]) {
            job.items[row.idx].overrideApplied = true;
          }
          const assignedCommunetsCode = hasPreexistingEan
            ? String(preExistingProduct?.communetCode || '').trim()
            : String(codeAction?.lookup?.resolvedCode || codeAction?.lookup?.product?.communetCode || '').trim();
          const saveFlow = 'preexist-override';
          if (job.items[row.idx]) {
            job.items[row.idx].saveFlow = saveFlow;
            job.items[row.idx].assignedCommunetsCode = assignedCommunetsCode;
          }
          return { rowIndex: row.idx, saveFlow, assignedCommunetsCode };
        } else {
          // Empty/unknown non-reserved input codes are ignored; reserved-buffer publish keeps explicit GS.
          if (!preserveReservedCode) {
            mappedPayload.communetsCode = '';
          }
          const addRes = await axios.post(`${backendUrl}/v1/products/add`, mappedPayload, {
            headers: {
              'x-internal-call': '1',
              'x-internal-user-id': actorId
            }
          });
          const assignedCommunetsCode = String(addRes?.data?.product?.communetCode || '').trim();
          const hadInputCode = Boolean(rawInputCode);
          const saveFlow = preserveReservedCode
            ? 'reserved-buffer-preserved'
            : (hadInputCode ? 'code-not-found-auto-assigned' : 'code-empty-auto-assigned');
          if (job.items[row.idx]) {
            job.items[row.idx].saveFlow = saveFlow;
            job.items[row.idx].assignedCommunetsCode = assignedCommunetsCode;
          }
          return { rowIndex: row.idx, saveFlow, assignedCommunetsCode };
        }
      }));

      outcomes.forEach((outcome, batchIdx) => {
        const row = batch[batchIdx];
        if (outcome.status === 'fulfilled') {
          saved += 1;
          savedItems.push(outcome.value);
          if (job.items[row?.idx]) {
            job.items[row.idx].status = 'saved_to_catalog';
            job.savedCount = (job.savedCount || 0) + 1;
          }
        } else {
          const reason = outcome.reason;
          const detail = reason?.response?.data?.error || reason?.response?.data?.message || reason?.message || String(reason);
          errors.push({ rowIndex: row?.idx, error: detail });
        }
      });
    }

    job.updatedAt = new Date();

    res.json({
      message: `Saved ${saved}/${validRows.length} items to catalog`,
      savedItems,
      errors
    });
  } catch (err) {
    console.error('[bulk-finalize-all]', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
