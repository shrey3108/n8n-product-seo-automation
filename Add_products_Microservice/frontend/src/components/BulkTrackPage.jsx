import React, { useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getJobStatus, getJobSummary, getJobItems, stopBulkJob, updateBulkJobAutoSave } from '../services/bulkApi';

const bulkTrackEditsKey = (jobId) => `ai-bulk-track-edits-${jobId}`;
const ITEMS_PER_PAGE = 50;

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0m';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function getFailureHint(item) {
  const code = String(item?.errorCode || '').trim().toUpperCase();
  switch (code) {
    case 'AI_CONFIG_ERROR':
      return 'AI webhook is not configured. Ask admin to set N8N_SEARCH_WEBHOOK.';
    case 'AI_TIMEOUT':
      return 'AI request timed out.';
    case 'AI_RATE_LIMIT':
      return 'AI provider rate-limited this request.';
    case 'AI_UPSTREAM_UNAVAILABLE':
      return 'AI upstream is unavailable (often tunnel/Cloudflare/outage).';
    case 'AI_AUTH_ERROR':
      return 'AI webhook auth failed. Verify webhook credentials/permissions.';
    case 'AI_BAD_REQUEST':
      return 'Input payload was rejected by AI service. Check product fields.';
    case 'AI_INVALID_RESPONSE':
      return 'AI responded but content was incomplete.';
    case 'AI_NETWORK_ERROR':
      return 'Network/Tunnel issue while contacting AI service. Check connectivity.';
    default:
      return 'Review the error details below.';
  }
}

function getFailureMessage(item) {
  const code = String(item?.errorCode || '').trim().toUpperCase();
  switch (code) {
    case 'AI_CONFIG_ERROR':
      return 'AI service is not configured.';
    case 'AI_TIMEOUT':
      return 'AI request timed out.';
    case 'AI_RATE_LIMIT':
      return 'AI service is busy (rate limit).';
    case 'AI_UPSTREAM_UNAVAILABLE':
      return 'AI service is temporarily unavailable.';
    case 'AI_AUTH_ERROR':
      return 'AI authentication failed.';
    case 'AI_BAD_REQUEST':
      return 'Invalid product data sent to AI service.';
    case 'AI_INVALID_RESPONSE':
      return 'AI returned incomplete content.';
    case 'AI_NETWORK_ERROR':
      return 'Network error while contacting AI service.';
    default:
      return 'AI processing failed for this item.';
  }
}

function getDisplayImageUrl(item = {}) {
  const original = item?.original || {};
  const candidates = [
    original.image_url,
    original.image_url_2,
    original.image_url_3,
    original.image_url_4,
  ];

  for (const candidate of candidates) {
    const url = String(candidate || '').trim();
    if (!url) continue;
    if (/^https?:\/\//i.test(url)) return url;
    if (url.startsWith('/')) {
      const backendOrigin = window.location.origin.includes(':5174')
        ? window.location.origin.replace(':5174', ':5274')
        : window.location.origin;
      return `${backendOrigin}${url}`;
    }
    return url;
  }

  return '';
}

export default function BulkTrackPage() {
  const { jobId } = useParams();
  const [job, setJob] = useState(null);
  const [jobItems, setJobItems] = useState([]);
  const [itemsPage, setItemsPage] = useState(1);
  const [itemsPages, setItemsPages] = useState(1);
  const [itemsTotal, setItemsTotal] = useState(0);
  const [loadingItems, setLoadingItems] = useState(false);
  const [error, setError] = useState(null);
  const [autoSaveEnabled, setAutoSaveEnabled] = useState(() => new URLSearchParams(window.location.search).get('autosave') === '1');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [submitAllStatus, setSubmitAllStatus] = useState('idle'); // idle | saving | done | error
  const [submitAllResult, setSubmitAllResult] = useState(null);
  const [vendorInfo, setVendorInfo] = useState({ name: 'Loading...', contact: 'Loading...' });
  const [nowMs, setNowMs] = useState(Date.now());
  const [excludedItemsMap, setExcludedItemsMap] = useState({});
  const excludedMapRef = useRef({});
  useEffect(() => {
    excludedMapRef.current = excludedItemsMap;
  }, [excludedItemsMap]);
  const backendAutoSaveEnabled = Boolean(job?.autoSaveEnabled);
  const clientAutoSaveFallbackEnabled = Boolean(autoSaveEnabled) && !backendAutoSaveEnabled;
  const autoSaveTimersRef = useRef({});
  const autoSaveScheduledRef = useRef(new Set());
  const saveInFlightRef = useRef(new Set());

  const toGlobalIdx = (localIdx) => ((itemsPage - 1) * ITEMS_PER_PAGE) + localIdx;

  useEffect(() => {
    let interval;
    const fetchStatus = async () => {
      try {
        // Poll summary only (lightweight, ~1-2KB) instead of full job with items (100+KB)
        const data = await getJobSummary(jobId);
        setJob(data);
        if (['completed', 'failed', 'stopped'].includes(data.status)) {
          clearInterval(interval);
        }
      } catch (err) {
        setError(err.message);
        clearInterval(interval);
      }
    };

    fetchStatus();
    interval = setInterval(fetchStatus, 3000);
    return () => clearInterval(interval);
  }, [jobId]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(bulkTrackEditsKey(jobId));
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return;

      if (!window.__bulkEdits) window.__bulkEdits = {};
      window.__bulkEdits[jobId] = parsed;
    } catch (_) {
      // Ignore malformed persisted edits.
    }
  }, [jobId]);

  useEffect(() => {
    const shouldWarn = job?.status === 'running';
    if (!shouldWarn) return undefined;

    const warningMessage = 'Bulk AI processing is running. Leaving this page may interrupt monitoring/actions. Do you want to leave?';

    const onBeforeUnload = (e) => {
      if (!shouldWarn) return;
      e.preventDefault();
      e.returnValue = '';
    };

    const onDocumentClickCapture = (e) => {
      const anchor = e.target?.closest?.('a[href]');
      if (!anchor) return;
      if (anchor.getAttribute('target') === '_blank') return;

      const href = anchor.getAttribute('href') || '';
      if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;

      const nextUrl = new URL(anchor.href, window.location.href);
      if (nextUrl.href === window.location.href) return;

      if (!window.confirm(warningMessage)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    const originalPushState = window.history.pushState.bind(window.history);
    const originalReplaceState = window.history.replaceState.bind(window.history);

    window.history.pushState = function patchedPushState(...args) {
      if (!window.confirm(warningMessage)) return;
      return originalPushState(...args);
    };

    window.history.replaceState = function patchedReplaceState(...args) {
      if (!window.confirm(warningMessage)) return;
      return originalReplaceState(...args);
    };

    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onDocumentClickCapture, true);

    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onDocumentClickCapture, true);
      window.history.pushState = originalPushState;
      window.history.replaceState = originalReplaceState;
    };
  }, [job, jobId]);

  useEffect(() => {
    const isRunning = job?.status === 'running';
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(
        { type: 'AI_IMPORT_PROCESSING_STATE', active: isRunning },
        '*'
      );
    }

    return () => {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(
          { type: 'AI_IMPORT_PROCESSING_STATE', active: false },
          '*'
        );
      }
    };
  }, [job?.status]);

  useEffect(() => {
    if (!job) return;
    if (typeof job.autoSaveEnabled === 'boolean') {
      setAutoSaveEnabled(job.autoSaveEnabled);
    }
  }, [job?.autoSaveEnabled]);

  useEffect(() => {
    if (!job?.cooldownActive) return undefined;

    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 1000);

    return () => clearInterval(timer);
  }, [job?.cooldownActive]);

  // Fetch real vendor name + contact as soon as we have a vendorId
  useEffect(() => {
    if (!job?.vendorId) return;
    fetch(`/ai-api/vendor-info/${job.vendorId}`)
      .then(r => r.json())
      .then(d => { if (d.name) setVendorInfo({ name: d.name, contact: d.contact || 'N/A' }); })
      .catch(() => setVendorInfo({ name: job.vendorId, contact: 'N/A' }));
  }, [job?.vendorId]);

  // Load items on-demand with pagination and refresh whenever summary updates.
  useEffect(() => {
    if (!job) return;

    const loadItems = async () => {
      setLoadingItems(true);
      try {
        const data = await getJobItems(jobId, itemsPage, ITEMS_PER_PAGE);
        setJobItems(data.items || []);
        setItemsTotal(data.total || 0);
        setItemsPages(data.pages || 1);
        setSelectedIdx((prev) => {
          const items = data.items || [];
          if (items.length === 0) return 0;
          const firstNonExcluded = items.findIndex((_, i) => !excludedMapRef.current.hasOwnProperty(((itemsPage - 1) * ITEMS_PER_PAGE) + i));
          if (firstNonExcluded !== -1) return firstNonExcluded;
          return Math.min(prev, items.length - 1);
        });
      } catch (err) {
        console.error('Failed to load items:', err);
        setJobItems([]);
      } finally {
        setLoadingItems(false);
      }
    };

    loadItems();
  }, [jobId, itemsPage, job?.updatedAt, job?.status]);

  const handleStop = async () => {
    if (!window.confirm('Are you sure you want to stop this background job early?')) return;
    setStopping(true);
    try {
      await stopBulkJob(jobId);
      const data = await getJobStatus(jobId);
      setJob(data);
    } catch (err) {
      alert('Failed to stop job: ' + err.message);
    } finally {
      setStopping(false);
    }
  };

  const handleToggleAutoSave = async (checked) => {
    setAutoSaveEnabled(checked);
    try {
      await updateBulkJobAutoSave(jobId, checked);
      const data = await getJobStatus(jobId);
      setJob(data);
    } catch (err) {
      setAutoSaveEnabled(!checked);
      alert(`Failed to update auto-save setting: ${err.message}`);
    }
  };

  const handleExcludeItem = (localIdx) => {
    const globalIdx = toGlobalIdx(localIdx);
    const item = jobItems[localIdx];
    if (!item) return;

    const nextExcluded = { ...excludedItemsMap, [globalIdx]: item.status };
    setExcludedItemsMap(nextExcluded);

    if (selectedIdx === localIdx) {
      const remainingLocalIdx = jobItems.findIndex((_, i) => i !== localIdx && !nextExcluded.hasOwnProperty(toGlobalIdx(i)));
      if (remainingLocalIdx !== -1) {
        setSelectedIdx(remainingLocalIdx);
      } else {
        setSelectedIdx(-1);
      }
    }
  };

  const handleRestoreItem = (localIdx) => {
    const globalIdx = toGlobalIdx(localIdx);
    setExcludedItemsMap(prev => {
      const next = { ...prev };
      delete next[globalIdx];
      return next;
    });
    if (selectedIdx === -1) {
      setSelectedIdx(localIdx);
    }
  };

  const buildProductRowArray = (idx) => {
    // idx is page-local index; convert to item from current page
    const item = jobItems?.[idx];
    if (!item) return null;
    const globalIdx = toGlobalIdx(idx);

    const eSt = window.__bulkEdits?.[jobId]?.[globalIdx] || {};
    const getVal = (key, fallback) => (eSt[key] !== undefined ? eSt[key] : fallback);
    const uiData = item.result?.generated_content || item.result || {};
    const original = item.original || {};
    const legacyCode = original.ean || original.oldGs || original.legacyLookupOldGs || '';

    let defaultCombined = uiData.overview ? `${uiData.overview}\n\n` : '';
    if (uiData.features?.length > 0) defaultCombined += 'KEY FEATURES:\n' + uiData.features.map((f) => `• ${f}`).join('\n') + '\n\n';
    if (uiData.detailed_description) defaultCombined += `DETAILED DESCRIPTION:\n${uiData.detailed_description}\n\n`;
    if (uiData.specs?.length > 0) defaultCombined += 'TECHNICAL SPECIFICATIONS:\n' + uiData.specs.map((s) => `${s.key}: ${s.value}`).join('\n');

    return [
      job?.vendorId || '',
      getVal('communetsCode', original.communetsCode || ''),
      getVal('product_name', original.keepOriginalName ? (original.product_name || original.productName || '') : (uiData.seo_title || original.product_name || original.productName || '')),
      'unverified',
      getVal('ean', legacyCode),
      getVal('unit', original.unit || 'Piece'),
      getVal('stockQty', original.stockQty || ''),
      getVal('category', original.category || ''),
      getVal('subcategory', original.subcategory || ''),
      getVal('combined_description', defaultCombined).trim(),
      getVal('price_wholesale', original.price_wholesale || ''),
      getVal('wholesale_qty', original.wholesale_qty || ''),
      getVal('price_retail', original.price_retail || ''),
      vendorInfo.name,
      vendorInfo.contact,
      getVal('costPrice', original.costPrice || ''),
      getVal('brand', original.brand || ''),
      original.image_url || '',
      original.image_url_2 || '',
      original.image_url_3 || '',
      original.image_url_4 || ''
    ];
  };

  const saveSingleItemToCatalog = async (idx, { silent = false } = {}) => {
    if (!job || saveInFlightRef.current.has(idx)) return;

    // idx is page-local; get item from current page  
    const item = jobItems?.[idx];
    if (!item || item.status !== 'success') return;
    const globalIdx = toGlobalIdx(idx);

    const productRowArray = buildProductRowArray(idx);
    if (!productRowArray) return;

    saveInFlightRef.current.add(idx);
    const btn = document.getElementById(`save-btn-${idx}`);
    const prevText = btn?.textContent;

    if (btn) {
      btn.disabled = true;
      btn.textContent = '⏳ Saving...';
    }

    try {
      const res = await fetch(`/ai-api/bulk/finalize/${jobId}/${globalIdx}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productRowArray })
      });

      if (!res.ok) throw new Error(await res.text());
      const payload = await res.json();

      if (btn) {
        btn.textContent = '🎉 Saved to Catalog!';
        btn.classList.add('bg-blue-600', 'hover:bg-blue-700');
        btn.classList.remove('bg-green-600', 'hover:bg-green-500');
      }

      autoSaveScheduledRef.current.add(idx);
      const freshJob = await getJobStatus(jobId);
      setJob(freshJob);

      if (window.__bulkEdits?.[jobId]?.[globalIdx]) {
        delete window.__bulkEdits[jobId][globalIdx];
        try {
          localStorage.setItem(bulkTrackEditsKey(jobId), JSON.stringify(window.__bulkEdits[jobId] || {}));
        } catch (_) {
          // Ignore localStorage failures.
        }
      }

      if (!silent && payload?.assignedCommunetsCode) {
        alert(`Saved. Assigned/Used Communets Code: ${payload.assignedCommunetsCode} (${payload.saveFlow || 'saved'})`);
      }
    } catch (err) {
      if (btn) {
        btn.disabled = false;
        btn.textContent = prevText || '✅ Save to Catalog';
      }
      if (!silent) {
        alert('Error saving to catalog: ' + err.message);
      }
    } finally {
      saveInFlightRef.current.delete(idx);
    }
  };

  const handleSubmitAll = async ({ skipConfirm = false } = {}) => {
    if (!job) return;
    if (backendAutoSaveEnabled) {
      alert('Auto Save is enabled on the server for this job. Manual Submit All is disabled to prevent duplicate saves.');
      return;
    }
    const fullJob = await getJobStatus(jobId);
    const fullItems = Array.isArray(fullJob?.items) ? fullJob.items : [];
    const successItems = fullItems
      .map((item, idx) => ({ item, idx }))
      .filter(({ item, idx }) => item.status === 'success' && !excludedItemsMap.hasOwnProperty(idx));

    if (successItems.length === 0) {
      alert('No successfully generated items to save.');
      return;
    }
    if (!skipConfirm && !window.confirm(`Save all ${successItems.length} completed products to catalog?`)) return;

    setSubmitAllStatus('saving');
    setSubmitAllResult(null);

    const rows = successItems.map(({ item, idx }) => {
      const eSt = window.__bulkEdits?.[jobId]?.[idx] || {};
      const getVal = (key, fallback) => eSt[key] !== undefined ? eSt[key] : fallback;
      const uiData = item.result?.generated_content || item.result || {};
      const original = item.original || {};
      const legacyCode = original.ean || original.oldGs || original.legacyLookupOldGs || '';

      let defaultCombined = uiData.overview ? `${uiData.overview}\n\n` : '';
      if (uiData.features?.length > 0) defaultCombined += 'KEY FEATURES:\n' + uiData.features.map(f => `• ${f}`).join('\n') + '\n\n';
      if (uiData.detailed_description) defaultCombined += `DETAILED DESCRIPTION:\n${uiData.detailed_description}\n\n`;
      if (uiData.specs?.length > 0) defaultCombined += 'TECHNICAL SPECIFICATIONS:\n' + uiData.specs.map(s => `${s.key}: ${s.value}`).join('\n');
      const finalCombined = getVal('combined_description', defaultCombined);

      return {
        idx,
        productRowArray: [
          job.vendorId || '',
          getVal('communetsCode', original.communetsCode || ''),
          getVal('product_name', original.keepOriginalName ? (original.product_name || original.productName || '') : (uiData.seo_title || original.product_name || original.productName || '')),
          'unverified',
          getVal('ean', legacyCode),
          getVal('unit', original.unit || 'Piece'),
          getVal('stockQty', original.stockQty || ''),
          getVal('category', original.category || ''),
          getVal('subcategory', original.subcategory || ''),
          finalCombined.trim(),
          getVal('price_wholesale', original.price_wholesale || ''),
          getVal('wholesale_qty', original.wholesale_qty || ''),
          getVal('price_retail', original.price_retail || ''),
          vendorInfo.name,          // 13. Vendor Details — real name
          vendorInfo.contact,       // 14. Vendor Contact — real contact
          getVal('costPrice', original.costPrice || ''),
          getVal('brand', original.brand || ''),
          original.image_url || '',
          original.image_url_2 || '',
          original.image_url_3 || '',
          original.image_url_4 || ''
        ]
      };
    });

    try {
      const res = await fetch(`/ai-api/bulk/finalize-all/${jobId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Server error');
      setSubmitAllStatus('done');
      setSubmitAllResult(data);
      const freshJob = await getJobStatus(jobId);
      setJob(freshJob);
    } catch (err) {
      setSubmitAllStatus('error');
      setSubmitAllResult({ error: err.message });
    }
  };

  useEffect(() => {
    if (!clientAutoSaveFallbackEnabled || !job) return;
    if (vendorInfo.name === 'Loading...') return;

    jobItems.forEach((item, idx) => {
      if (item?.status === 'saved_to_catalog') {
        autoSaveScheduledRef.current.add(idx);
        const pending = autoSaveTimersRef.current[idx];
        if (pending) {
          clearTimeout(pending);
          delete autoSaveTimersRef.current[idx];
        }
        return;
      }

      if (item?.status === 'success') {
        if (autoSaveScheduledRef.current.has(idx) || autoSaveTimersRef.current[idx] || saveInFlightRef.current.has(idx)) {
          return;
        }
        autoSaveScheduledRef.current.add(idx);
        autoSaveTimersRef.current[idx] = setTimeout(async () => {
          delete autoSaveTimersRef.current[idx];
          await saveSingleItemToCatalog(idx, { silent: true });
        }, 5000);
        return;
      }

      const pending = autoSaveTimersRef.current[idx];
      if (pending) {
        clearTimeout(pending);
        delete autoSaveTimersRef.current[idx];
      }
    });
  }, [clientAutoSaveFallbackEnabled, job, jobItems, vendorInfo.name]);

  useEffect(() => {
    if (clientAutoSaveFallbackEnabled) return;
    Object.values(autoSaveTimersRef.current).forEach((timerId) => clearTimeout(timerId));
    autoSaveTimersRef.current = {};
  }, [clientAutoSaveFallbackEnabled]);

  useEffect(() => {
    return () => {
      Object.values(autoSaveTimersRef.current).forEach((timerId) => clearTimeout(timerId));
      autoSaveTimersRef.current = {};
    };
  }, []);

  if (error) {
    return (
      <div className="p-8 text-center bg-white rounded-xl shadow mt-8 max-w-2xl mx-auto">
        <h2 className="text-red-600 font-bold text-xl mb-4">Error loading job</h2>
        <p className="text-gray-600 mb-6">{error}</p>
        <Link to="/" className="text-blue-600 font-bold hover:underline">← Back to Dashboard</Link>
      </div>
    );
  }

  if (!job) {
    return (
      <div className="p-8 text-center bg-white rounded-xl shadow mt-8 max-w-2xl mx-auto flex flex-col items-center">
         <div className="w-10 h-10 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin mb-4"></div>
         <p className="text-gray-600 font-bold">Loading job {jobId}...</p>
      </div>
    );
  }

  const progressPct = job.total > 0 ? Math.round((job.processed / job.total) * 100) : 0;
  const createdAtMs = new Date(job.createdAt).getTime();
  const currentTimeMs = Date.now();
  const elapsedMs = Number.isFinite(createdAtMs) ? Math.max(0, currentTimeMs - createdAtMs) : 0;
  const throughputPerSec = elapsedMs > 0 ? (job.processed / (elapsedMs / 1000)) : 0;
  const remainingItems = Math.max(0, job.total - job.processed);
  const etaMs = throughputPerSec > 0 ? (remainingItems / throughputPerSec) * 1000 : 0;
  const etaText = job.status === 'running'
    ? (throughputPerSec > 0 ? formatDuration(etaMs) : 'Calculating...')
    : 'Done';
  const rateText = throughputPerSec > 0 ? `${throughputPerSec.toFixed(2)} item/s` : '0 item/s';
  const cooldownEndsAtMs = job.cooldownEndsAt ? new Date(job.cooldownEndsAt).getTime() : 0;
  const cooldownRemainingMs = job.cooldownActive
    ? Math.max(0, cooldownEndsAtMs - nowMs)
    : 0;
  const cooldownRemainingSec = Math.ceil(cooldownRemainingMs / 1000);
  
  // Excluded item count calculations
  const excludedValues = Object.values(excludedItemsMap);
  const excludedSuccess = excludedValues.filter(s => s === 'success').length;
  const excludedFailed = excludedValues.filter(s => s === 'failed').length;
  const excludedTotal = excludedValues.length;

  const totalCount = job ? Math.max(0, job.total - excludedTotal) : 0;
  const successCount = job ? Math.max(0, job.successCount - excludedSuccess) : 0;
  const failCount = job ? Math.max(0, job.failCount - excludedFailed) : 0;

  // The item to display (page-local index)
  const currentItem = selectedIdx !== -1 ? jobItems[selectedIdx] : null;
  // AI processing returns { user_input: {...}, generated_content: {...} }
  const uiData = currentItem?.result?.generated_content || currentItem?.result || {};
  const original = currentItem?.original || {};
  const displayImageUrl = getDisplayImageUrl(currentItem);

  return (
    <div className="max-w-6xl mx-auto w-full px-4 sm:px-6 py-8">
      
      <div className="mb-6">
        <Link to="/" className="text-blue-600 font-bold hover:underline">← Back to Dashboard</Link>
      </div>

      {/* Progress Header */}
      <div className="bg-white rounded-xl shadow-lg p-6 mb-6 border-t-4 border-blue-800">
        <div className="flex justify-between items-end mb-2">
           <div>
             <h2 className="text-2xl font-bold text-navy">Bulk Processing Job</h2>
             <p className="text-gray-500 text-sm mt-1 font-mono">ID: {jobId}</p>
           </div>
           <div className="text-right">
             <div className="flex items-center justify-end gap-4 mb-1">
               <div className="text-3xl font-bold text-blue-800">{progressPct}%</div>
               {job.status === 'running' && (
                 <button 
                   onClick={handleStop}
                   disabled={stopping}
                   className="bg-red-100 hover:bg-red-200 text-red-700 font-bold py-1 px-3 rounded-lg border border-red-300 transition-colors text-xs flex items-center gap-1 disabled:opacity-50"
                 >
                   {stopping ? '⏳ Stopping...' : '🛑 Stop Job'}
                 </button>
               )}
             </div>
             <p className="text-sm font-bold text-gray-500 uppercase tracking-wide">
               {job.status === 'running' ? 'Processing...' : job.status}
             </p>
           </div>
        </div>
        
        <div className="w-full h-3 bg-gray-100 rounded-full overflow-hidden mb-3">
           <div 
             className={`h-full transition-all duration-500 ${job.status === 'failed' ? 'bg-red-500' : job.status === 'stopped' ? 'bg-yellow-500' : 'bg-gradient-to-r from-blue-600 to-green-500'}`}
             style={{ width: `${progressPct}%` }}
           ></div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-3 text-xs font-semibold">
          <div className="bg-blue-50 border border-blue-200 rounded px-3 py-2 text-blue-800">Elapsed: {formatDuration(elapsedMs)}</div>
          <div className="bg-indigo-50 border border-indigo-200 rounded px-3 py-2 text-indigo-800">ETA: {etaText}</div>
          <div className="bg-purple-50 border border-purple-200 rounded px-3 py-2 text-purple-800">Rate: {rateText}</div>
        </div>

        {job.cooldownActive && (
          <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
            <p className="text-sm font-bold text-amber-900">
              Scheduled pause in progress after a 52-item wave. Next wave starts in about {cooldownRemainingSec}s.
            </p>
            <p className="text-xs text-amber-800 mt-1">
              This is expected behavior to protect the pipeline and avoid API overload.
            </p>
          </div>
        )}

        <div className="mb-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 flex items-center justify-between gap-4">
          <label className="inline-flex items-center gap-2 text-sm text-gray-800 select-none font-medium">
            <input
              type="checkbox"
              checked={autoSaveEnabled}
              onChange={(e) => handleToggleAutoSave(e.target.checked)}
              className="h-5 w-5 cursor-pointer appearance-auto accent-green-600 border-2 border-gray-400 rounded focus:ring-2 focus:ring-green-500"
            />
            Auto Save to Catalog after AI processing
          </label>
          <span className={`text-xs font-semibold px-2 py-1 rounded ${autoSaveEnabled ? 'bg-green-100 text-green-800' : 'bg-gray-200 text-gray-700'}`}>
            {autoSaveEnabled ? 'ON' : 'OFF'}
          </span>
        </div>

        {autoSaveEnabled && (
          <div className="mb-3 rounded-lg border border-green-300 bg-green-50 px-4 py-3">
            <p className="text-sm font-semibold text-green-900">
              {backendAutoSaveEnabled
                ? 'Auto Save to Catalog is enabled on the server queue. Manual finalize actions are disabled to avoid duplicate saves.'
                : 'Auto Save to Catalog is enabled on this page. Each successful item will be saved after 5 seconds.'}
            </p>
          </div>
        )}
        
        <div className="flex flex-wrap items-center justify-between gap-4 mt-4 pt-4 border-t border-gray-100">
          <div className="flex gap-6 text-sm font-semibold">
            <div className="text-gray-600">Total: <span className="text-gray-900">{totalCount}</span></div>
            <div className="text-green-600">Success: <span>{successCount}</span></div>
            {failCount > 0 && <div className="text-red-500">Failed: <span>{failCount}</span></div>}
          </div>

          {/* Submit All button – only useful when at least one item succeeded */}
          {successCount > 0 && !backendAutoSaveEnabled && (
            <button
              onClick={handleSubmitAll}
              disabled={submitAllStatus === 'saving'}
              className={`flex items-center gap-2 font-bold py-2 px-5 rounded-xl text-sm shadow transition disabled:opacity-50 disabled:cursor-not-allowed
                ${submitAllStatus === 'done' ? 'bg-blue-700 text-white hover:bg-blue-800'
                  : submitAllStatus === 'error' ? 'bg-red-600 text-white hover:bg-red-700'
                  : 'bg-yellow-400 hover:bg-yellow-500 text-yellow-900'}`}
            >
              {submitAllStatus === 'saving' && <div className="w-4 h-4 border-2 border-yellow-900 border-t-transparent rounded-full animate-spin" />}
              {submitAllStatus === 'done' ? `🎉 Saved ${submitAllResult?.message?.match(/\d+/)?.[0] || successCount} Items!`
               : submitAllStatus === 'error' ? '❌ Error — Check failed items'
               : `⚡ Submit All ${successCount} Completed to Catalog`}
            </button>
          )}
        </div>
        {submitAllStatus === 'done' && (
          <div className="mt-3 text-sm text-blue-700 bg-blue-50 border border-blue-300 rounded-lg p-4 flex items-start gap-3">
            <span className="text-xl flex-shrink-0">✅</span>
            <div>
              <div className="font-bold mb-1">Products Successfully Saved with Auto-Assigned GS Codes</div>
              <div className="text-xs text-blue-600 mb-2">Each product now follows one clear save flow: pre-existing code override, or auto-assigned GS code for new products.</div>
              {Array.isArray(submitAllResult?.savedItems) && submitAllResult.savedItems.length > 0 && (
                <div className="max-h-40 overflow-auto rounded border border-blue-200 bg-white p-2">
                  {submitAllResult.savedItems.map((s, idx) => (
                    <div key={`${s.rowIndex}-${idx}`} className="text-xs text-blue-900 py-0.5">
                      Row {Number(s.rowIndex) + 1}: <span className="font-mono font-bold">{s.assignedCommunetsCode || 'Auto-assigned'}</span> ({s.saveFlow || 'saved'})
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
        {submitAllResult?.errors?.length > 0 && (
          <div className="mt-3 text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2">
            ⚠️ {submitAllResult.errors.length} item(s) failed to save. Check the console for details.
          </div>
        )}
      </div>

      {/* Item Tabs with Pagination */}
      <div className="bg-white rounded-xl shadow-lg p-4 mb-6">
        <div className="flex items-center justify-between mb-4">
          <div className="text-xs font-bold text-gray-400 uppercase tracking-widest">Products</div>
          <div className="text-xs text-gray-500">Page {itemsPage} of {itemsPages} ({itemsTotal} total items)</div>
        </div>
        <div className="flex gap-2 mb-3">
          <button onClick={() => setItemsPage(Math.max(1, itemsPage - 1))} disabled={itemsPage === 1 || loadingItems} className="px-3 py-2 bg-gray-100 hover:bg-gray-200 disabled:opacity-50 text-sm rounded border border-gray-300">← Prev</button>
          <button onClick={() => setItemsPage(Math.min(itemsPages, itemsPage + 1))} disabled={itemsPage === itemsPages || loadingItems} className="px-3 py-2 bg-gray-100 hover:bg-gray-200 disabled:opacity-50 text-sm rounded border border-gray-300">Next →</button>
        </div>
        <div className="flex gap-2 overflow-x-auto pb-2 custom-scrollbar">
          {loadingItems ? (
            <div className="text-gray-400 text-sm py-2">Loading items...</div>
          ) : (
            jobItems.map((item, idx) => {
            const globalIdx = toGlobalIdx(idx);
            const isExcluded = excludedItemsMap.hasOwnProperty(globalIdx);
            let colorClass = 'bg-gray-100 text-gray-500 hover:bg-gray-200 border-gray-200'; // pending
            if (item.status === 'processing') colorClass = 'bg-yellow-100 text-yellow-800 border-yellow-300 animate-pulse';
            if (item.status === 'success') colorClass = 'bg-green-100 text-green-800 border-green-300';
            if (item.status === 'failed') colorClass = 'bg-red-100 text-red-800 border-red-300';
            if (item.status === 'saved_to_catalog') colorClass = 'bg-blue-100 text-blue-800 border-blue-300';
            
            if (isExcluded) {
              colorClass = 'bg-gray-100 text-gray-400 border-gray-200 line-through opacity-50';
            }

            const isSelected = selectedIdx === idx;
            const selectedStyle = isSelected ? 'ring-2 ring-offset-2 ring-blue-500 shadow-md' : '';

            return (
              <div key={idx} className="relative group flex-shrink-0 mr-1 mt-1">
                <button 
                  onClick={() => setSelectedIdx(idx)}
                  className={`min-w-[40px] h-10 px-3 rounded-lg border font-bold text-sm transition-all focus:outline-none flex items-center justify-center ${colorClass} ${selectedStyle}`}
                  title={item.original?.product_name}
                >
                  {idx + 1}
                </button>
                {isExcluded ? (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRestoreItem(idx);
                    }}
                    className={`absolute -top-1.5 -right-1.5 w-4.5 h-4.5 bg-green-500 hover:bg-green-600 text-white rounded-full flex items-center justify-center shadow-sm transition-all hover:scale-110 ${isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                    title="Restore this item"
                  >
                    <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="3.5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                    </svg>
                  </button>
                ) : (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleExcludeItem(idx);
                    }}
                    className={`absolute -top-1.5 -right-1.5 w-4.5 h-4.5 bg-red-500 hover:bg-red-600 text-white rounded-full flex items-center justify-center shadow-sm transition-all hover:scale-110 ${isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                    title="Exclude this item"
                  >
                    <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="3.5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
            );
          })
          )}
        </div>
      </div>

      {/* Review Details Area */}
      <div className="bg-white rounded-xl shadow-lg p-6 min-h-[400px]">
         <div className="flex items-center justify-between border-b pb-4 mb-6">
            <div>
               <h2 className="text-xl font-bold text-navy">Item #{toGlobalIdx(selectedIdx) + 1}: {original.product_name || original.productName || 'Unknown'}</h2>
               <p className="text-sm text-gray-500 mt-1">SKU: {original.ean || original.oldGs || original.legacyLookupOldGs || 'N/A'} • Brand: {original.brand || original.brandManufacturer || 'N/A'}</p>
            </div>
            <div className="flex items-center gap-3">
               {currentItem?.overrideApplied && (
                 <div className="px-3 py-1 bg-indigo-100 rounded text-xs font-bold text-indigo-700 uppercase">
                   Override Applied
                 </div>
               )}
               <div className="px-3 py-1 bg-gray-100 rounded text-sm font-bold text-gray-600 uppercase">
                  Status: {currentItem?.status}
               </div>
               {currentItem?.status === 'success' && !backendAutoSaveEnabled && (
                 <button 
                   onClick={() => saveSingleItemToCatalog(selectedIdx)}
                   id={`save-btn-${selectedIdx}`}
                   className="bg-green-600 hover:bg-green-500 text-white font-bold py-1.5 px-4 rounded-lg shadow-sm transition disabled:opacity-50"
                 >
                   ✅ Save to Catalog
                 </button>
               )}
            </div>
         </div>

         {currentItem?.status === 'pending' && (
           <div className="flex flex-col items-center justify-center p-12 text-gray-400">
             <div className="text-4xl mb-4">⏳</div>
             <p className="font-bold">Waiting in queue...</p>
           </div>
         )}
         
         {currentItem?.status === 'processing' && (
           <div className="flex flex-col items-center justify-center p-12 text-blue-600">
             <div className="w-12 h-12 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin mb-4"></div>
             <p className="font-bold">AI is generating content...</p>
           </div>
         )}

         {currentItem?.status === 'failed' && (
           <div className="bg-red-50 text-red-700 p-6 rounded-lg border border-red-200">
             <h3 className="font-bold mb-2 text-lg">Processing Failed</h3>
             {currentItem?.errorCode && (
               <p className="text-xs font-semibold uppercase tracking-wide mb-2">Reason: {currentItem.errorCode}</p>
             )}
             <p className="text-sm font-semibold">{getFailureMessage(currentItem)}</p>
             <p className="text-xs mt-2 text-red-600">{getFailureHint(currentItem)}</p>
           </div>
         )}

         {currentItem?.status === 'success' && (
           <div className="space-y-6 form-fade-in">
              <div className="flex items-center gap-3 mb-6 bg-green-50 text-green-800 p-4 rounded-lg border border-green-200">
                <span className="text-2xl">⚡</span>
                <div>
                  <h2 className="text-sm font-bold">Review Final Product Listing</h2>
                  <p className="text-xs opacity-80">This is exactly how the data will be saved to the main product catalog. All fields are editable.</p>
                </div>
              </div>

              <div className="bg-white rounded-xl border border-gray-200 overflow-hidden mb-8">
                <div className="bg-gray-50 px-4 py-3 border-b border-gray-200 flex justify-between items-center flex-wrap gap-3">
                  <h3 className="font-bold text-navy">Vendor Catalog Preview</h3>
                  {(() => {
                    const allImgs = [original.image_url, original.image_url_2, original.image_url_3, original.image_url_4]
                      .map(url => String(url || '').trim())
                      .filter(Boolean);
                    
                    if (allImgs.length === 0) return null;

                    const getFullUrl = (url) => {
                      if (/^https?:\/\//i.test(url)) return url;
                      if (url.startsWith('/')) {
                        const backendOrigin = window.location.origin.includes(':5174')
                          ? window.location.origin.replace(':5174', ':5274')
                          : window.location.origin;
                        return `${backendOrigin}${url}`;
                      }
                      return url;
                    };

                    return (
                      <div className="flex items-center gap-2 flex-wrap">
                        {allImgs.map((url, imgIdx) => (
                          <a 
                            key={imgIdx} 
                            href={getFullUrl(url)} 
                            target="_blank" 
                            rel="noreferrer" 
                            className="text-xs text-blue-600 font-bold hover:underline flex items-center gap-1 bg-white border border-blue-200 rounded-lg px-2.5 py-1.5 shadow-sm transition hover:bg-blue-50"
                          >
                            🖼️ View Image {imgIdx + 1}
                          </a>
                        ))}
                      </div>
                    );
                  })()}
                </div>
                <div className="divide-y divide-gray-100">
                  {(() => {
                    // Safe access to editable state or fallback to defaults
                    const globalIdx = toGlobalIdx(selectedIdx);
                    const eSt = window.__bulkEdits?.[jobId]?.[globalIdx] || {};
                    const updateEdit = (key, val) => {
                      if (!window.__bulkEdits) window.__bulkEdits = {};
                      if (!window.__bulkEdits[jobId]) window.__bulkEdits[jobId] = {};
                      if (!window.__bulkEdits[jobId][globalIdx]) window.__bulkEdits[jobId][globalIdx] = {};
                      window.__bulkEdits[jobId][globalIdx][key] = val;
                      try {
                        localStorage.setItem(bulkTrackEditsKey(jobId), JSON.stringify(window.__bulkEdits[jobId] || {}));
                      } catch (_) {
                        // Ignore localStorage failures.
                      }
                      // Force re-render hack for this specific item view (React state is local to component usually, but we need per-item)
                      setJob({...job}); 
                    };

                    const getVal = (key, fallback) => eSt[key] !== undefined ? eSt[key] : fallback;

                    // Fallback AI description combo
                    let defaultCombined = uiData.overview ? `${uiData.overview}\n\n` : '';
                    if (uiData.features?.length > 0) defaultCombined += "KEY FEATURES:\n" + uiData.features.map(f => `• ${f}`).join('\n') + "\n\n";
                    if (uiData.detailed_description) defaultCombined += `DETAILED DESCRIPTION:\n${uiData.detailed_description}\n\n`;
                    if (uiData.specs?.length > 0) defaultCombined += "TECHNICAL SPECIFICATIONS:\n" + uiData.specs.map(s => `${s.key}: ${s.value}`).join('\n');

                    const combinedValue = getVal('combined_description', defaultCombined);

                    const fields = [
                      { label: '1. Added by', value: job?.vendorId, readonly: true },
                      { label: '2. Product Name', value: getVal('product_name', original.keepOriginalName ? (original.product_name || '') : (uiData.seo_title || original.product_name || '')), 
                        onChange: (v) => updateEdit('product_name', v) },
                      { label: '3. Product Code', value: getVal('ean', original.ean),
                        onChange: (v) => updateEdit('ean', v) },
                      { label: '4. Unit', value: getVal('unit', original.unit || 'Piece'),
                        onChange: (v) => updateEdit('unit', v) },
                      { label: '5. Stock Quantity', value: getVal('stockQty', original.stockQty),
                        onChange: (v) => updateEdit('stockQty', v) },
                      { label: '6. Category', value: getVal('category', original.category),
                        onChange: (v) => updateEdit('category', v) },
                      { label: '7. Sub Category', value: getVal('subcategory', original.subcategory),
                        onChange: (v) => updateEdit('subcategory', v) },
                      { label: '8. Wholesale Price', value: getVal('price_wholesale', original.price_wholesale),
                        onChange: (v) => updateEdit('price_wholesale', v), prefix: '₹' },
                      { label: '9. Wholesale Quantity', value: getVal('wholesale_qty', original.wholesale_qty),
                        onChange: (v) => updateEdit('wholesale_qty', v) },
                      { label: '10. Retail Price', value: getVal('price_retail', original.price_retail),
                        onChange: (v) => updateEdit('price_retail', v), prefix: '₹' },
                      { label: '11. Vendor Details', value: vendorInfo.name, readonly: true },
                      { label: '12. Vendor Contact', value: vendorInfo.contact, readonly: true },
                      { label: '13. Partner Price', value: getVal('costPrice', original.costPrice),
                        onChange: (v) => updateEdit('costPrice', v), prefix: '₹' },
                      { label: '14. Brand/Manufacture', value: getVal('brand', original.brand),
                        onChange: (v) => updateEdit('brand', v) },
                    ];

                    return (
                      <>
                        {fields.map((item, idx) => (
                          <div key={idx} className="flex px-4 py-3 hover:bg-slate-50 items-center">
                            <div className="w-1/3 text-sm font-semibold text-gray-500">{item.label}</div>
                            <div className="w-2/3 flex items-center gap-2">
                              {item.prefix && <span className="text-gray-500 font-bold">{item.prefix}</span>}
                              {item.readonly ? (
                                <div className="text-sm text-gray-900 font-medium">{item.value || <span className="text-gray-300 italic">Empty</span>}</div>
                              ) : (
                                <input
                                  type="text"
                                  className="w-full text-sm font-medium border border-gray-300 rounded px-2 py-1.5 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
                                  value={item.value || ''}
                                  onChange={(e) => item.onChange(e.target.value)}
                                  placeholder="Empty"
                                />
                              )}
                            </div>
                          </div>
                        ))}
                        
                        {/* 15. Combined Description */}
                        <div className="p-4 bg-slate-50 border-t border-gray-200">
                          <h3 className="text-sm font-bold text-gray-500 mb-3 flex items-center justify-between">
                            <span>15. Combined Description (AI Generated)</span>
                            <button 
                              onClick={() => updateEdit('combined_description', defaultCombined)}
                              className="text-xs bg-blue-100 text-blue-700 px-3 py-1 rounded hover:bg-blue-200 transition font-medium"
                            >
                              Reset to AI Output
                            </button>
                          </h3>
                          <textarea
                            className="w-full bg-white border border-gray-300 rounded-lg p-4 text-sm text-gray-700 font-mono focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
                            rows={10}
                            value={combinedValue}
                            onChange={(e) => updateEdit('combined_description', e.target.value)}
                            placeholder="Combined description content..."
                          />
                        </div>
                      </>
                    );
                  })()}
                </div>
              </div>

           </div>
         )}

         {currentItem?.status === 'saved_to_catalog' && (
           <div className="space-y-4">
             <div className="bg-blue-50 border border-blue-200 rounded-lg p-5">
               <h3 className="text-lg font-bold text-blue-900 mb-2">Saved To Catalog</h3>
               <p className="text-sm text-blue-800 mb-4">This item has already been finalized and pushed to the main product database.</p>
               <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                 <div className="bg-white border border-blue-200 rounded p-3">
                   <div className="text-xs text-blue-700 font-semibold uppercase mb-1">Assigned/Used Communets Code</div>
                   <div className="font-mono text-blue-900 font-bold">{currentItem?.assignedCommunetsCode || 'Not returned by backend'}</div>
                 </div>
                 <div className="bg-white border border-blue-200 rounded p-3">
                   <div className="text-xs text-blue-700 font-semibold uppercase mb-1">Save Flow</div>
                   <div className="text-blue-900 font-semibold">{currentItem?.saveFlow || 'saved'}</div>
                 </div>
               </div>
             </div>
           </div>
         )}
      </div>

    </div>
  );
}
