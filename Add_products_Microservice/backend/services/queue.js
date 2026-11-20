import { v4 as uuidv4 } from 'uuid';
import fetch from 'node-fetch';

import axios from 'axios';
import FormData from 'form-data';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import path from 'path';

import dotenv from 'dotenv';
dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), '../../backend/.env') });

const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
const BUCKET_NAME = process.env.AWS_S3_BUCKET_NAME || process.env.S3_BUCKET_NAME || 'communets-lightsail-bucket';
let sharpModulePromise = null;

function getContentTypeFromFilename(filename = '') {
  const lower = String(filename).toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.bmp')) return 'image/bmp';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  return 'image/jpeg';
}

/**
 * In-memory job store
 * Structure:
 * {
 *   [jobId]: {
 *     id: 'uuid',
 *     status: 'running' | 'completed' | 'failed',
 *     total: number,
 *     processed: number,
 *     successCount: number,
 *     failCount: number,
 *     error: string | null,
 *     items: [
 *       {
 *          original: { product_name: '...', ... },
 *          status: 'pending' | 'processing' | 'success' | 'failed',
 *          result: { seo_title: '...', description: '...', ... } (the AI output),
 *          error: string | null
 *       }
 *     ],
 *     createdAt: Date,
 *     updatedAt: Date
 *   }
 * }
 */
const jobs = new Map();

const N8N_WEBHOOK_URL = process.env.N8N_SEARCH_WEBHOOK;
const N8N_WEBHOOK_FALLBACK_URL = process.env.N8N_SEARCH_WEBHOOK_FALLBACK;
const ENHANCE_API_URL = process.env.ENHANCE_API_URL;
const INTERNAL_BACKEND_URL = process.env.INTERNAL_BACKEND_URL || 'http://localhost:5274';
const DEFAULT_PRODUCT_IMAGE_URL = '/v1/public/default-no-image.png';
const BULK_AUTO_SAVE_DELAY_MS = Math.max(0, parseInt(process.env.BULK_AUTO_SAVE_DELAY_MS || '5000', 10));

// Bulk processing is fixed to 4 parallel workers by product policy.
const BULK_JOB_CONCURRENCY = 4;
const BULK_WAVE_SIZE = Math.max(1, parseInt(process.env.BULK_WAVE_SIZE || '52', 10));
const BULK_WAVE_PAUSE_MS = 0;
const BULK_AUTO_SAVE_WAVES = (process.env.BULK_AUTO_SAVE_WAVES || 'true').toLowerCase() !== 'false';
let cachedDefaultEnhancedImageUrl = '';

function normalizeIdentity(value) {
  return String(value || '').trim().toLowerCase();
}

function buildProductsFingerprint(products = []) {
  if (!Array.isArray(products) || products.length === 0) return '';

  return products
    .slice(0, 100)
    .map((row) => {
      const item = row && typeof row === 'object' ? row : {};
      const name = String(item.product_name || item.productName || '').trim().toLowerCase();
      const sku = String(item.ean || item.oldGs || item.legacyLookupOldGs || '').trim().toLowerCase();
      const code = String(item.communetsCode || '').trim().toLowerCase();
      return `${name}|${sku}|${code}`;
    })
    .join('||');
}

function findRunningJobConflict(actorId, vendorId, vendorEmail, productsFingerprint = '') {
  const normalizedActorId = normalizeIdentity(actorId);
  const normalizedVendorId = normalizeIdentity(vendorId);
  const normalizedVendorEmail = normalizeIdentity(vendorEmail);
  const normalizedFingerprint = String(productsFingerprint || '').trim();

  for (const job of jobs.values()) {
    if (!job || job.status !== 'running') continue;
    const jobActorId = normalizeIdentity(job.actorId);
    const jobVendorId = normalizeIdentity(job.vendorId);
    const jobVendorEmail = normalizeIdentity(job.vendorEmail);
    const jobFingerprint = String(job.productsFingerprint || '').trim();

    if (normalizedActorId && jobActorId && normalizedActorId === jobActorId) {
      return job;
    }
    if (!normalizedActorId && normalizedVendorId && jobVendorId && normalizedVendorId === jobVendorId) {
      return job;
    }
    if (!normalizedActorId && !normalizedVendorId && normalizedVendorEmail && jobVendorEmail && normalizedVendorEmail === jobVendorEmail) {
      return job;
    }
    if (normalizedFingerprint && jobFingerprint && normalizedFingerprint === jobFingerprint) {
      return job;
    }
  }

  return null;
}

function isReservedBufferGsCode(code = '') {
  const normalized = String(code || '').trim().toUpperCase();
  if (!/^GS\d+$/.test(normalized)) return false;
  const numeric = Number(normalized.slice(2));
  if (!Number.isFinite(numeric)) return false;
  return numeric >= 2604000000 && numeric <= 2604010000;
}

function shouldPreserveReservedCode(item, rawCode) {
  // Any GS inside reserved buffer must be preserved as explicit GS during save.
  return isReservedBufferGsCode(rawCode);
}

function isReservedBufferFlow(item) {
  return String(item?.original?.lookupSource || '').trim().toLowerCase() === 'reserved-buffer-publish';
}

function isDuplicateCodeError(error) {
  const message = String(error?.response?.data?.error || error?.response?.data?.message || error?.message || '').toLowerCase();
  return message.includes('already exists') || message.includes('duplicate key') || message.includes('target reserved gs already used');
}

async function allocateNextReservedGsCode() {
  const response = await axios.get(`${INTERNAL_BACKEND_URL}/v1/products/reserved-mapping/next-codes`, {
    params: { count: 1 },
    headers: { 'x-internal-call': '1' },
    timeout: 30000,
  });

  return String(Array.isArray(response?.data?.codes) ? response.data.codes[0] : response?.data?.single || '').trim().toUpperCase();
}

async function saveReservedCatalogItemWithRetry(payload, actorId, item, itemIndex, maxAttempts = 4, preferredReservedCode = '') {
  let lastError = null;
  const normalizedPreferredCode = String(preferredReservedCode || '').trim().toUpperCase();

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const reservedCode = attempt === 1 && isReservedBufferGsCode(normalizedPreferredCode)
      ? normalizedPreferredCode
      : await allocateNextReservedGsCode();
    if (!reservedCode) {
      throw new Error('Reserved GS buffer exhausted');
    }

    const savePayload = {
      ...payload,
      communetsCode: reservedCode,
      legacyLookupNewGs: reservedCode,
    };

    try {
      const saveRes = await axios.post(`${INTERNAL_BACKEND_URL}/v1/products/add`, savePayload, {
        headers: {
          'x-internal-call': '1',
          'x-internal-user-id': actorId,
        },
      });

      return { saveRes, reservedCode };
    } catch (error) {
      lastError = error;
      if (!isDuplicateCodeError(error) || attempt === maxAttempts) {
        throw error;
      }

      console.warn(`[Queue] [${item?.jobId || 'job'}] Reserved GS collision at item ${itemIndex + 1}, retrying with a fresh reserved code (attempt ${attempt}/${maxAttempts}).`);
      await sleep(attempt * 150);
    }
  }

  throw lastError || new Error('Failed to save reserved catalog item');
}

function toAbsoluteInternalUrl(maybePath = '') {
  const value = String(maybePath || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  const base = String(INTERNAL_BACKEND_URL || '').trim().replace(/\/$/, '');
  const path = value.startsWith('/') ? value : `/${value}`;
  return `${base}${path}`;
}

function sanitizeImageUrl(value = '') {
  const url = String(value || '').trim();
  if (!url) return '';
  return url;
}

function getFirstSourceImage(original = {}) {
  const candidates = [
    original.image_url,
    original.image_url_2,
    original.image_url_3,
    original.image_url_4,
  ];

  for (const candidate of candidates) {
    const url = sanitizeImageUrl(candidate);
    if (url) return url;
  }

  return '';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toPositiveNumber(value, fallback = 1) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
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
  uiData.detailed_description = safeDescription;
  if (!String(uiData.overview || '').trim()) uiData.overview = safeDescription;

  if (hasGeneratedContent) {
    base.generated_content = uiData;
    return base;
  }

  return uiData;
}

function buildMergedDescription(item) {
  const uiData = item?.result?.generated_content || item?.result || {};
  const original = item?.original || {};

  let combined = uiData.overview ? `${uiData.overview}\n\n` : '';
  if (Array.isArray(uiData.features) && uiData.features.length > 0) {
    combined += `KEY FEATURES:\n${uiData.features.map((f) => `• ${f}`).join('\n')}\n\n`;
  }
  if (uiData.detailed_description) {
    combined += `DETAILED DESCRIPTION:\n${uiData.detailed_description}\n\n`;
  }
  if (Array.isArray(uiData.specs) && uiData.specs.length > 0) {
    combined += `TECHNICAL SPECIFICATIONS:\n${uiData.specs.map((s) => `${s.key}: ${s.value}`).join('\n')}`;
  }

  const fallback = String(original.product_name || '').trim();
  return (combined || fallback || 'Auto-generated product description').trim();
}

function isUsableGeneratedText(value = '') {
  const text = String(value || '').trim();
  if (!text) return false;
  if (/^(auto[-\s]?generated|fallback|n\/a|none)$/i.test(text)) return false;
  return text.length >= 8;
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

function createAiError(reasonCode, message, extra = {}) {
  const err = new Error(message);
  err.reasonCode = reasonCode;
  err.retryable = Boolean(extra.retryable);
  if (extra.status) err.status = Number(extra.status);
  if (extra.detail) err.detail = String(extra.detail);
  if (extra.source) err.source = String(extra.source);
  return err;
}

function classifyAiHttpError(status, detail = '', source = '') {
  const cleanDetail = String(detail || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  const suffix = cleanDetail ? ` Details: ${cleanDetail}` : '';

  if (status === 429) {
    return createAiError('AI_RATE_LIMIT', `AI service is rate-limited (429). Please retry shortly.${suffix}`, {
      status,
      retryable: true,
      source,
    });
  }

  if (status === 530) {
    return createAiError('AI_UPSTREAM_UNAVAILABLE', `AI service is unavailable (Cloudflare 530). Please retry after a short wait.${suffix}`, {
      status,
      retryable: true,
      source,
    });
  }

  if (status === 401 || status === 403) {
    return createAiError('AI_AUTH_ERROR', `AI service rejected the request (${status}). Check webhook authentication/configuration.${suffix}`, {
      status,
      retryable: false,
      source,
    });
  }

  if (status >= 500) {
    return createAiError('AI_UPSTREAM_UNAVAILABLE', `AI service upstream error (${status}). Please retry shortly.${suffix}`, {
      status,
      retryable: true,
      source,
    });
  }

  return createAiError('AI_BAD_REQUEST', `AI service rejected the payload (${status}). Please verify product input fields and retry.${suffix}`, {
    status,
    retryable: false,
    source,
  });
}

function normalizeAiRequestError(err, source = '') {
  if (err?.reasonCode) return err;

  const code = String(err?.code || '').toUpperCase();
  const message = String(err?.message || '').trim();
  const status = Number(err?.status || 0);

  if (status > 0) {
    return classifyAiHttpError(status, message, source);
  }

  if (code === 'ABORT_ERR' || /aborted|timeout/i.test(message)) {
    return createAiError('AI_TIMEOUT', 'AI request timed out while generating content. Please retry.', {
      retryable: true,
      source,
    });
  }

  if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT'].includes(code)) {
    return createAiError('AI_NETWORK_ERROR', `Could not reach AI service (${code}). Check network/tunnel and retry.`, {
      retryable: true,
      source,
    });
  }

  return createAiError('AI_UNAVAILABLE', `AI service call failed. ${message || 'Please retry.'}`, {
    retryable: true,
    source,
  });
}

function getAiWebhookCandidates() {
  return [N8N_WEBHOOK_URL, N8N_WEBHOOK_FALLBACK_URL]
    .map((url) => String(url || '').trim())
    .filter(Boolean);
}

async function callAiWebhookWithRetry(url, payload, maxAttempts = 3) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 45000);
      let response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!response.ok) {
        const raw = await response.text();
        let detail = raw;
        try {
          const parsed = JSON.parse(raw);
          detail = parsed?.message || parsed?.error || raw;
        } catch (_) {
          // Keep raw text when response is not JSON.
        }

        const err = classifyAiHttpError(response.status, detail, url);

        const retryable = response.status >= 500 || response.status === 429;
        if (!retryable || attempt === maxAttempts) {
          throw err;
        }

        await sleep(attempt * 1200);
        continue;
      }

      let result;
      try {
        result = await response.json();
      } catch (_) {
        throw createAiError('AI_INVALID_RESPONSE', 'AI service returned non-JSON response. Please retry.', {
          status: 502,
          retryable: true,
          source: url,
        });
      }

      return result;
    } catch (err) {
      const normalized = normalizeAiRequestError(err, url);
      lastError = normalized;
      const retryable = Boolean(normalized.retryable);
      if (!retryable || attempt === maxAttempts) {
        break;
      }
      await sleep(attempt * 1200);
    }
  }

  throw lastError || new Error('AI webhook request failed');
}

async function generateAiContent(payload) {
  const candidates = getAiWebhookCandidates();
  if (candidates.length === 0) {
    throw createAiError('AI_CONFIG_ERROR', 'AI webhook is not configured. Contact admin to set N8N_SEARCH_WEBHOOK.', {
      retryable: false,
    });
  }

  let lastError = null;

  for (const url of candidates) {
    try {
      const result = await callAiWebhookWithRetry(url, payload);
      const normalized = Array.isArray(result) && result[0] && result[0].json ? result[0].json : result;
      const withFallback = normalizeAiContentWithFallback(normalized, payload);

      return {
        data: withFallback,
        source: url,
        usedContentFallback: !isUsableAiResult(normalized, payload),
      };
    } catch (err) {
      lastError = normalizeAiRequestError(err, url);
    }
  }

  throw lastError || createAiError('AI_UNAVAILABLE', 'AI generation failed for all configured webhooks. Please retry.', {
    retryable: true,
  });
}

function mapItemToCatalogPayload(item) {
  const uiData = item?.result?.generated_content || item?.result || {};
  const original = item?.original || {};
  const explicitCode = String(original.communetsCode || '').trim();
  const lookupSource = String(original.lookupSource || '').trim();
  const effectiveLookupSource = lookupSource || (isReservedBufferGsCode(explicitCode) ? 'reserved-buffer-publish' : '');
  const legacyOldGs = String(original.oldGs || original.legacyLookupOldGs || '').trim();
  const canonicalCode = String(
    original.productOGCode ||
    original.ean ||
    ''
  ).trim();
  const rawImages = [
    sanitizeImageUrl(original.image_url),
    sanitizeImageUrl(original.image_url_2),
    sanitizeImageUrl(original.image_url_3),
    sanitizeImageUrl(original.image_url_4),
  ].filter(Boolean);
  const preUploadedImages = rawImages.length > 0 ? rawImages : [DEFAULT_PRODUCT_IMAGE_URL];
  const fallbackTitle = getFallbackTitle(original);

  return {
    communetsCode: explicitCode,
    productName: original.keepOriginalName
      ? String(original.product_name || '').trim() || fallbackTitle
      : String(uiData.seo_title || uiData.title || original.product_name || '').trim() || fallbackTitle,
    productOGCode: canonicalCode || legacyOldGs || null,
    legacyLookupOldGs: legacyOldGs || '',
    legacyLookupNewGs: explicitCode || '',
    lookupSource: effectiveLookupSource || undefined,
    unit: String(original.unit || 'Piece').trim() || 'Piece',
    stockQuantity: Math.max(0, Number(original.stockQty) || 0),
    wholeSaleQuantity: toPositiveNumber(original.wholesale_qty, 1),
    wholeSale: toPositiveNumber(original.price_wholesale, 1),
    retail: toPositiveNumber(original.price_retail, 1),
    costPrice: Number.isFinite(Number(original.costPrice)) ? Number(original.costPrice) : null,
    description: buildMergedDescription(item),
    categoryID: String(original.category || 'General').trim() || 'General',
    subCategoryID: String(original.subcategory || '').trim() || undefined,
    brand: String(original.brand || '').trim(),
    productStatus: 'Unverified',
    preUploadedImages: JSON.stringify(preUploadedImages),
  };
}

function getActorRole(job) {
  return String(job?.actorRole || 'seller').trim().toLowerCase();
}

function getActorId(job) {
  return String(job?.actorId || job?.vendorId || 'system').trim();
}

function getInputCodeFromItem(item) {
  return String(item?.original?.communetsCode || '').trim().toUpperCase();
}

async function uploadBufferToS3(imageBuffer, filename = 'enhanced_bulk_image.webp') {
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

async function buildProcessedImageUrlFromSource(sourceImageUrl) {
  const cleanSourceUrl = String(sourceImageUrl || '').trim();
  if (!cleanSourceUrl) return '';

  const resolvedSourceUrl = cleanSourceUrl.startsWith('/')
    ? toAbsoluteInternalUrl(cleanSourceUrl)
    : cleanSourceUrl;

  const imgResponse = await axios.get(resolvedSourceUrl, {
    responseType: 'arraybuffer',
    timeout: 30000,
    maxRedirects: 5,
  });

  const inputBuffer = Buffer.from(imgResponse.data);
  let compressedBuffer = inputBuffer;

  try {
    const { default: sharp } = await import('sharp');
    compressedBuffer = await sharp(inputBuffer)
      .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
  } catch (_) {
    // Keep original buffer if sharp fails for any reason.
  }

  let outputBuffer = compressedBuffer;

  if (ENHANCE_API_URL) {
    try {
      const formData = new FormData();
      formData.append('file', compressedBuffer, {
        filename: 'bulk_image.jpg',
        contentType: 'image/jpeg',
      });
      formData.append('format', 'webp');

      const formHeaders = formData.getHeaders();
      formHeaders['Content-Length'] = formData.getLengthSync();

      const modalRes = await axios.post(String(ENHANCE_API_URL).trim(), formData, {
        headers: formHeaders,
        responseType: 'arraybuffer',
        timeout: 120000,
      });

      outputBuffer = Buffer.from(modalRes.data, 'binary');
    } catch (enhanceErr) {
      console.warn('[Queue] Enhance API unavailable, using compressed image fallback:', enhanceErr.message);
    }
  }

  return uploadBufferToS3(outputBuffer, 'enhanced_bulk_image.webp');
}

async function resolveBulkCodeAction(job, inputCode) {
  const code = String(inputCode || '').trim().toUpperCase();
  // Product-code checks are disabled for catalog save flows.
  // Always continue with add flow; reserved GS preservation is handled separately.
  if (!code) return { action: 'add', warning: null, lookup: null };
  return {
    action: 'add',
    warning: `Code ${code} was ignored for save and treated as empty.`,
    lookup: null,
  };
}

function buildEditPayloadFromCatalogPayload(catalogPayload) {
  let images = [];
  try {
    const parsed = JSON.parse(catalogPayload.preUploadedImages || '[]');
    images = Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch (e) {
    images = [];
  }

  const payload = {
    productName: catalogPayload.productName,
    unit: catalogPayload.unit,
    stockQuantity: catalogPayload.stockQuantity,
    categoryID: catalogPayload.categoryID,
    subCategoryID: catalogPayload.subCategoryID,
    description: catalogPayload.description,
    wholeSale: catalogPayload.wholeSale,
    wholeSaleQuantity: catalogPayload.wholeSaleQuantity,
    retail: catalogPayload.retail,
    manufacturerID: catalogPayload.brand,
    costPrice: catalogPayload.costPrice,
    existingImages: JSON.stringify(images.length > 0 ? images : [DEFAULT_PRODUCT_IMAGE_URL]),
  };

  const rawOg = String(catalogPayload.productOGCode || '').trim();
  const isGsLike = /^GS\d+$/i.test(rawOg);
  if (rawOg && !isGsLike) {
    payload.productOGCode = rawOg;
  }

  return payload;
}

async function autoSaveWaveToCatalog(job, waveItems, startIdx, endIdxExclusive) {
  if (!BULK_AUTO_SAVE_WAVES) return;
  if (!job?.autoSaveEnabled) return;

  const actorId = getActorId(job);

  if (!actorId) {
    console.warn(`[Queue] [${job.id}] Auto-save skipped for rows ${startIdx + 1}-${endIdxExclusive}: missing actor identity.`);
    return;
  }

  let saved = 0;
  let failed = 0;

  for (let i = 0; i < waveItems.length; i += 1) {
    const item = waveItems[i];
    if (!item || item.status !== 'success' || item.autoSaveInFlight) continue;

    try {
      const payload = mapItemToCatalogPayload(item);

      const rawCode = getInputCodeFromItem(item);
      const action = await resolveBulkCodeAction(job, rawCode);
      const reservedBufferFlow = isReservedBufferFlow(item);
      const preserveReservedCode = !reservedBufferFlow && shouldPreserveReservedCode(item, rawCode);

      if (action.warning && !preserveReservedCode) {
        item.codeWarning = action.warning;
      }

      if (action.action === 'forbidden') {
        throw new Error(action.error || 'Access denied for this code');
      }

      let hasPreexistingEan = false;
      let preExistingProduct = null;
      if (payload.productOGCode) {
        try {
          const checkRes = await axios.get(`${INTERNAL_BACKEND_URL}/v1/products/check-ean`, {
            params: {
              ean: payload.productOGCode,
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
          console.error(`[Queue] [${job.id}] Error checking EAN during wave save`, err.message);
        }
      }

      if (action.action === 'override' || hasPreexistingEan) {
        const targetProductId = hasPreexistingEan
          ? preExistingProduct.productId
          : action.targetProductId;

        const editPayload = buildEditPayloadFromCatalogPayload(payload);
        await axios.put(
          `${INTERNAL_BACKEND_URL}/v1/products/edit/${encodeURIComponent(targetProductId)}`,
          editPayload,
          {
            headers: {
              'x-internal-call': '1',
              'x-internal-user-id': actorId,
              'Content-Type': 'application/json',
            },
          }
        );
        item.overrideApplied = true;
        item.saveFlow = 'preexist-override';
        item.assignedCommunetsCode = hasPreexistingEan
          ? String(preExistingProduct?.communetCode || '').trim()
          : String(action?.lookup?.resolvedCode || action?.lookup?.product?.communetCode || rawCode || '').trim();
      } else {
          if (reservedBufferFlow) {
            const { saveRes, reservedCode } = await saveReservedCatalogItemWithRetry(
              payload,
              actorId,
              item,
              startIdx + i,
              4,
              payload.communetsCode
            );
            item.saveFlow = 'reserved-buffer-finalized';
            item.assignedCommunetsCode = String(saveRes?.data?.product?.communetCode || reservedCode || '').trim();
          } else {
            // For empty/unknown non-reserved input codes, force main backend to auto-generate GS.
            if (!preserveReservedCode) {
              payload.communetsCode = '';
              payload.legacyLookupNewGs = '';
            }
            const saveRes = await axios.post(`${INTERNAL_BACKEND_URL}/v1/products/add`, payload, {
              headers: {
                'x-internal-call': '1',
                'x-internal-user-id': actorId,
              },
            });
            item.saveFlow = preserveReservedCode
              ? 'reserved-buffer-preserved'
              : (rawCode ? 'code-not-found-auto-assigned' : 'code-empty-auto-assigned');
            item.assignedCommunetsCode = String(saveRes?.data?.product?.communetCode || '').trim();
          }
      }

      item.status = 'saved_to_catalog';
      saved += 1;
      job.savedCount += 1;
    } catch (err) {
      failed += 1;
      job.saveFailCount += 1;
      item.saveError = err.response?.data?.error || err.response?.data?.message || err.message;
      console.error(`[Queue] [${job.id}] Auto-save failed at item ${startIdx + i + 1}:`, item.saveError);
    }
  }

  console.log(`[Queue] [${job.id}] Wave ${startIdx + 1}-${endIdxExclusive} auto-save: saved=${saved}, failed=${failed}`);
  job.updatedAt = new Date();
}

async function autoSaveSingleItemToCatalog(job, item, itemIndex) {
  if (!BULK_AUTO_SAVE_WAVES) return;
  if (!job?.autoSaveEnabled) return;
  if (!item || item.status !== 'success' || item.status === 'saved_to_catalog') return;
  if (item.autoSaveInFlight) return;

  const actorId = getActorId(job);
  if (!actorId) {
    console.warn(`[Queue] [${job.id}] Auto-save skipped at item ${itemIndex + 1}: missing actor identity.`);
    return;
  }

  item.autoSaveInFlight = true;
  try {
    const payload = mapItemToCatalogPayload(item);
    const rawCode = getInputCodeFromItem(item);
    const action = await resolveBulkCodeAction(job, rawCode);
    const reservedBufferFlow = isReservedBufferFlow(item);
    const preserveReservedCode = !reservedBufferFlow && shouldPreserveReservedCode(item, rawCode);

    if (action.warning && !preserveReservedCode) {
      item.codeWarning = action.warning;
    }

    if (action.action === 'forbidden') {
      throw new Error(action.error || 'Access denied for this code');
    }

    let hasPreexistingEan = false;
    let preExistingProduct = null;
    if (payload.productOGCode) {
      try {
        const checkRes = await axios.get(`${INTERNAL_BACKEND_URL}/v1/products/check-ean`, {
          params: {
            ean: payload.productOGCode,
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
        console.error(`[Queue] [${job.id}] Error checking EAN during single item save`, err.message);
      }
    }

    if (action.action === 'override' || hasPreexistingEan) {
      const targetProductId = hasPreexistingEan
        ? preExistingProduct.productId
        : action.targetProductId;

      const editPayload = buildEditPayloadFromCatalogPayload(payload);
      await axios.put(
        `${INTERNAL_BACKEND_URL}/v1/products/edit/${encodeURIComponent(targetProductId)}`,
        editPayload,
        {
          headers: {
            'x-internal-call': '1',
            'x-internal-user-id': actorId,
            'Content-Type': 'application/json',
          },
        }
      );
      item.overrideApplied = true;
      item.saveFlow = 'preexist-override';
      item.assignedCommunetsCode = hasPreexistingEan
        ? String(preExistingProduct?.communetCode || '').trim()
        : String(action?.lookup?.resolvedCode || action?.lookup?.product?.communetCode || rawCode || '').trim();
    } else {
        if (reservedBufferFlow) {
          const { saveRes, reservedCode } = await saveReservedCatalogItemWithRetry(
            payload,
            actorId,
            item,
            itemIndex,
            4,
            payload.communetsCode
          );
          item.saveFlow = 'reserved-buffer-finalized';
          item.assignedCommunetsCode = String(saveRes?.data?.product?.communetCode || reservedCode || '').trim();
        } else {
          // For empty/unknown non-reserved input codes, force main backend to auto-generate GS.
          if (!preserveReservedCode) {
            payload.communetsCode = '';
            payload.legacyLookupNewGs = '';
          }
          const saveRes = await axios.post(`${INTERNAL_BACKEND_URL}/v1/products/add`, payload, {
            headers: {
              'x-internal-call': '1',
              'x-internal-user-id': actorId,
            },
          });
          item.saveFlow = preserveReservedCode
            ? 'reserved-buffer-preserved'
            : (rawCode ? 'code-not-found-auto-assigned' : 'code-empty-auto-assigned');
          item.assignedCommunetsCode = String(saveRes?.data?.product?.communetCode || '').trim();
        }
    }

    item.status = 'saved_to_catalog';
    item.saveError = null;
    job.savedCount += 1;
    console.log(`[Queue] [${job.id}] Auto-saved item ${itemIndex + 1} to catalog.`);
  } catch (err) {
    job.saveFailCount += 1;
    item.saveError = err.response?.data?.error || err.response?.data?.message || err.message;
    console.error(`[Queue] [${job.id}] Auto-save failed at item ${itemIndex + 1}:`, item.saveError);
  } finally {
    item.autoSaveInFlight = false;
    job.updatedAt = new Date();
  }
}

async function runAiGeneration(job, item, i, { countProcessed = true } = {}) {
  if (job.status === 'stopped') {
    console.log(`[Queue] Job ${job.id} item ${i} skipped (job stopped).`);
    return false;
  }

  const startingStatus = item.status;

  // If user opted to skip AI processing for this product
  if (item.original?.skipAi) {
    console.log(`[Queue] [${job.id}] Bypassing AI generation for item ${i + 1} (Direct Catalog Import)`);
    item.status = 'success';
    item.result = {
      seo_title: item.original.product_name || item.original.productName || 'Direct Catalog Product',
      overview: item.original.description || '',
      detailed_description: item.original.description || ''
    };
    if (startingStatus !== 'success') {
      job.successCount += 1;
    }
    if (countProcessed && startingStatus !== 'success') {
      job.processed += 1;
    }
    if (job.autoSaveEnabled) {
      setTimeout(() => {
        autoSaveSingleItemToCatalog(job, item, i).catch((err) => {
          console.error(`[Queue] [${job.id}] Delayed auto-save error at item ${i + 1}:`, err.message);
        });
      }, BULK_AUTO_SAVE_DELAY_MS);
    }
    job.updatedAt = new Date();
    return true;
  }

  item.status = 'processing';
  item.error = null;
  item.errorCode = null;
  job.updatedAt = new Date();

  try {
    console.log(`[Queue] [${job.id}] Processing item ${i + 1}/${job.total}: ${item.original.product_name || 'N/A'}`);
    console.log(`[Queue] [${job.id}] Image enhancement flags: processImage=${item.original.processImage}, processImage2=${item.original.processImage2}, processImage3=${item.original.processImage3}, processImage4=${item.original.processImage4}`);

    {
      try {
        const safePrimaryImage = getFirstSourceImage(item.original);
        const hasSourceImage = Boolean(String(safePrimaryImage || '').trim());
        const sourceImageUrl = hasSourceImage
          ? String(safePrimaryImage || '').trim()
          : toAbsoluteInternalUrl(DEFAULT_PRODUCT_IMAGE_URL);

        if (!sourceImageUrl) {
          throw new Error('Missing source image url');
        }

        // Avoid re-processing the same default image for every no-image row.
        if (!hasSourceImage && cachedDefaultEnhancedImageUrl) {
          item.original.image_url = cachedDefaultEnhancedImageUrl;
        } else if (item.original.processImage !== false && String(item.original.processImage) !== 'false') {
          console.log(`[Queue] [${job.id}] Item ${i} processing primary image from: ${sourceImageUrl}`);
          const enhancedUrl = await buildProcessedImageUrlFromSource(sourceImageUrl);
          console.log(`[Queue] [${job.id}] Item ${i} processed primary -> ${enhancedUrl}`);
          if (enhancedUrl) {
            item.original.image_url = enhancedUrl;
            if (!hasSourceImage) {
              cachedDefaultEnhancedImageUrl = enhancedUrl;
            }
          }
        } else {
          console.log(`[Queue] [${job.id}] Item ${i} primary image processing skipped (processImage is false). Keeping original URL: ${item.original.image_url}`);
        }

        // Process secondary images if explicitly flagged for AI enhancement
        const secondaryImages = [
          { key: 'image_url_2', flag: 'processImage2' },
          { key: 'image_url_3', flag: 'processImage3' },
          { key: 'image_url_4', flag: 'processImage4' },
        ];

        for (const sec of secondaryImages) {
          const imgUrl = String(item.original[sec.key] || '').trim();
          if (imgUrl) {
            const isFlagTrue = item.original[sec.flag] === true || String(item.original[sec.flag]) === 'true';
            if (isFlagTrue) {
              console.log(`[Queue] [${job.id}] Item ${i} processing secondary image ${sec.key} from: ${imgUrl}`);
              try {
                const enhancedUrl = await buildProcessedImageUrlFromSource(imgUrl);
                if (enhancedUrl) {
                  item.original[sec.key] = enhancedUrl;
                  console.log(`[Queue] [${job.id}] Item ${i} processed secondary ${sec.key} -> ${enhancedUrl}`);
                } else {
                  item.original[sec.key] = sanitizeImageUrl(imgUrl);
                }
              } catch (secErr) {
                console.error(`[Queue] [${job.id}] Item ${i} secondary image ${sec.key} processing failed, keeping sanitized:`, secErr.message);
                item.original[sec.key] = sanitizeImageUrl(imgUrl);
              }
            } else {
              item.original[sec.key] = sanitizeImageUrl(imgUrl);
            }
          }
        }
      } catch (enhanceErr) {
        console.error(`[Queue] [${job.id}] Item ${i} image processing failed, using original/default:`, enhanceErr.message);
      }
    }

    const aiResult = await generateAiContent(item.original);
    const finalData = aiResult.data;

    item.status = 'success';
    item.result = finalData;
    item.error = null;
    item.errorCode = null;
    if (startingStatus !== 'success') {
      job.successCount += 1;
      if (startingStatus === 'failed' && job.failCount > 0) job.failCount -= 1;
    }

    if (countProcessed && startingStatus !== 'success') {
      job.processed += 1;
    }

    // Auto-save each success only when job-level auto-save is enabled.
    if (job.autoSaveEnabled) {
      setTimeout(() => {
        autoSaveSingleItemToCatalog(job, item, i).catch((err) => {
          console.error(`[Queue] [${job.id}] Delayed auto-save error at item ${i + 1}:`, err.message);
        });
      }, BULK_AUTO_SAVE_DELAY_MS);
    }

    job.updatedAt = new Date();
    return true;
  } catch (err) {
    console.error(`[Queue] [${job.id}] Error processing item ${i}:`, err.message);
    item.status = 'failed';
    item.error = String(err?.message || 'AI processing failed');
    item.errorCode = String(err?.reasonCode || 'PROCESSING_FAILED');
    if (startingStatus !== 'failed') {
      job.failCount += 1;
    }
    if (countProcessed && startingStatus !== 'success') {
      job.processed += 1;
    }
    job.updatedAt = new Date();
    return false;
  }
}

export function createJob(products, vendorId = null, vendorEmail = null, actorRole = 'seller', actorId = null, autoSaveEnabled = false) {
  const effectiveActorId = String(actorId || vendorId || '').trim() || null;
  const effectiveVendorEmail = String(vendorEmail || '').trim() || null;
  const productsFingerprint = buildProductsFingerprint(products);
  const runningJob = findRunningJobConflict(effectiveActorId, vendorId, effectiveVendorEmail, productsFingerprint);
  if (runningJob) {
    const err = new Error(`Another bulk job is already running for this account (Job: ${runningJob.id}). Please wait for it to finish or stop it first.`);
    err.status = 409;
    err.code = 'JOB_ALREADY_RUNNING';
    err.jobId = runningJob.id;
    throw err;
  }

  const jobId = uuidv4();
  
  const job = {
    id: jobId,
    vendorId,
    vendorEmail,
    actorRole: String(actorRole || 'seller').toLowerCase(),
    actorId: effectiveActorId,
    productsFingerprint,
    autoSaveEnabled: Boolean(autoSaveEnabled),
    parallelCount: BULK_JOB_CONCURRENCY,
    status: 'running',
    total: products.length,
    processed: 0,
    successCount: 0,
    failCount: 0,
    savedCount: 0,
    saveFailCount: 0,
    cooldownActive: false,
    cooldownEndsAt: null,
    cooldownTotalMs: 0,
    error: null,
    items: products.map(p => ({
      original: p,
      status: 'pending',
      result: null,
      error: null
    })),
    createdAt: new Date(),
    updatedAt: new Date()
  };

  jobs.set(jobId, job);
  
  // Start processing in the background without awaiting it
  processJob(jobId).catch(err => {
    console.error(`[Queue] Fatal error processing job ${jobId}:`, err);
    const j = jobs.get(jobId);
    if (j) {
      j.status = 'failed';
      j.error = err.message;
      j.updatedAt = new Date();
    }
  });

  return jobId;
}

export function getJob(jobId) {
  return jobs.get(jobId) || null;
}

export function getAllJobs() {
  return Array.from(jobs.values()).map(job => ({
    id: job.id,
    actorId: job.actorId,
    autoSaveEnabled: Boolean(job.autoSaveEnabled),
    vendorId: job.vendorId,
    status: job.status,
    total: job.total,
    processed: job.processed,
    successCount: job.successCount,
    savedCount: job.savedCount,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  })).sort((a, b) => b.createdAt - a.createdAt);
}

export function setJobAutoSave(jobId, autoSaveEnabled) {
  const job = jobs.get(jobId);
  if (!job) return null;

  job.autoSaveEnabled = Boolean(autoSaveEnabled);
  job.updatedAt = new Date();
  return job;
}

export function stopJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return false;
  
  if (job.status === 'running') {
    job.status = 'stopped';
    job.cooldownActive = false;
    job.cooldownEndsAt = null;
    job.cooldownTotalMs = 0;
    job.updatedAt = new Date();
    console.log(`[Queue] Job ${jobId} was manually stopped.`);
    return true;
  }
  return false;
}

// Simple concurrency limiter helper
async function mapConcurrent(items, concurrency, asyncFn) {
  const results = [];
  const executing = new Set();
  
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const p = Promise.resolve().then(() => asyncFn(item, i));
    results.push(p);
    executing.add(p);
    
    p.then(() => executing.delete(p)).catch(() => executing.delete(p));
    
    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }
  return Promise.allSettled(results);
}

// Background loop
async function processJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;

  console.log(`[Queue] Starting job ${jobId} with ${job.total} items (Concurrency: ${BULK_JOB_CONCURRENCY}, Wave: ${BULK_WAVE_SIZE}, Continuous waves)`);

  // Process large imports in waves.
  for (let start = 0; start < job.items.length; start += BULK_WAVE_SIZE) {
    if (job.status === 'stopped') break;

    const endExclusive = Math.min(start + BULK_WAVE_SIZE, job.items.length);
    const waveItems = job.items.slice(start, endExclusive);

    console.log(`[Queue] [${jobId}] Starting wave ${start + 1}-${endExclusive} (${waveItems.length} items).`);
    await mapConcurrent(waveItems, BULK_JOB_CONCURRENCY, (item, waveIndex) => runAiGeneration(job, item, start + waveIndex));

    await autoSaveWaveToCatalog(job, waveItems, start, endExclusive);
  }

  // Only mark as completed if it wasn't stopped midway
  if (job.status !== 'stopped') {
    job.status = 'completed';
    job.cooldownActive = false;
    job.cooldownEndsAt = null;
    job.cooldownTotalMs = 0;
    console.log(`[Queue] Job ${jobId} completed. Success: ${job.successCount}, Failed: ${job.failCount}, Saved: ${job.savedCount}, SaveFailed: ${job.saveFailCount}`);
  }
  
  job.updatedAt = new Date();
}

