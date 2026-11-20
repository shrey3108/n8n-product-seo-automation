import React, { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { parseXlsx, parsePdf, startBulkJob } from '../services/bulkApi';

const BULK_IMPORT_DRAFT_KEY = 'ai-bulk-import-draft-v1';
const BULK_IMPORT_DRAFT_MAX_AGE_MS = 15 * 60 * 1000;

const ALL_FIELDS = [
  { key: 'product_name', label: 'Product Name', required: true },
  { key: 'communetsCode', label: 'Communets Code (GS)', required: false },
  { key: 'ean', label: 'SKU / EAN', required: false },
  { key: 'brand', label: 'Brand / Manufacturer', required: false },
  { key: 'category', label: 'Category', required: false },
  { key: 'subcategory', label: 'Subcategory', required: false },
  { key: 'unit', label: 'Unit', required: false },
  { key: 'stockQty', label: 'Stock Quantity', required: false },
  { key: 'wholesale_qty', label: 'Min. Wholesale Qty', required: false },
  { key: 'price_wholesale', label: 'Wholesale Price (₹)', required: false },
  { key: 'price_retail', label: 'Retail Price (₹)', required: false },
  { key: 'costPrice', label: 'Partner Price (₹)', required: false },
  { key: 'image_url', label: 'Image URL 1', required: false },
];

const SparkleIcon = ({ active, className = "w-3.5 h-3.5" }) => (
  <svg 
    xmlns="http://www.w3.org/2000/svg" 
    viewBox="0 0 24 24" 
    fill={active ? "currentColor" : "none"} 
    stroke="currentColor" 
    strokeWidth="2.2" 
    strokeLinecap="round" 
    strokeLinejoin="round" 
    className={className}
  >
    <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
  </svg>
);

export default function BulkImportPage({ userRole: userRoleProp = 'seller' }) {
  const navigate = useNavigate();
  const [vendorInfo, setVendorInfo] = useState(null);
  const [phase, setPhase] = useState('upload'); // upload | analysing | alert | review | submitting
  const [parseResult, setParseResult] = useState(null);
  const [products, setProducts] = useState([]);
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [autoSaveToCatalog, setAutoSaveToCatalog] = useState(false);
  const fileRef = useRef();

  // Code validation state
  const [codeStatuses, setCodeStatuses] = useState([]); 
  const [codeDbMatches, setCodeDbMatches] = useState({});
  const [codeCheckDone, setCodeCheckDone] = useState(true);
  const [role, setRole] = useState(String(userRoleProp || 'seller').toLowerCase());
  const [actorId, setActorId] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sellerId = params.get('sellerId');
    const roleParam = (params.get('role') || '').toLowerCase();
    const resolvedRole = (roleParam === 'admin' || roleParam === 'superadmin' || roleParam === 'seller')
      ? roleParam
      : (sellerId ? 'seller' : String(userRoleProp || 'seller').toLowerCase());
    const resolvedActorId = String(
      params.get('actorId') ||
      params.get('adminId') ||
      params.get('userId') ||
      sellerId ||
      ''
    ).trim();

    setRole(resolvedRole);
    setActorId(resolvedActorId);

    if (sellerId) {
      setVendorInfo({ added_by: sellerId, vendor_email: params.get('email') || '' });
    } else if (resolvedRole === 'admin' || resolvedRole === 'superadmin') {
      setVendorInfo({ added_by: '', vendor_email: params.get('email') || '' });
    }
  }, [userRoleProp]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(BULK_IMPORT_DRAFT_KEY);
      if (!raw) return;
      const draft = JSON.parse(raw);
      if (!draft || typeof draft !== 'object') return;

      const updatedAt = Number(draft.updatedAt || 0);
      const isStale = Number.isFinite(updatedAt) && updatedAt > 0 && (Date.now() - updatedAt) > BULK_IMPORT_DRAFT_MAX_AGE_MS;

      // Never restore the transient parsing state after a reload.
      if (draft.phase === 'analysing' || isStale) {
        try { localStorage.removeItem(BULK_IMPORT_DRAFT_KEY); } catch (_) {}
        return;
      }

      if (draft.phase) setPhase(draft.phase);
      if (draft.parseResult) setParseResult(draft.parseResult);
      if (Array.isArray(draft.products)) setProducts(draft.products);
      if (typeof draft.autoSaveToCatalog === 'boolean') setAutoSaveToCatalog(draft.autoSaveToCatalog);
      if (typeof draft.error === 'string') setError(draft.error);
    } catch (_) {
      // Ignore malformed draft payload.
    }
  }, []);

  useEffect(() => {
    const hasDraft = phase !== 'upload' || products.length > 0 || Boolean(parseResult);

    if (!hasDraft) {
      try { localStorage.removeItem(BULK_IMPORT_DRAFT_KEY); } catch (_) {}
      return;
    }

    try {
      localStorage.setItem(BULK_IMPORT_DRAFT_KEY, JSON.stringify({
        phase,
        parseResult,
        products,
        autoSaveToCatalog,
        error,
        updatedAt: Date.now(),
      }));
    } catch (_) {
      // Ignore localStorage failures.
    }
  }, [phase, parseResult, products, autoSaveToCatalog, error]);

  useEffect(() => {
    const shouldWarn = phase === 'submitting';
    const onBeforeUnload = (e) => {
      if (!shouldWarn) return;
      e.preventDefault();
      e.returnValue = '';
    };

    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [phase]);

  // ── Recompute Communets Code statuses whenever products change ────────────
  useEffect(() => {
    const run = async () => {
      if (phase !== 'review' || products.length === 0) {
        setCodeStatuses([]);
        setCodeDbMatches({});
        setCodeCheckDone(true);
        return;
      }

      setCodeCheckDone(false);
      const codeCount = {};
      products.forEach((p) => {
        const c = (p.communetsCode || '').toString().trim().toUpperCase();
        if (!c) return;
        codeCount[c] = (codeCount[c] || 0) + 1;
      });

      const uniqCodes = Object.keys(codeCount);
      const dbMap = {};

      // Process codes in chunks of 200 to reduce network calls
      const CHUNK_SIZE = 200;
      const chunks = [];
      for (let i = 0; i < uniqCodes.length; i += CHUNK_SIZE) {
        chunks.push(uniqCodes.slice(i, i + CHUNK_SIZE));
      }

      // Process all chunks (can run in parallel for speed)
      await Promise.all(chunks.map(async (chunk) => {
        try {
          const response = await fetch('/api/check-communets-codes/batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              codes: chunk,
              vendorId: vendorInfo?.added_by || '',
              actorRole: role || 'seller',
            }),
          });
          const chunkResult = await response.json();
          
          // Merge chunk results into dbMap
          if (typeof chunkResult === 'object' && chunkResult !== null) {
            Object.assign(dbMap, chunkResult);
          }
        } catch (err) {
          console.error('Batch code check error:', err);
          // Mark all codes in this chunk as not found on error
          chunk.forEach(code => {
            if (!dbMap[code]) {
              dbMap[code] = { exists: false };
            }
          });
        }
      }));

      const statuses = products.map((p) => {
        const c = (p.communetsCode || '').toString().trim().toUpperCase();
        if (!c) return 'code-empty-auto-assigned';
        if ((codeCount[c] || 0) > 1) return 'duplicate-file';

        const lookup = dbMap[c];
        if (lookup?.exists && lookup?.source === 'main') {
          return lookup?.isMine ? 'preexist-override' : 'preexist-blocked';
        }

        return 'code-not-found-auto-assigned';
      });

      setCodeDbMatches(dbMap);
      setCodeStatuses(statuses);
      setCodeCheckDone(true);
    };

    run();
  }, [phase, products, vendorInfo?.added_by, role]);

  // ── File Handler ───────────────────────────────────────────────────────────
  const handleFile = async (file) => {
    if (!file) return;
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext !== 'xlsx' && ext !== 'pdf') {
      setError('Only .xlsx and .pdf files are allowed.');
      return;
    }
    setError('');
    setPhase('analysing');
    try {
      const result = ext === 'xlsx' ? await parseXlsx(file) : await parsePdf(file);
      setParseResult(result);
      setPhase('alert');
    } catch (err) {
      const message = err?.message || 'Failed to parse file.';
      setError(message);
      setPhase('upload');
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    handleFile(e.dataTransfer.files[0]);
  };

  const handleFileInput = (e) => {
    handleFile(e.target.files[0]);
    e.target.value = '';
  };

  // ── Continue → map rows + batch EAN check ─────────────────────────────────
  const handleContinue = async () => {
    if (!parseResult) return;
    const { rows, detectedMapping, type } = parseResult;

    const mapped = rows.map(row => {
      const prod = {
        product_name: '', ean: '', brand: '', category: '', subcategory: '',
        communetsCode: '',
        unit: 'Piece', stockQty: '', wholesale_qty: '', price_wholesale: '', price_retail: '', costPrice: '',
        image_url: '', image_url_2: '', image_url_3: '', image_url_4: '',
        processImage: true,
        keepOriginalName: false,
      };
      if (type === 'xlsx') {
        for (const [field, colName] of Object.entries(detectedMapping)) {
          prod[field] = row[colName] || '';
        }
      } else {
        prod.product_name = row.product_name || '';
        prod.ean = row.ean || '';
        prod.price_wholesale = row.price_wholesale || '';
        prod.price_retail = row.price_retail || '';
        prod.image_url = row.image_url || '';
      }
      prod.communetsCode = String(prod.communetsCode || '').trim().toUpperCase();
      prod.processImage = true;
      prod.keepOriginalName = false;
      return prod;
    });

    setPhase('review');
    setProducts(mapped);
  };

  const handleCancel = () => {
    setParseResult(null);
    setProducts([]);
    setCodeCheckDone(false);
    setPhase('upload');
    try { localStorage.removeItem(BULK_IMPORT_DRAFT_KEY); } catch (_) {}
  };

  const updateProduct = (index, field, value) => {
    setProducts(prev => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      return updated;
    });
  };

  const removeProduct = (index) => {
    setProducts(prev => prev.filter((_, i) => i !== index));
    
  };

  const handleSelectPrimaryImage = (prodIdx, clickedUrl) => {
    setProducts(prev => {
      const updated = [...prev];
      const prod = { ...updated[prodIdx] };
      const imgKeys = ['image_url', 'image_url_2', 'image_url_3', 'image_url_4'];
      const flagKeys = ['processImage', 'processImage2', 'processImage3', 'processImage4'];
      const targetIdx = imgKeys.findIndex(key => prod[key] === clickedUrl);
      if (targetIdx !== -1 && targetIdx !== 0) {
        // Swap URLs
        const tempUrl = prod.image_url;
        prod.image_url = prod[imgKeys[targetIdx]];
        prod[imgKeys[targetIdx]] = tempUrl;
        
        // Swap process flags
        const flagKey1 = flagKeys[0];
        const flagKey2 = flagKeys[targetIdx];
        
        const val1 = prod.hasOwnProperty(flagKey1) ? prod[flagKey1] : true; // Default primary is ON
        const val2 = prod.hasOwnProperty(flagKey2) ? prod[flagKey2] : false; // Default secondary is OFF
        
        prod[flagKey1] = val2;
        prod[flagKey2] = val1;
        
        updated[prodIdx] = prod;
      }
      return updated;
    });
  };

  const handleToggleImageEnhancement = (prodIdx, imgIdx) => {
    const flagKeys = ['processImage', 'processImage2', 'processImage3', 'processImage4'];
    const flagKey = flagKeys[imgIdx];
    setProducts(prev => {
      const updated = [...prev];
      const prod = { ...updated[prodIdx] };
      let currentVal = true;
      if (prod.hasOwnProperty(flagKey)) {
        currentVal = prod[flagKey];
      } else {
        currentVal = (imgIdx === 0);
      }
      prod[flagKey] = !currentVal;
      updated[prodIdx] = prod;
      return updated;
    });
  };

  const handleCodeBlur = async () => {};

  const handleSubmitAll = async () => {
    try {
      if (role === 'seller' && !vendorInfo?.added_by) return alert('Seller ID missing!');
      setPhase('submitting');
      setError('');
      const data = await startBulkJob(
        products,
        vendorInfo?.added_by || '',
        vendorInfo?.vendor_email || '',
        role,
        actorId || vendorInfo?.added_by || '',
        autoSaveToCatalog
      );
      try { localStorage.removeItem(BULK_IMPORT_DRAFT_KEY); } catch (_) {}
      const autoSaveQuery = autoSaveToCatalog ? '?autosave=1' : '';
      navigate(data.jobId ? `/track/${data.jobId}${autoSaveQuery}` : `/track/test-job-123`);
    } catch (err) {
      console.error('Failed to start bulk job:', err);
      const status = Number(err?.response?.status || 0);
      const existingJobId = String(err?.response?.data?.jobId || '').trim();
      const message = String(err?.response?.data?.error || err?.message || 'Failed to start bulk job').trim();

      if (status === 409 && existingJobId) {
        const autoSaveQuery = autoSaveToCatalog ? '?autosave=1' : '';
        navigate(`/track/${existingJobId}${autoSaveQuery}`);
        return;
      }

      setPhase('review');
      setError(message);
    }
  };

  // ── Guard: no vendor ───────────────────────────────────────────────────────
  if (!vendorInfo || (role === 'seller' && !vendorInfo.added_by)) {
    return (
      <div className="py-12 text-center text-red-600 bg-red-50 rounded-xl my-8 mx-auto max-w-lg border border-red-200">
        <h2 className="font-bold mb-2">Missing Seller Authorization</h2>
        <p>Please launch this AI Import tool from the Communets Admin Dashboard.</p>
        <button onClick={() => window.location.href = 'http://localhost:5173/'}
          className="mt-4 bg-red-600 text-white px-4 py-2 rounded font-bold hover:bg-red-700 transition">
          Return to Dashboard
        </button>
      </div>
    );
  }

  // ── UPLOAD ─────────────────────────────────────────────────────────────────
  if (phase === 'upload') {
    return (
      <div>
        <div className="flex items-center gap-3 mb-6">
          <span className="text-2xl">📦</span>
          <div>
            <h2 className="text-xl font-bold text-blue-900">Bulk Product Import</h2>
            <p className="text-sm text-gray-500">Upload an Excel spreadsheet or catalog PDF to register multiple products at once.</p>
          </div>
        </div>

        {error && (
          <div className="bg-red-50 text-red-700 border border-red-200 rounded-lg p-4 mb-4 flex items-center gap-3">
            <span>⚠️</span><span>{error}</span>
          </div>
        )}

        <div
          className={`border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-all mb-6 ${dragOver ? 'border-blue-500 bg-blue-50' : 'border-gray-300 bg-gray-50 hover:bg-gray-100'}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => fileRef.current?.click()}
        >
          <input ref={fileRef} type="file" accept=".xlsx,.pdf" className="hidden" onChange={handleFileInput} />
          <div className="text-5xl mb-4">{dragOver ? '📂' : '📥'}</div>
          <div className="text-lg font-bold text-gray-700 mb-1">Drop your file here</div>
          <div className="text-sm text-gray-500 mb-4">or click to browse</div>
          <div className="flex items-center justify-center gap-4">
            <span className="bg-green-100 text-green-700 px-3 py-1 rounded-full text-xs font-bold tracking-wider">📊 .XLSX</span>
            <span className="bg-red-100 text-red-700 px-3 py-1 rounded-full text-xs font-bold tracking-wider">📄 .PDF</span>
          </div>
        </div>

        <div className="flex items-center justify-center mb-5">
          <a href="/ai-api/bulk/template" download="communets_bulk_template.xlsx"
            className="inline-flex items-center gap-2 bg-green-600 hover:bg-green-700 text-white font-bold py-2 px-5 rounded-lg shadow transition text-sm"
            onClick={(e) => e.stopPropagation()}>
            ⬇️ Download Excel Template
          </a>
          <span className="ml-3 text-xs text-gray-500">Pre-filled with all required columns and an example row</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-green-50 p-4 rounded-xl border border-green-200">
            <h3 className="font-bold text-green-800 text-sm mb-1">📊 Excel (.xlsx)</h3>
            <p className="text-xs text-green-700">Columns are auto-detected. EAN/SKU is required per row. <strong>Embedded images</strong> are extracted automatically.</p>
          </div>
          <div className="bg-red-50 p-4 rounded-xl border border-red-200">
            <h3 className="font-bold text-red-800 text-sm mb-1">📄 PDF Catalog</h3>
            <p className="text-xs text-red-700">Designed for catalog PDFs. Product images are extracted and uploaded to S3 automatically.</p>
          </div>
        </div>

      </div>
    );
  }

  // ── ANALYSING ──────────────────────────────────────────────────────────────
  if (phase === 'analysing') {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <div className="w-14 h-14 border-4 border-blue-200 border-t-blue-800 rounded-full animate-spin mb-5"></div>
        <h2 className="text-lg font-bold text-blue-900 mb-1">Analysing file…</h2>
        <p className="text-sm text-gray-500">For PDFs, images are also being extracted and uploaded to S3.<br/>This may take up to a minute.</p>
      </div>
    );
  }

  // ── ALERT (file parsed — show mapping) ────────────────────────────────────
  if (phase === 'alert' && parseResult) {
    const { type, columns, count, detectedMapping, unmappedColumns, missingRequired } = parseResult;
    const renderColumnLabel = (col) => {
      if (col && typeof col === 'object') {
        return col.name || col.label || JSON.stringify(col);
      }
      return String(col ?? '');
    };
    return (
      <div>
        <h2 className="text-xl font-bold text-blue-900 mb-5">
          {type === 'xlsx' ? '📊' : '📄'} File Analysis Complete
        </h2>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
          <div className="bg-blue-50 p-4 rounded-xl text-center border border-blue-200">
            <div className="text-3xl font-black text-blue-800">{count}</div>
            <div className="text-xs text-blue-600 font-semibold mt-1">Products Detected</div>
          </div>
          <div className="bg-green-50 p-4 rounded-xl text-center border border-green-200">
            <div className="text-3xl font-black text-green-700">{Object.keys(detectedMapping).length}</div>
            <div className="text-xs text-green-600 font-semibold mt-1">Fields Matched</div>
          </div>
          <div className={`p-4 rounded-xl text-center border ${missingRequired.length > 0 ? 'bg-red-50 border-red-200' : 'bg-gray-50 border-gray-200'}`}>
            <div className={`text-3xl font-black ${missingRequired.length > 0 ? 'text-red-700' : 'text-gray-400'}`}>{missingRequired.length}</div>
            <div className={`text-xs font-semibold mt-1 ${missingRequired.length > 0 ? 'text-red-600' : 'text-gray-500'}`}>Required Missing</div>
          </div>
        </div>

        <div className="mb-5">
          <h3 className="text-sm font-bold text-gray-700 mb-2">Columns / Fields Detected:</h3>
          <div className="flex flex-wrap gap-2">
            {columns.map((col, i) => (
              <span key={i} className={`px-3 py-1 rounded-full text-xs font-semibold border ${Object.values(detectedMapping).includes(col) ? 'bg-green-100 text-green-700 border-green-300' : 'bg-gray-100 text-gray-500 border-gray-300'}`}>
                {Object.values(detectedMapping).includes(renderColumnLabel(col)) ? '✓ ' : ''}{renderColumnLabel(col)}
              </span>
            ))}
          </div>
        </div>

        <div className="mb-5 overflow-x-auto">
          <h3 className="text-sm font-bold text-gray-700 mb-2">Field Mapping:</h3>
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-gray-100 text-gray-600 text-xs uppercase">
                <th className="text-left p-2">Form Field</th>
                <th className="text-left p-2">Required?</th>
                <th className="text-left p-2">Mapped to Column</th>
              </tr>
            </thead>
            <tbody>
              {ALL_FIELDS.map(f => (
                <tr key={f.key} className={`border-b border-gray-100 ${missingRequired.includes(f.key) ? 'bg-red-50' : ''}`}>
                  <td className="p-2 font-mono text-xs font-semibold text-blue-800">{f.key}</td>
                  <td className="p-2">{f.required ? <span className="text-red-500 font-bold text-xs">Required</span> : <span className="text-gray-400 text-xs">Optional</span>}</td>
                  <td className="p-2">
                    {detectedMapping[f.key]
                      ? <span className="text-green-700 font-semibold text-xs">✓ {detectedMapping[f.key]}</span>
                      : <span className="text-gray-400 italic text-xs">— not found</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {missingRequired.length > 0 && (
          <div className="bg-yellow-50 border border-yellow-300 text-yellow-800 p-4 rounded-xl mb-4">
            <div className="font-bold mb-1 text-sm">⚠️ Missing Required Fields — You can fill them in the review table</div>
            <ul className="list-disc list-inside text-sm">{missingRequired.map(f => <li key={f}><code>{f}</code></li>)}</ul>
          </div>
        )}

        {unmappedColumns.length > 0 && (
          <div className="bg-yellow-50 border border-yellow-200 text-yellow-700 p-4 rounded-xl mb-4">
            <div className="font-bold mb-1 text-sm">Unmapped Columns (ignored):</div>
            <div className="flex flex-wrap gap-2">{unmappedColumns.map((c, i) => <span key={i} className="text-xs bg-yellow-100 px-2 py-1 rounded font-mono">{c}</span>)}</div>
          </div>
        )}

        <div className="flex justify-between pt-4 border-t border-gray-200">
          <button onClick={handleCancel} className="bg-gray-200 hover:bg-gray-300 text-gray-800 font-bold py-3 px-6 rounded-lg transition">
            ✕ Cancel
          </button>
          <button onClick={handleContinue} className="bg-blue-800 hover:bg-blue-700 text-white font-bold py-3 px-8 rounded-lg transition">
            Continue → ({count} products)
          </button>
        </div>
      </div>
    );
  }

  // ── REVIEW TABLE ───────────────────────────────────────────────────────────
  if (phase === 'review' || phase === 'submitting') {
    const withImages = products.filter(p => p.image_url).length;

    const dupFileCount    = codeStatuses.filter(s => s === 'duplicate-file').length;
    const preexistOverrideCount = codeStatuses.filter(s => s === 'preexist-override').length;
    const preexistBlockedCount  = codeStatuses.filter(s => s === 'preexist-blocked').length;
    const autoAssignCount = codeStatuses.filter(s => s === 'code-empty-auto-assigned' || s === 'code-not-found-auto-assigned').length;
    const missingName     = products.filter(p => !p.product_name).length;

    const hasBlockers = dupFileCount > 0 || missingName > 0 || preexistBlockedCount > 0;

    const getGsStatusMeta = (status) => {
      switch (status) {
        case 'code-empty-auto-assigned':
          return { label: 'Auto-generated', className: 'bg-blue-100 text-blue-700 border-blue-200' };
        case 'code-not-found-auto-assigned':
          return { label: 'Not in DB - ignored, auto-generated', className: 'bg-sky-100 text-sky-700 border-sky-200' };
        case 'preexist-override':
          return { label: 'Override', className: 'bg-amber-100 text-amber-700 border-amber-200' };
        case 'preexist-blocked':
          return { label: 'Not allowed', className: 'bg-red-100 text-red-700 border-red-200' };
        case 'duplicate-file':
          return { label: 'Duplicate in file', className: 'bg-red-100 text-red-700 border-red-200' };
        default:
          return { label: 'Checking...', className: 'bg-gray-100 text-gray-600 border-gray-200' };
      }
    };

    return (
      <div>
        {/* Header */}
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div>
            <h2 className="text-xl font-bold text-blue-900">Review Extracted Products</h2>
            <p className="text-sm text-gray-500">
              {products.length} product(s) — <span className="text-green-600 font-semibold">{withImages} with images</span>. Edit any field before submitting.
            </p>
          </div>
          <button onClick={handleCancel} className="text-sm text-gray-400 hover:text-gray-700 underline">← Start over</button>
        </div>

        {codeCheckDone && (
          <div className="flex flex-wrap gap-3 mb-4 p-3 bg-gray-50 border border-gray-200 rounded-xl text-xs font-bold">
            {autoAssignCount > 0 && <span className="bg-blue-100 text-blue-700 px-3 py-1 rounded-full">🆕 {autoAssignCount} Auto-Assign GS</span>}
            {preexistOverrideCount > 0 && <span className="bg-amber-100 text-amber-700 px-3 py-1 rounded-full">🔄 {preexistOverrideCount} Pre-exist Override</span>}
            {dupFileCount > 0    && <span className="bg-red-100 text-red-700 px-3 py-1 rounded-full">🔁 {dupFileCount} Duplicate in File</span>}
            {preexistBlockedCount > 0&& <span className="bg-red-100 text-red-700 px-3 py-1 rounded-full">⛔ {preexistBlockedCount} Pre-exist Blocked</span>}
          </div>
        )}
        {!codeCheckDone && (
          <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-xl text-xs text-blue-700 flex items-center gap-2">
            <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin"></div>
            Checking Communets Code flow against main product database…
          </div>
        )}

        {/* Already-in-catalog aside */}
        {preexistOverrideCount > 0 && (
          <div className="mb-4 p-4 bg-amber-50 border border-amber-300 rounded-xl text-sm">
            <div className="font-bold text-amber-800 mb-2">🔄 Flow 1: Pre-existing Communets Code</div>
            <p className="text-xs text-amber-700 mb-3 leading-relaxed">These rows will override existing products (same code) in your accessible catalog.</p>
            <ul className="space-y-1">
              {products.map((p, i) => {
                if (codeStatuses[i] !== 'preexist-override') return null;
                const match = codeDbMatches[(p.communetsCode || '').toString().trim().toUpperCase()];
                return (
                  <li key={i} className="flex items-center gap-2 text-xs text-amber-700">
                    <span className="font-mono text-gray-500">Row {i + 1}</span>
                    <strong>{match?.productName || p.product_name}</strong>
                    <span className="text-gray-400">({match?.communetCode})</span>
                    <a href={`/products?search=${match?.communetCode}`} target="_blank" rel="noreferrer"
                      className="text-blue-600 underline font-bold hover:text-blue-800">
                      View in Products List →
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {/* Global Duplicate aside */}
        {preexistBlockedCount > 0 && (
          <div className="mb-4 p-4 bg-red-50 border border-red-300 rounded-xl text-sm">
            <div className="font-bold text-red-800 mb-2">⛔ Pre-existing but not accessible</div>
            <p className="text-xs text-red-700 mb-3 leading-relaxed">These codes exist in main DB but belong to another seller. Remove these rows before submit.</p>
            <ul className="space-y-1">
              {products.map((p, i) => {
                if (codeStatuses[i] !== 'preexist-blocked') return null;
                const code = (p.communetsCode || '').toString().trim().toUpperCase();
                return (
                  <li key={i} className="flex items-center gap-2 text-xs text-red-700">
                    <span className="font-mono font-bold bg-white px-1">Row {i + 1}</span>
                    <span className="font-mono">Code: {code}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {/* Duplicate-in-file aside */}
        {dupFileCount > 0 && (
          <div className="mb-4 p-4 bg-red-50 border border-red-300 rounded-xl text-sm">
            <div className="font-bold text-red-800 mb-2">🔁 Duplicate Codes within this file — fix before submitting:</div>
            {(() => {
              const dupEans = {};
              products.forEach((p, i) => {
                const e = (p.ean || '').toString().trim();
                if (e) { if (!dupEans[e]) dupEans[e] = []; dupEans[e].push(i + 1); }
              });
              return Object.entries(dupEans).filter(([, rows]) => rows.length > 1).map(([ean, rows]) => (
                <div key={ean} className="text-xs text-red-700 mb-1">EAN <strong>{ean}</strong> appears in rows: {rows.join(', ')} — please fix or remove one</div>
              ));
            })()}
          </div>
        )}

        {autoAssignCount > 0 && (
          <div className="mb-4 p-4 bg-blue-50 border border-blue-300 rounded-xl text-sm">
            <div className="font-bold text-blue-800 mb-2">🆕 Flow 2: Code empty/not found in DB</div>
            <p className="text-xs text-blue-700 leading-relaxed">Rows with empty code, or code not present in main DB, will be auto-assigned a new GS code during save. If a non-existing GS is entered manually, it is ignored and treated exactly like empty.</p>
          </div>
        )}

        {/* Review table */}
        <div className="w-full overflow-x-auto rounded-xl border border-gray-200 mb-4" style={{ maxHeight: '60vh', overflowY: 'auto' }}>
          <table className="w-full text-sm border-collapse" style={{ minWidth: '1100px' }}>
            <thead className="bg-gray-100 text-gray-600 text-xs uppercase" style={{ position: 'sticky', top: 0, zIndex: 10 }}>
              <tr>
                <th className="p-2 text-center w-8">#</th>
                <th className="p-2 text-center w-14">Image</th>
                <th className="p-2 text-left w-48">Product Name <span className="text-red-500">*</span></th>
                <th className="p-2 text-left w-36">Communets Code</th>
                <th className="p-2 text-left w-40">Status</th>
                <th className="p-2 text-left w-32">Product Code (Optional)</th>
                <th className="p-2 text-left w-24">Brand</th>
                <th className="p-2 text-left w-24">Category</th>
                <th className="p-2 text-center w-16">Unit</th>
                <th className="p-2 text-right w-20">W.Price</th>
                <th className="p-2 text-right w-20">R.Price</th>
                <th className="p-2 text-center w-10">Del</th>
              </tr>
            </thead>
            <tbody>
              {products.map((prod, idx) => {
                const codeSt = codeStatuses[idx] || 'ok';
                const statusMeta = getGsStatusMeta(codeSt);
                const rowBg =
                  (codeSt === 'duplicate-file') ? 'bg-red-50' :
                  (codeSt === 'preexist-blocked') ? 'bg-red-50' :
                  (codeSt === 'preexist-override') ? 'bg-amber-50' :
                  (codeSt === 'code-not-found-auto-assigned') ? 'bg-sky-50' :
                  '';

                return (
                  <tr key={idx} className={`border-b border-gray-100 hover:brightness-95 transition-colors ${rowBg}`}>
                    <td className="p-2 text-center text-gray-400 text-xs font-mono">{idx + 1}</td>
                    <td className="p-1 text-center">
                      {(() => {
                        const allImgs = [prod.image_url, prod.image_url_2, prod.image_url_3, prod.image_url_4]
                          .map(url => String(url || '').trim())
                          .filter(Boolean);

                        return (
                          <div className="relative w-11 h-11 mx-auto group">
                            {/* Stacked Photo Borders for Multiple Images */}
                            {allImgs.length > 2 && (
                              <div className="absolute inset-0 bg-white border border-gray-200 rounded-lg shadow-sm transform -translate-x-1 translate-y-0.5 -rotate-6 -z-20"></div>
                            )}
                            {allImgs.length > 1 && (
                              <div className="absolute inset-0 bg-white border border-gray-200 rounded-lg shadow-sm transform translate-x-0.5 translate-y-0.5 rotate-3 -z-10"></div>
                            )}

                            {/* Main Image / Placeholder */}
                            {allImgs.length > 0 ? (
                              <img 
                                src={allImgs[0]} 
                                alt="product" 
                                className="w-11 h-11 object-cover rounded-lg border border-gray-200 cursor-pointer shadow-sm transition-transform hover:scale-105" 
                                onClick={() => window.open(allImgs[0], '_blank')} 
                              />
                            ) : (
                              <div className="w-11 h-11 bg-gray-100 rounded-lg flex items-center justify-center text-gray-300 text-lg">📷</div>
                            )}

                            {/* Multiple Images Count Badge */}
                            {allImgs.length > 1 && (
                              <div className="absolute bottom-0.5 left-0.5 bg-black/75 text-white text-[9px] px-1 rounded font-bold leading-none py-0.5 pointer-events-none select-none z-10">
                                {allImgs.length}
                              </div>
                            )}

                            {/* AI Enhance Toggle Button */}
                            {allImgs.length > 0 && (
                              <button
                                type="button"
                                onClick={() => updateProduct(idx, 'processImage', !prod.hasOwnProperty('processImage') ? false : !prod.processImage)}
                                className={`absolute -top-1.5 -right-1.5 w-5 h-5 flex items-center justify-center rounded-full border shadow-md transition-all duration-200 hover:scale-110 z-20 ${
                                  prod.processImage !== false
                                    ? 'bg-indigo-600 text-white border-indigo-700'
                                    : 'bg-white text-gray-400 border-gray-300 hover:bg-gray-50'
                                }`}
                                title={prod.processImage !== false ? "AI Image Enhancement: ON (Click to turn off)" : "AI Image Enhancement: OFF (Click to turn on)"}
                              >
                                <SparkleIcon active={prod.processImage !== false} className="w-3 h-3" />
                              </button>
                            )}

                            {/* Slide-out Ribbon Gallery on Hover for Multiple Images */}
                            {allImgs.length > 1 && (
                              <div className="absolute left-full top-0 ml-2 h-11 bg-white border border-gray-200 rounded-xl shadow-xl flex items-center gap-2.5 p-1 z-50 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-all duration-200 scale-90 group-hover:scale-100 origin-left border-l-4 border-l-blue-600 min-w-max">
                                {allImgs.map((url, imgIdx) => {
                                  const isPrimary = imgIdx === 0;
                                  const flagKeys = ['processImage', 'processImage2', 'processImage3', 'processImage4'];
                                  const flagKey = flagKeys[imgIdx];
                                  const isEnhanced = prod.hasOwnProperty(flagKey)
                                    ? prod[flagKey] !== false
                                    : (imgIdx === 0);

                                  return (
                                    <div key={imgIdx} className="relative w-9 h-9 flex-shrink-0">
                                      <img 
                                        src={url} 
                                        alt={`img-${imgIdx}`} 
                                        className={`w-9 h-9 object-cover rounded-lg transition cursor-pointer shadow-sm ${
                                          isPrimary 
                                            ? 'border-2 border-blue-600 scale-105' 
                                            : 'border border-gray-200 hover:border-blue-400'
                                        }`}
                                        onClick={() => {
                                          if (!isPrimary) {
                                            handleSelectPrimaryImage(idx, url);
                                          }
                                        }}
                                        title={isPrimary ? "Primary AI Image (Enhanced by AI)" : "Click to select as AI Primary Image"}
                                      />
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleToggleImageEnhancement(idx, imgIdx);
                                        }}
                                        className={`absolute -top-1 -right-1 w-4.5 h-4.5 flex items-center justify-center rounded-full border shadow-md transition-all duration-200 hover:scale-110 z-20 ${
                                          isEnhanced
                                            ? 'bg-indigo-600 text-white border-indigo-700'
                                            : 'bg-white text-gray-400 border-gray-300 hover:bg-gray-50'
                                        }`}
                                        title={isEnhanced ? "AI Image Enhancement: ON (Click to turn off)" : "AI Image Enhancement: OFF (Click to turn on)"}
                                      >
                                        <SparkleIcon active={isEnhanced} className="w-2.5 h-2.5" />
                                      </button>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </td>
                    {/* Product Name */}
                    <td className="p-1">
                      <div className="relative flex items-center w-full">
                        <input type="text" value={prod.product_name}
                          onChange={e => updateProduct(idx, 'product_name', e.target.value)}
                          className={`w-full border rounded pl-2 pr-7 py-1 text-xs focus:ring-1 focus:ring-blue-400 focus:outline-none ${!prod.product_name ? 'border-red-300 bg-red-50' : 'border-gray-300'}`}
                          placeholder="Required…" />
                        <button
                          type="button"
                          onClick={() => updateProduct(idx, 'keepOriginalName', !prod.keepOriginalName)}
                          className={`absolute right-1.5 p-1 rounded-md transition-all duration-200 hover:bg-gray-100 ${
                            !prod.keepOriginalName
                              ? 'text-indigo-600 scale-110'
                              : 'text-gray-300 hover:text-gray-400 scale-100'
                          }`}
                          title={prod.keepOriginalName ? "AI Title Generator: OFF (Click to turn on)" : "AI Title Generator: ON (Click to turn off)"}
                        >
                          <SparkleIcon active={!prod.keepOriginalName} className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                    {/* Product Code */}
                    <td className="p-1">
                      <input type="text" value={prod.communetsCode || ''}
                        readOnly
                        className="w-full border border-gray-200 rounded px-2 py-1 text-xs font-mono bg-gray-100 text-gray-700 cursor-not-allowed"
                        placeholder="Auto-assigned at save if empty" />
                    </td>
                    <td className="p-1">
                      <span className={`inline-flex items-center rounded-full border px-2 py-1 text-[10px] font-bold leading-tight ${statusMeta.className}`}>
                        {statusMeta.label}
                      </span>
                    </td>
                    <td className="p-1">
                      <input type="text" value={prod.ean || ''}
                        onChange={e => updateProduct(idx, 'ean', e.target.value)}
                        className="w-full border border-gray-300 rounded px-2 py-1 text-xs focus:ring-1 focus:ring-blue-400 focus:outline-none"
                        placeholder="Optional…" />
                    </td>
                    {/* Brand */}
                    <td className="p-1"><input type="text" value={prod.brand} onChange={e => updateProduct(idx, 'brand', e.target.value)} className="w-full border border-gray-300 rounded px-2 py-1 text-xs focus:ring-1 focus:ring-blue-400 focus:outline-none" /></td>
                    <td className="p-1"><input type="text" value={prod.category} onChange={e => updateProduct(idx, 'category', e.target.value)} className="w-full border border-gray-300 rounded px-2 py-1 text-xs focus:ring-1 focus:ring-blue-400 focus:outline-none" /></td>
                    <td className="p-1">
                      <select value={prod.unit || 'Piece'} onChange={e => updateProduct(idx, 'unit', e.target.value)} className="w-full border border-gray-300 rounded px-1 py-1 text-xs">
                        <option>Piece</option><option>Box</option><option>Set</option><option>Kg</option><option>Other</option>
                      </select>
                    </td>
                    <td className="p-1"><input type="text" value={prod.price_wholesale} onChange={e => updateProduct(idx, 'price_wholesale', e.target.value)} className="w-full border border-gray-300 rounded px-2 py-1 text-xs text-right focus:ring-1 focus:ring-blue-400 focus:outline-none" placeholder="0.00" /></td>
                    <td className="p-1"><input type="text" value={prod.price_retail} onChange={e => updateProduct(idx, 'price_retail', e.target.value)} className="w-full border border-gray-300 rounded px-2 py-1 text-xs text-right focus:ring-1 focus:ring-blue-400 focus:outline-none" placeholder="0.00" /></td>
                    <td className="p-1 text-center">
                      <button onClick={() => removeProduct(idx)} className="text-red-400 hover:text-red-600 hover:bg-red-50 rounded px-2 py-1 text-xs font-bold" title="Remove">✕</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Bottom warnings + submit */}
        {hasBlockers && (
          <div className="bg-red-50 border border-red-200 text-red-700 p-3 rounded-lg mb-4 text-sm">
            ⛔ Cannot submit yet —
            {missingName > 0 && ` ${missingName} row(s) missing Product Name.`}
            {dupFileCount > 0 && ` ${dupFileCount} duplicate Codes(s) found in file.`}
            {' '}Fix or remove those rows first.
          </div>
        )}

        <div className="flex items-center justify-between pt-4 border-t border-gray-200">
          <div className="flex flex-col gap-2">
            <span className="text-sm text-gray-500">{products.length} products · {withImages} with images</span>
            <label className="inline-flex items-center gap-2 text-sm text-gray-700 select-none">
              <input
                type="checkbox"
                checked={autoSaveToCatalog}
                onChange={(e) => setAutoSaveToCatalog(e.target.checked)}
                className="h-5 w-5 cursor-pointer appearance-auto accent-green-600 border-2 border-gray-400 rounded focus:ring-2 focus:ring-green-500"
              />
              Auto Save to Catalog after AI processing
            </label>
          </div>
          <button
            className="bg-green-600 hover:bg-green-500 text-white font-bold px-10 py-3 rounded-xl shadow-lg transition disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
            onClick={handleSubmitAll}
            disabled={phase === 'submitting' || hasBlockers}
          >
            {phase === 'submitting' ? (
              <><div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>Starting Job...</>
            ) : (
              `✅ Submit ${products.length} Products to AI`
            )}
          </button>
        </div>
      </div>
    );
  }

  return null;
}
