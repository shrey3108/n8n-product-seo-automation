import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { API_BASE_URL, previewReservedMappings, previewSingleReservedMapping, uploadImages } from '../services/api';
import { assignUploadedProducts, getJobSummary, listAssignableProducts, listAssignableVendors, listVendorAssignedProducts, revokeAssignedProducts, startBulkJob } from '../services/bulkApi';


const PAGE_SIZE = 50;
const SINGLE_JOB_POLL_MS = 1500;
const SINGLE_JOB_TIMEOUT_MS = 60000;
const MAX_SINGLE_IMAGES = 4;

const getActorFromQuery = () => {
  const params = new URLSearchParams(window.location.search);
  const roleParam = String(params.get('role') || '').toLowerCase();
  const actorRole = (roleParam === 'admin' || roleParam === 'superadmin' || roleParam === 'seller')
    ? roleParam
    : 'seller';
  const actorId = String(
    params.get('actorId') ||
    params.get('adminId') ||
    params.get('userId') ||
    params.get('sellerId') ||
    ''
  ).trim();
  const actorEmail = String(params.get('email') || '').trim();

  return {
    actorId,
    actorEmail,
    actorRole,
  };
};

const getDisplayOldGs = (item = {}) => {
  const candidate = String(item?.legacyGsCode || item?.oldGs || item?.legacyLookupOldGs || item?.productOGCode || '').trim().toUpperCase();
  if (!candidate) return '';
  return candidate;
};

const SelectionToggle = ({ checked, onClick, label }) => (
  <button
    type="button"
    onClick={onClick}
    aria-label={label}
    aria-pressed={checked}
    className={`h-5 w-5 rounded border flex items-center justify-center text-xs font-bold transition ${
      checked
        ? 'bg-blue-700 border-blue-700 text-white'
        : 'bg-white border-gray-300 text-transparent hover:border-blue-400'
    }`}
  >
    ✓
  </button>
);

const TableSkeletonRows = ({ rows = 8 }) => (
  <div className="overflow-auto max-h-[28rem]">
    <table className="min-w-full text-sm">
      <thead>
        <tr className="text-left border-b">
          <th className="py-2 pr-4 font-semibold">Select</th>
          <th className="py-2 pr-4">Product Name</th>
          <th className="py-2 pr-4">GS Code</th>
          <th className="py-2 pr-4">Old GS</th>
          <th className="py-2 pr-4">Product ID</th>
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: rows }).map((_, idx) => (
          <tr key={`skeleton-${idx}`} className="border-b last:border-b-0">
            <td className="py-2 pr-4"><div className="h-5 w-5 rounded border border-gray-200 bg-gray-100 animate-pulse" /></td>
            <td className="py-2 pr-4"><div className="h-4 w-40 rounded bg-gray-200 animate-pulse" /></td>
            <td className="py-2 pr-4"><div className="h-4 w-28 rounded bg-gray-200 animate-pulse" /></td>
            <td className="py-2 pr-4"><div className="h-4 w-24 rounded bg-gray-200 animate-pulse" /></td>
            <td className="py-2 pr-4"><div className="h-4 w-32 rounded bg-gray-200 animate-pulse" /></td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const PaginationControls = ({ page, pages, onChange }) => {
  if (!pages || pages <= 1) return null;

  return (
    <div className="mt-3 flex items-center justify-between text-xs text-gray-600">
      <span>Page {page} of {pages}</span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="px-2 py-1 rounded border border-gray-300 hover:bg-gray-100 disabled:opacity-40"
          onClick={() => onChange(page - 1)}
          disabled={page <= 1}
        >
          Prev
        </button>
        <button
          type="button"
          className="px-2 py-1 rounded border border-gray-300 hover:bg-gray-100 disabled:opacity-40"
          onClick={() => onChange(page + 1)}
          disabled={page >= pages}
        >
          Next
        </button>
      </div>
    </div>
  );
};

const LoadingPanel = ({ title, subtitle }) => (
  <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-white/80 backdrop-blur-sm">
    <div className="flex flex-col items-center gap-3 px-4 text-center">
      <div className="h-10 w-10 rounded-full border-4 border-blue-100 border-t-blue-700 animate-spin" />
      <div>
        <div className="text-sm font-semibold text-gray-900">{title}</div>
        <div className="text-xs text-gray-600">{subtitle}</div>
      </div>
    </div>
  </div>
);

export default function ReservedGsMappingPage() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState('reserved-buffer-publish');

  // Reserved Buffer Publish state
  const [fileName, setFileName] = useState('');
  const [previewRows, setPreviewRows] = useState([]);
  const [error, setError] = useState('');
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState(null);

  // Single Reserved Entry state
  const [singleForm, setSingleForm] = useState({
    productName: '',
    oldGs: '',
    brandManufacturer: '',
    category: '',
    subcategory: '',
    unit: 'Piece',
    stockQuantity: '',
    minWholesaleQty: '',
    wholesalePrice: '',
    retailPrice: '',
    costPrice: '',
  });
  const [singleError, setSingleError] = useState('');
  const [singleSubmitting, setSingleSubmitting] = useState(false);
  const [singleSubmitResult, setSingleSubmitResult] = useState(null);
  const [singleUploadProgress, setSingleUploadProgress] = useState(0);
  const [singleUploadStatus, setSingleUploadStatus] = useState('');
  const [singleImageQueue, setSingleImageQueue] = useState([]);
  const [singleUploadedImageUrls, setSingleUploadedImageUrls] = useState([]);
    const [manufacturers, setManufacturers] = useState([]);
    const [manufacturersError, setManufacturersError] = useState(false);
    const [categoriesList, setCategoriesList] = useState([]);
    const [categoriesLoading, setCategoriesLoading] = useState(true);
    const [subcategoriesList, setSubcategoriesList] = useState([]);
    const [subcategoriesLoading, setSubcategoriesLoading] = useState(false);

  // Assign Uploaded Products state
  const [vendors, setVendors] = useState([]);
  const [selectedVendorId, setSelectedVendorId] = useState('');
  const [selectedVendorEmail, setSelectedVendorEmail] = useState('');
  const [unassignedProducts, setUnassignedProducts] = useState([]);
  const [selectedUnassignedProductIds, setSelectedUnassignedProductIds] = useState([]);
  const [vendorAssignedProducts, setVendorAssignedProducts] = useState([]);
  const [selectedVendorAssignedProductIds, setSelectedVendorAssignedProductIds] = useState([]);
  const [loadingVendorProducts, setLoadingVendorProducts] = useState(false);
  const [loadingUnassignedProducts, setLoadingUnassignedProducts] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  const [vendorSearchQuery, setVendorSearchQuery] = useState('');
  const [debouncedVendorSearchQuery, setDebouncedVendorSearchQuery] = useState('');
  const [assignError, setAssignError] = useState('');
  const [loadingAssignData, setLoadingAssignData] = useState(false);
  const [assigning, setAssigning] = useState(false);

  const [unassignedPage, setUnassignedPage] = useState(1);
  const [unassignedPages, setUnassignedPages] = useState(1);
  const [unassignedTotal, setUnassignedTotal] = useState(0);
  const [vendorAssignedPage, setVendorAssignedPage] = useState(1);
  const [vendorAssignedPages, setVendorAssignedPages] = useState(1);
  const [vendorAssignedTotal, setVendorAssignedTotal] = useState(0);

  const assignedRows = useMemo(() => previewRows, [previewRows]);
  const validCount = useMemo(() => assignedRows.filter((row) => row.status === 'ok').length, [assignedRows]);
  const skippedDuplicateCount = useMemo(() => assignedRows.filter((row) => row.status === 'duplicate_old_gs').length, [assignedRows]);
  const invalidCount = useMemo(() => assignedRows.filter((row) => row.status === 'invalid_row').length, [assignedRows]);

  const allFilteredUnassignedProductIds = useMemo(
    () => unassignedProducts.map((item) => item.productId).filter(Boolean),
    [unassignedProducts]
  );

  const allFilteredVendorAssignedProductIds = useMemo(
    () => vendorAssignedProducts.map((item) => item.productId).filter(Boolean),
    [vendorAssignedProducts]
  );

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery.trim());
    }, 350);

    return () => clearTimeout(timer);
  }, [searchQuery]);

  useEffect(() => {
    setUnassignedPage(1);
  }, [debouncedSearchQuery]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedVendorSearchQuery(vendorSearchQuery.trim());
    }, 350);

    return () => clearTimeout(timer);
  }, [vendorSearchQuery]);

  useEffect(() => {
    setVendorAssignedPage(1);
  }, [debouncedVendorSearchQuery]);

    useEffect(() => {
      fetch(`${API_BASE_URL}/manufacturers`)
        .then((res) => res.json())
        .then((json) => {
          const list = Array.isArray(json) ? json : (json.manufacturers || []);
          if (list.length > 0) {
            setManufacturers(list);
          } else {
            setManufacturersError(true);
          }
        })
        .catch(() => setManufacturersError(true));
      
      fetch(`${API_BASE_URL}/categories`)
        .then((res) => res.json())
        .then((json) => {
          const list = Array.isArray(json) ? json : (json.categories || []);
          setCategoriesList(list);
        })
        .catch(() => setCategoriesList([]))
        .finally(() => setCategoriesLoading(false));
    }, []);

  useEffect(() => {
    if (!singleForm.category) {
      setSubcategoriesList([]);
      return;
    }
    setSubcategoriesLoading(true);
    fetch(`${API_BASE_URL}/categories/${singleForm.category}/subcategories`)
      .then((res) => res.json())
      .then((json) => {
        const list = Array.isArray(json) ? json : (json.subcategories || []);
        setSubcategoriesList(list);
      })
      .catch(() => setSubcategoriesList([]))
      .finally(() => setSubcategoriesLoading(false));
  }, [singleForm.category]);

  const onFileChange = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setFileName(file.name);
    setError('');
    setSubmitResult(null);
    setLoadingPreview(true);

    try {
      const result = await previewReservedMappings(file);
      setPreviewRows(result.rows || []);
    } catch (err) {
      setPreviewRows([]);
      const message = err?.message || 'Preview failed';
      setError(message);
    } finally {
      setLoadingPreview(false);
    }
  };

  const updateSingleField = (key, value) => {
      setSingleForm((prev) => {
        if (key === 'category') {
          return { ...prev, category: value, subcategory: '' };
        }
        return { ...prev, [key]: value };
      });
    };

  const handleSingleImageChange = (event) => {
    const nextFiles = Array.from(event.target.files || []).filter((file) => file && String(file.type || '').startsWith('image/'));

    setSingleError('');
    if (!nextFiles.length) {
      event.target.value = '';
      return;
    }

    setSingleImageQueue((prev) => {
      const allowedSlots = Math.max(0, MAX_SINGLE_IMAGES - prev.length);
      const accepted = nextFiles.slice(0, allowedSlots).map((file, idx) => ({
        id: `${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 7)}`,
        file,
        status: 'selected',
        url: '',
        message: 'Ready to upload',
      }));

      if (accepted.length < nextFiles.length) {
        setSingleError(`Only ${MAX_SINGLE_IMAGES} images are allowed. Extra images were ignored.`);
      }

      return [...prev, ...accepted].slice(0, MAX_SINGLE_IMAGES);
    });

    setSingleUploadedImageUrls([]);
    event.target.value = '';
  };

  const handleCancelSingleImage = (imageId) => {
    if (singleSubmitting) return;
    setSingleImageQueue((prev) => prev.filter((item) => item.id !== imageId));
    setSingleUploadedImageUrls([]);
  };

  const waitForSingleJobCatalogSave = async (jobId) => {
    const startedAt = Date.now();
    let visualProgress = 45;

    while ((Date.now() - startedAt) < SINGLE_JOB_TIMEOUT_MS) {
      const summary = await getJobSummary(jobId);
      const total = Math.max(1, Number(summary?.total || 1));
      const processed = Math.max(0, Number(summary?.processed || 0));
      const savedCount = Math.max(0, Number(summary?.savedCount || 0));
      const saveFailCount = Math.max(0, Number(summary?.saveFailCount || 0));
      const status = String(summary?.status || '').toLowerCase();

      const processPercent = Math.min(80, Math.round((processed / total) * 80));
      const savePercent = savedCount > 0 ? 20 : 0;

      // Keep progress moving while background job updates are sparse so users do not think it is stuck.
      const apiProgress = Math.min(99, processPercent + savePercent);
      visualProgress = Math.max(visualProgress + 3, apiProgress, 45);
      visualProgress = Math.min(99, visualProgress);
      setSingleUploadProgress(visualProgress);
      setSingleUploadStatus(`Processing ${Math.min(processed, total)}/${total} item(s)...`);

      if (savedCount > 0) {
        setSingleUploadProgress(100);
        setSingleUploadStatus('Saved to catalog. It is now available in Product List.');
        return;
      }

      if (status === 'failed') {
        throw new Error(String(summary?.error || 'Upload job failed before catalog save.'));
      }

      if (status === 'completed' && savedCount === 0) {
        const saveErr = saveFailCount > 0
          ? 'Upload completed but catalog save failed. Please retry once.'
          : 'Upload completed but catalog save is not confirmed yet. Please retry.';
        throw new Error(saveErr);
      }

      await new Promise((resolve) => setTimeout(resolve, SINGLE_JOB_POLL_MS));
    }

    throw new Error('Upload is taking longer than expected. Please check Product List in a few seconds.');
  };

  const mapPreviewRowToBulkProduct = (row) => ({
    product_name: row.productName || '',
    oldGs: row.oldGs || '',
    lookupSource: 'reserved-buffer-publish',
    ean: '',
    brand: row.brandManufacturer || '',
    category: row.category || '',
    subcategory: row.subcategory || '',
    unit: row.unit || 'Piece',
    stockQty: row.stockQuantity ?? '',
    wholesale_qty: row.minWholesaleQty ?? '',
    price_wholesale: row.wholesalePrice ?? '',
    price_retail: row.retailPrice ?? '',
    costPrice: row.costPrice ?? '',
    image_url: row.imageUrl1 || '',
    image_url_2: row.imageUrl2 || '',
    image_url_3: row.imageUrl3 || '',
    image_url_4: row.imageUrl4 || '',
    communetsCode: row.newGs || ''
  });

  const handleSubmitSingleReserved = async () => {
    if (singleSubmitting) return;
    const { actorId, actorEmail, actorRole } = getActorFromQuery();
    if (!String(singleForm.productName || '').trim() || !String(singleForm.oldGs || '').trim()) {
      setSingleError('Product Name and Old GS (SKU) are required.');
      return;
    }

    setSingleSubmitting(true);
    setSingleError('');
    setSingleSubmitResult(null);
    setSingleUploadProgress(5);
    setSingleUploadStatus('Preparing upload...');
    try {
      let imageUrls = singleUploadedImageUrls;
      if (singleImageQueue.length > 0) {
        const imageFiles = singleImageQueue.map((item) => item.file).slice(0, MAX_SINGLE_IMAGES);
        setSingleImageQueue((prev) => prev.map((item) => ({ ...item, status: 'uploading', message: 'Uploading...' })));
        setSingleUploadStatus(`Uploading ${imageFiles.length} image(s)...`);
        setSingleUploadProgress(15);
        const uploadResult = await uploadImages(imageFiles);
        const uploadedUrls = (uploadResult?.urls || []).slice(0, MAX_SINGLE_IMAGES);
        const fileErrors = Array.isArray(uploadResult?.fileErrors) ? uploadResult.fileErrors : [];
        const errorCounts = fileErrors.reduce((acc, item) => {
          const key = String(item?.fileName || '').trim();
          if (!key) return acc;
          acc[key] = (acc[key] || 0) + 1;
          return acc;
        }, {});

        let successIdx = 0;
        const nextQueue = singleImageQueue.map((item) => {
          const failedCount = errorCounts[item.file.name] || 0;
          if (failedCount > 0) {
            errorCounts[item.file.name] = failedCount - 1;
            return {
              ...item,
              status: 'failed',
              url: '',
              message: 'Upload failed',
            };
          }

          const url = uploadedUrls[successIdx] || '';
          if (!url) {
            return {
              ...item,
              status: 'failed',
              url: '',
              message: 'No URL returned',
            };
          }

          successIdx += 1;
          return {
            ...item,
            status: 'uploaded',
            url,
            message: 'Uploaded',
          };
        });

        setSingleImageQueue(nextQueue);
        imageUrls = nextQueue.filter((item) => item.status === 'uploaded').map((item) => item.url).slice(0, MAX_SINGLE_IMAGES);
        setSingleUploadedImageUrls(imageUrls);
        if (imageUrls.length === 0) {
          throw new Error('Image upload failed. Please try again.');
        }

        if (imageUrls.length < imageFiles.length) {
          setSingleError(`Only ${imageUrls.length}/${imageFiles.length} image(s) uploaded. You can remove failed images and retry.`);
        }
      }

      setSingleUploadStatus('Allocating reserved GS code...');
      setSingleUploadProgress(30);
      const previewResult = await previewSingleReservedMapping({
        ...singleForm,
        imageUrl1: imageUrls[0] || '',
        imageUrl2: imageUrls[1] || '',
        imageUrl3: imageUrls[2] || '',
        imageUrl4: imageUrls[3] || '',
      });
      const row = previewResult?.row || (Array.isArray(previewResult?.rows) ? previewResult.rows[0] : null);
      if (!row || row.status !== 'ok') {
        throw new Error(row?.message || 'Reserved GS could not be allocated.');
      }

      const products = [mapPreviewRowToBulkProduct(row)];
      setSingleUploadStatus('Starting catalog upload job...');
      setSingleUploadProgress(45);
      const result = await startBulkJob(products, actorId, actorEmail, actorRole, actorId, true);
      if (!result?.jobId) {
        throw new Error('Job could not be created');
      }

      setSingleSubmitResult({
        jobId: result.jobId,
        assignedGs: row.newGs || '',
        message: `Reserved GS ${row.newGs || 'has been assigned'} and upload is running.`,
      });

      await waitForSingleJobCatalogSave(result.jobId);

      setSingleSubmitResult({
        jobId: result.jobId,
        assignedGs: row.newGs || '',
        message: `Reserved GS ${row.newGs || 'has been assigned'} and the product is saved to catalog.`,
      });
    } catch (err) {
      setSingleError(err.response?.data?.error || err.message || 'Failed to upload reserved entry to catalog');
    } finally {
      setSingleSubmitting(false);
    }
  };

  const getValidRows = () => assignedRows.filter((row) => row.status === 'ok');

  const handleSubmitReservedBufferPublish = async () => {
    if (submitting) return;
    const { actorId, actorEmail, actorRole } = getActorFromQuery();
    const validRows = getValidRows();

    if (validRows.length === 0) {
      setError('No valid rows to submit.');
      return;
    }

      const products = validRows.map((row) => mapPreviewRowToBulkProduct(row));

    setSubmitting(true);
    setError('');
    setSubmitResult(null);

    try {
      const result = await startBulkJob(products, actorId, actorEmail, actorRole, actorId, false);
      if (!result?.jobId) {
        throw new Error('Job could not be created');
      }
      navigate(`/track/${result.jobId}`);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to start reserved-buffer-publish pipeline');
    } finally {
      setSubmitting(false);
    }
  };

  useEffect(() => {
    if (activeTab !== 'assign-uploaded') return;

    const loadVendors = async () => {
      setLoadingAssignData(true);
      setAssignError('');
      try {
        const actor = getActorFromQuery();
        const vendorData = await listAssignableVendors(actor);
        const vendorList = Array.isArray(vendorData?.vendors) ? vendorData.vendors : [];
        setVendors(vendorList);
      } catch (err) {
        setAssignError(err.response?.data?.error || err.message || 'Failed to load vendors');
      } finally {
        setLoadingAssignData(false);
      }
    };

    loadVendors();
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== 'assign-uploaded') return;

    const loadAssignableProducts = async () => {
      setLoadingUnassignedProducts(true);
      setAssignError('');
      try {
        const actor = getActorFromQuery();
        const data = await listAssignableProducts({
          actorId: actor.actorId,
          actorEmail: actor.actorEmail,
          page: unassignedPage,
          limit: PAGE_SIZE,
          search: debouncedSearchQuery,
        });
        setUnassignedProducts(Array.isArray(data?.products) ? data.products : []);
        setUnassignedTotal(Number(data?.total || 0));
        setUnassignedPages(Number(data?.pages || 1));
      } catch (err) {
        setAssignError(err.response?.data?.error || err.message || 'Failed to load assignable products');
      } finally {
        setLoadingUnassignedProducts(false);
      }
    };

    loadAssignableProducts();
  }, [activeTab, unassignedPage, debouncedSearchQuery]);

  const onVendorChange = (value) => {
    setSelectedVendorId(value);
    const vendor = vendors.find((v) => v.userId === value);
    setSelectedVendorEmail(vendor?.email || '');
    setSelectedVendorAssignedProductIds([]);
    setVendorAssignedPage(1);
  };

  useEffect(() => {
    if (activeTab !== 'vendor-assigned') return;
    if (!selectedVendorId) {
      setVendorAssignedProducts([]);
      setVendorAssignedTotal(0);
      setVendorAssignedPages(1);
      setSelectedVendorAssignedProductIds([]);
      return;
    }

    const loadVendorProducts = async () => {
      setLoadingVendorProducts(true);
      setAssignError('');
      try {
        const actor = getActorFromQuery();
        const vendorProductsData = await listVendorAssignedProducts({
          actorId: actor.actorId,
          actorEmail: actor.actorEmail,
          vendorUserId: selectedVendorId,
          page: vendorAssignedPage,
          limit: PAGE_SIZE,
          search: debouncedVendorSearchQuery,
        });
        setVendorAssignedProducts(Array.isArray(vendorProductsData?.products) ? vendorProductsData.products : []);
        setVendorAssignedTotal(Number(vendorProductsData?.total || 0));
        setVendorAssignedPages(Number(vendorProductsData?.pages || 1));
      } catch (err) {
        setAssignError(err.response?.data?.error || err.message || 'Failed to load vendor assigned products');
      } finally {
        setLoadingVendorProducts(false);
      }
    };

    loadVendorProducts();
  }, [activeTab, selectedVendorId, vendorAssignedPage, debouncedVendorSearchQuery]);

  const toggleUnassignedProductId = (productId) => {
    setSelectedUnassignedProductIds((prev) => prev.includes(productId)
      ? prev.filter((id) => id !== productId)
      : [...prev, productId]);
  };

  const toggleSelectAllUnassigned = () => {
    setSelectedUnassignedProductIds((prev) => {
      const visibleIds = allFilteredUnassignedProductIds;
      if (visibleIds.length === 0) return prev;

      const allVisibleSelected = visibleIds.every((id) => prev.includes(id));
      if (allVisibleSelected) {
        return prev.filter((id) => !visibleIds.includes(id));
      }

      return [...new Set([...prev, ...visibleIds])];
    });
  };

  const toggleVendorAssignedProductId = (productId) => {
    setSelectedVendorAssignedProductIds((prev) => prev.includes(productId)
      ? prev.filter((id) => id !== productId)
      : [...prev, productId]);
  };

  const toggleSelectAllVendorAssigned = () => {
    setSelectedVendorAssignedProductIds((prev) => {
      const visibleIds = allFilteredVendorAssignedProductIds;
      if (visibleIds.length === 0) return prev;

      const allVisibleSelected = visibleIds.every((id) => prev.includes(id));
      if (allVisibleSelected) {
        return prev.filter((id) => !visibleIds.includes(id));
      }

      return [...new Set([...prev, ...visibleIds])];
    });
  };

  const handleAssignSelected = async () => {
    if (!selectedVendorId && !selectedVendorEmail) {
      setAssignError('Select a vendor first.');
      return;
    }
    if (selectedUnassignedProductIds.length === 0) {
      setAssignError('Select at least one product to assign.');
      return;
    }

    setAssigning(true);
    setAssignError('');
    try {
      const actor = getActorFromQuery();
      await assignUploadedProducts({
        actorId: actor.actorId,
        actorEmail: actor.actorEmail,
        productIds: selectedUnassignedProductIds,
        targetUserId: selectedVendorId,
        targetEmail: selectedVendorEmail,
      });

      setSelectedUnassignedProductIds([]);
      const refreshedAssignableProducts = await listAssignableProducts({
        actorId: actor.actorId,
        actorEmail: actor.actorEmail,
        page: unassignedPage,
        limit: PAGE_SIZE,
        search: debouncedSearchQuery,
      });
      setUnassignedProducts(Array.isArray(refreshedAssignableProducts?.products) ? refreshedAssignableProducts.products : []);
      setUnassignedTotal(Number(refreshedAssignableProducts?.total || 0));
      setUnassignedPages(Number(refreshedAssignableProducts?.pages || 1));
    } catch (err) {
      setAssignError(err.response?.data?.error || err.message || 'Failed to assign selected products');
    } finally {
      setAssigning(false);
    }
  };

  const handleRevokeSelected = async () => {
    if (!selectedVendorId) {
      setAssignError('Select a vendor first.');
      return;
    }
    if (selectedVendorAssignedProductIds.length === 0) {
      setAssignError('Select at least one vendor-assigned product to revoke.');
      return;
    }

    setRevoking(true);
    setAssignError('');
    try {
      const actor = getActorFromQuery();
      await revokeAssignedProducts({
        actorId: actor.actorId,
        actorEmail: actor.actorEmail,
        productIds: selectedVendorAssignedProductIds,
      });

      setSelectedVendorAssignedProductIds([]);
      const [refreshedAssignableProducts, refreshedVendorProducts] = await Promise.all([
        listAssignableProducts({
          actorId: actor.actorId,
          actorEmail: actor.actorEmail,
          page: unassignedPage,
          limit: PAGE_SIZE,
          search: debouncedSearchQuery,
        }),
        listVendorAssignedProducts({
          actorId: actor.actorId,
          actorEmail: actor.actorEmail,
          vendorUserId: selectedVendorId,
          page: vendorAssignedPage,
          limit: PAGE_SIZE,
          search: debouncedSearchQuery,
        }),
      ]);
      setUnassignedProducts(Array.isArray(refreshedAssignableProducts?.products) ? refreshedAssignableProducts.products : []);
      setVendorAssignedProducts(Array.isArray(refreshedVendorProducts?.products) ? refreshedVendorProducts.products : []);
      setUnassignedTotal(Number(refreshedAssignableProducts?.total || 0));
      setUnassignedPages(Number(refreshedAssignableProducts?.pages || 1));
      setVendorAssignedTotal(Number(refreshedVendorProducts?.total || 0));
      setVendorAssignedPages(Number(refreshedVendorProducts?.pages || 1));
    } catch (err) {
      setAssignError(err.response?.data?.error || err.message || 'Failed to revoke selected products');
    } finally {
      setRevoking(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="bg-white border border-gray-200 rounded-lg p-2">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={`px-4 py-2 rounded-md text-sm font-semibold ${activeTab === 'reserved-buffer-publish' ? 'bg-blue-700 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
            onClick={() => {
              setActiveTab('reserved-buffer-publish');
              setError('');
            }}
          >
            Reserved Buffer Publish
          </button>
          <button
            type="button"
            className={`px-4 py-2 rounded-md text-sm font-semibold ${activeTab === 'assign-uploaded' ? 'bg-blue-700 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
            onClick={() => {
              setActiveTab('assign-uploaded');
              setAssignError('');
            }}
          >
            Assign Uploaded Products
          </button>
            <button
              type="button"
              className={`px-4 py-2 rounded-md text-sm font-semibold ${activeTab === 'single-reserved-entry' ? 'bg-blue-700 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
              onClick={() => {
                setActiveTab('single-reserved-entry');
                setSingleError('');
              }}
            >
              Single Reserved Entry
            </button>
          <button
            type="button"
            className={`px-4 py-2 rounded-md text-sm font-semibold ${activeTab === 'vendor-assigned' ? 'bg-blue-700 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
            onClick={() => {
              setActiveTab('vendor-assigned');
              setAssignError('');
            }}
          >
            Vendor Assigned Products
          </button>
        </div>
      </div>

      {activeTab === 'reserved-buffer-publish' ? (
        <>
          <div className="bg-white border border-gray-200 rounded-lg p-4">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
              <label className="block text-sm font-semibold text-gray-700">Upload Mapping Sheet (.xlsx or .csv)</label>
              <a
                href="/ai-api/reserved-mapping/template"
                download="reserved_buffer_template.xlsx"
                className="inline-flex items-center rounded-md border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-100"
              >
                Download Template Excel
              </a>
            </div>
            <input type="file" accept=".xlsx,.csv" onChange={onFileChange} className="block w-full text-sm" />
            {fileName && <p className="text-xs text-gray-500 mt-2">Selected: {fileName}</p>}
            {loadingPreview && <p className="text-xs text-blue-700 mt-2">Generating preview...</p>}
            {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
          </div>

          <div className="bg-white border border-gray-200 rounded-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-gray-900">Mapping Preview</h3>
              <span className="text-xs text-gray-500">Rows: {assignedRows.length}</span>
            </div>

            {loadingPreview && (
              <div className="relative min-h-[14rem]">
                <LoadingPanel
                  title="Generating reserved buffer preview"
                  subtitle="Reading the sheet and preparing allocation rows..."
                />
              </div>
            )}

            {!loadingPreview && assignedRows.length > 0 && (
              <div className="mb-3 flex flex-wrap gap-2 text-xs">
                <span className="px-2 py-1 rounded bg-green-100 text-green-700">Valid: {validCount}</span>
                <span className="px-2 py-1 rounded bg-amber-100 text-amber-800">Skipped (Already exists): {skippedDuplicateCount}</span>
                <span className="px-2 py-1 rounded bg-red-100 text-red-700">Invalid: {invalidCount}</span>
              </div>
            )}

            {!loadingPreview && skippedDuplicateCount > 0 && (
              <div className="mb-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                {skippedDuplicateCount} row(s) were skipped because the same SKU (old GS) already exists in the reserved registry.
              </div>
            )}

            {!loadingPreview && assignedRows.length === 0 ? (
              <p className="text-sm text-gray-500">No rows to preview yet.</p>
            ) : (
              <div className="overflow-auto relative">
                {loadingPreview && null}
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="text-left border-b">
                      <th className="py-2 pr-4">Row</th>
                      <th className="py-2 pr-4">Product Name</th>
                      <th className="py-2 pr-4">Old GS (SKU)</th>
                      <th className="py-2 pr-4">Assigned Reserved GS</th>
                      <th className="py-2 pr-4">Status</th>
                      <th className="py-2 pr-4">Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {assignedRows.map((row, idx) => (
                      <tr key={`${row.oldGs || 'row'}-${idx}`} className="border-b last:border-b-0">
                        <td className="py-2 pr-4">{row.rowNumber || idx + 2}</td>
                        <td className="py-2 pr-4">{row.productName || '-'}</td>
                        <td className="py-2 pr-4 font-mono">{row.oldGs || '-'}</td>
                        <td className="py-2 pr-4 font-mono text-blue-700">{row.newGs}</td>
                        <td className="py-2 pr-4">
                          <span className={`px-2 py-1 rounded text-xs font-semibold ${
                            row.status === 'ok'
                              ? 'bg-green-100 text-green-700'
                              : row.status === 'duplicate_old_gs'
                                ? 'bg-amber-100 text-amber-800'
                                : 'bg-red-100 text-red-700'
                          }`}>
                            {row.status === 'ok' ? 'Valid' : row.status === 'duplicate_old_gs' ? 'Skipped' : 'Invalid row'}
                          </span>
                        </td>
                        <td className="py-2 pr-4 text-xs text-gray-600">{row.message || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="flex items-center gap-3">
                  <button
              type="button"
                    onClick={handleSubmitReservedBufferPublish}
              disabled={submitting || validCount === 0}
              className="bg-blue-700 text-white px-4 py-2 rounded font-semibold hover:bg-blue-800 disabled:opacity-50"
            >
              {submitting ? 'Submitting...' : 'Process to Catalog'}
            </button>
            {submitResult?.result?.message && (
              <span className="text-sm text-green-700">{submitResult.result.message}</span>
            )}
          </div>

        </>
        ) : activeTab === 'single-reserved-entry' ? (
          <>
            <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-4">
              <div>
                <h3 className="font-semibold text-gray-900">Single Reserved GS Product Entry</h3>
                <p className="text-xs text-gray-600 mt-1">Add one product with old GS (SKU) and upload it directly to catalog.</p>
                  <p className="text-[11px] text-gray-500 mt-1">Only Product Name and Old GS are required. All other fields are optional.</p>
                  <p className="text-[11px] text-amber-700 mt-1">Reserved GS is assigned automatically when you click Upload to Catalog.</p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">Product Name *</label>
                    <input type="text" required className="w-full border border-gray-300 rounded px-3 py-2 text-sm" value={singleForm.productName} onChange={(e) => updateSingleField('productName', e.target.value)} />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">Old GS / SKU *</label>
                    <input type="text" required className="w-full border border-gray-300 rounded px-3 py-2 text-sm font-mono" value={singleForm.oldGs} onChange={(e) => updateSingleField('oldGs', e.target.value)} />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">Brand / Manufacturer</label>
                    {manufacturersError ? (
                      <input type="text" className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none text-sm" value={singleForm.brandManufacturer} onChange={(e) => updateSingleField('brandManufacturer', e.target.value)} placeholder="Brand / Manufacturer" />
                    ) : (
                      <select className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none text-sm" value={singleForm.brandManufacturer} onChange={(e) => updateSingleField('brandManufacturer', e.target.value)}>
                        <option value="">-- Select Brand / Manufacturer --</option>
                        {manufacturers.map((m) => (
                          <option key={m.manufacturerId} value={m.manufacturerId}>{m.manufacturerName}</option>
                        ))}
                      </select>
                    )}
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">Category</label>
                    <select className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none text-sm" value={singleForm.category} onChange={(e) => { updateSingleField('category', e.target.value); updateSingleField('subcategory', ''); }} disabled={categoriesLoading}>
                      <option value="">{categoriesLoading ? 'Loading...' : '-- Select Category --'}</option>
                      {categoriesList.map((cat) => (
                        <option key={cat.categoryId} value={cat.categoryId}>{cat.categoryName}</option>
                      ))}
                    </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">Subcategory</label>
                    <select className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none text-sm" value={singleForm.subcategory} onChange={(e) => updateSingleField('subcategory', e.target.value)} disabled={!singleForm.category || subcategoriesLoading}>
                      <option value="">{subcategoriesLoading ? 'Loading...' : '-- Select Subcategory --'}</option>
                      {subcategoriesList.map((sub) => (
                        <option key={sub.categoryId} value={sub.categoryId}>{sub.categoryName}</option>
                      ))}
                    </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">Unit</label>
                  <select className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none text-sm" value={singleForm.unit} onChange={(e) => updateSingleField('unit', e.target.value)}>
                    <option>PKT</option>
                    <option>PCS</option>
                    <option>Bottle</option>
                    <option>Pakcint</option>
                    <option>RL</option>
                    <option>Roll</option>
                    <option>Nos</option>
                    <option>BOX</option>
                    <option>SET</option>
                    <option>EA</option>
                    <option>MTR</option>
                    <option>M</option>
                    <option>BAG</option>
                    <option>DOZ</option>
                    <option>PAIRS</option>
                    <option>PSC</option>
                    <option>PC</option>
                    <option>EACH</option>
                    <option>LS</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">Stock Quantity</label>
                  <input type="number" className="w-full border border-gray-300 rounded px-3 py-2 text-sm" value={singleForm.stockQuantity} onChange={(e) => updateSingleField('stockQuantity', e.target.value)} />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">Min. Wholesale Qty</label>
                  <input type="number" className="w-full border border-gray-300 rounded px-3 py-2 text-sm" value={singleForm.minWholesaleQty} onChange={(e) => updateSingleField('minWholesaleQty', e.target.value)} />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">Wholesale Price</label>
                  <input type="number" className="w-full border border-gray-300 rounded px-3 py-2 text-sm" value={singleForm.wholesalePrice} onChange={(e) => updateSingleField('wholesalePrice', e.target.value)} />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">Retail Price</label>
                  <input type="number" className="w-full border border-gray-300 rounded px-3 py-2 text-sm" value={singleForm.retailPrice} onChange={(e) => updateSingleField('retailPrice', e.target.value)} />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">Partner Price</label>
                  <input type="number" className="w-full border border-gray-300 rounded px-3 py-2 text-sm" value={singleForm.costPrice} onChange={(e) => updateSingleField('costPrice', e.target.value)} />
                </div>
                <div>
                    <label className="block text-xs font-semibold text-gray-700 mb-1">Product Images (Optional, max 4)</label>
                    <input type="file" multiple accept="image/*" onChange={handleSingleImageChange} className="w-full border border-gray-300 rounded px-3 py-2 text-sm" />
                    {singleImageQueue.length > 0 && (
                      <p className="mt-1 text-[11px] text-gray-500">{singleImageQueue.length} image(s) selected.</p>
                    )}
                    {singleImageQueue.length > 0 && (
                      <div className="mt-2 space-y-1 rounded border border-gray-200 bg-gray-50 p-2 text-[11px]">
                        {singleImageQueue.map((item, idx) => (
                          <div key={item.id} className="flex items-center justify-between gap-2 rounded bg-white px-2 py-1 border border-gray-100">
                            <div className="min-w-0">
                              <div className="truncate text-gray-700">{idx + 1}. {item.file.name}</div>
                              <div className={`text-[10px] ${item.status === 'uploaded' ? 'text-green-600' : item.status === 'failed' ? 'text-red-600' : item.status === 'uploading' ? 'text-blue-600' : 'text-gray-500'}`}>
                                {item.message}
                              </div>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              {item.status === 'uploaded' && (
                                <span className="rounded bg-green-100 px-2 py-0.5 text-[10px] font-semibold text-green-700">Uploaded</span>
                              )}
                              {item.status === 'uploading' && (
                                <span className="rounded bg-blue-100 px-2 py-0.5 text-[10px] font-semibold text-blue-700">Uploading</span>
                              )}
                              {item.status === 'failed' && (
                                <span className="rounded bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-700">Failed</span>
                              )}
                              <button
                                type="button"
                                onClick={() => handleCancelSingleImage(item.id)}
                                disabled={singleSubmitting}
                                className="rounded border border-red-200 px-2 py-0.5 text-[10px] font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
                              >
                                Cancel image
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    {singleUploadedImageUrls.length > 0 && (
                      <p className="mt-1 text-[11px] text-green-600">{singleUploadedImageUrls.length} image(s) uploaded and ready.</p>
                    )}
                </div>
              </div>

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleSubmitSingleReserved}
                  disabled={singleSubmitting}
                  className="bg-blue-700 text-white px-4 py-2 rounded font-semibold hover:bg-blue-800 disabled:opacity-50"
                >
                  {singleSubmitting ? 'Uploading...' : 'Upload to Catalog'}
                </button>
              </div>

              {singleSubmitting && (
                <div className="rounded border border-blue-200 bg-blue-50 px-3 py-3">
                  <div className="mb-2 flex items-center justify-between text-xs text-blue-900">
                    <span>{singleUploadStatus || 'Uploading...'}</span>
                    <span className="font-semibold">{singleUploadProgress}%</span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded bg-blue-100">
                    <div
                      className="h-2 rounded bg-blue-700 transition-all duration-500"
                      style={{ width: `${Math.max(5, Math.min(100, singleUploadProgress))}%` }}
                    />
                  </div>
                  <div className="mt-2 text-[11px] text-blue-700">Please wait until this reaches 100% before uploading another entry.</div>
                </div>
              )}

              {singleError && <p className="text-sm text-red-600">{singleError}</p>}
              {singleSubmitResult && (
                <div className="rounded border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
                  {singleUploadProgress === 100 && !singleSubmitting && !singleError && (
                    <div className="mb-1 font-semibold">Product saved successfully. Changes are now live in Product List.</div>
                  )}
                  <div className="font-semibold">Upload complete</div>
                  <div>{singleSubmitResult.message}</div>
                  {singleSubmitResult.jobId && (
                    <div className="text-xs mt-1">Job ID: {singleSubmitResult.jobId}</div>
                  )}
                </div>
              )}
            </div>

            <div className="bg-white border border-gray-200 rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold text-gray-900">Single Entry Status</h3>
              </div>

              {!singleSubmitResult ? (
                <p className="text-sm text-gray-500">No upload has been sent yet.</p>
              ) : (
                <div className="rounded border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">
                  <div className="font-semibold">Reserved GS assigned</div>
                  <div>{singleSubmitResult.assignedGs || 'Assigned reserved GS is ready.'}</div>
                </div>
              )}
            </div>
          </>
        ) : activeTab === 'assign-uploaded' ? (
        <>
          <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-4">
            {loadingAssignData ? (
              <p className="text-sm text-gray-500">Loading assignable products...</p>
            ) : (
              <>
                <div className="grid grid-cols-1 md:grid-cols-1 gap-4">
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-2">Search Product</label>
                    <input
                      type="text"
                      className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
                      placeholder="Search by Product name, GS code, Old GS, or Product ID"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                    />
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={handleAssignSelected}
                    disabled={
                      assigning ||
                      selectedUnassignedProductIds.length === 0 ||
                      (!selectedVendorId && !selectedVendorEmail)
                    }
                    className="bg-blue-700 text-white px-4 py-2 rounded font-semibold hover:bg-blue-800 disabled:opacity-50 ml-auto"
                  >
                    {assigning ? 'Assigning...' : `Assign Selected (${selectedUnassignedProductIds.length})`}
                  </button>
                </div>
              </>
            )}
          </div>

          <div className="bg-white border border-gray-200 rounded-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-gray-900">Step 1: Select Vendor</h3>
              <div className="text-xs text-gray-500">Assign to which vendor?</div>
            </div>
            <select
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm mb-4"
              value={selectedVendorId}
              onChange={(e) => onVendorChange(e.target.value)}
            >
              <option value="">Select a vendor</option>
              {vendors.map((vendor) => (
                <option key={vendor.userId} value={vendor.userId}>
                  {`${vendor.firstName || ''} ${vendor.lastName || ''}`.trim() || vendor.email} ({vendor.userId})
                </option>
              ))}
            </select>
          </div>

          <div className="bg-white border border-gray-200 rounded-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-gray-900">Step 2: Select Assignable Products</h3>
              <div className="text-xs text-gray-500">
                {`${unassignedProducts.length} shown / ${unassignedTotal} total`}
              </div>
            </div>

            {unassignedProducts.length > 0 && (
              <div className="mb-3">
                <button
                  type="button"
                  className="text-sm font-semibold text-blue-700 hover:underline"
                  onClick={toggleSelectAllUnassigned}
                >
                  {allFilteredUnassignedProductIds.length > 0 && allFilteredUnassignedProductIds.every((id) => selectedUnassignedProductIds.includes(id))
                    ? 'Clear all'
                    : 'Select all'}
                </button>
              </div>
            )}

            {loadingUnassignedProducts ? (
              <TableSkeletonRows rows={8} />
            ) : unassignedProducts.length === 0 ? (
              <p className="text-sm text-gray-500">No assignable products match your current search.</p>
            ) : (
              <>
                <div className="overflow-auto max-h-[28rem]">
                  <table className="min-w-full text-sm">
                    <thead>
                      <tr className="text-left border-b">
                        <th className="py-2 pr-4 font-semibold">Select</th>
                        <th className="py-2 pr-4">Product Name</th>
                        <th className="py-2 pr-4">GS Code</th>
                        <th className="py-2 pr-4">Old GS</th>
                        <th className="py-2 pr-4">Product ID</th>
                      </tr>
                    </thead>
                    <tbody>
                      {unassignedProducts.map((item) => (
                        <tr key={`assignable-${item.productId}`} className="border-b last:border-b-0 hover:bg-blue-50/40">
                          <td className="py-2 pr-4">
                            <SelectionToggle
                              checked={selectedUnassignedProductIds.includes(item.productId)}
                              onClick={() => toggleUnassignedProductId(item.productId)}
                              label={`Select ${item.productName || item.productId}`}
                            />
                          </td>
                          <td className="py-2 pr-4">{item.productName}</td>
                          <td className="py-2 pr-4 font-mono text-blue-700">{item.communetCode}</td>
                          <td className="py-2 pr-4 font-mono text-gray-600">{getDisplayOldGs(item) || '-'}</td>
                          <td className="py-2 pr-4">{item.productId}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <PaginationControls page={unassignedPage} pages={unassignedPages} onChange={setUnassignedPage} />
              </>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-4">
            {loadingAssignData ? (
              <p className="text-sm text-gray-500">Loading vendors...</p>
            ) : (
              <>
                <div className="grid grid-cols-1 md:grid-cols-1 gap-4">
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-2">Select Vendor</label>
                    <select
                      className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
                      value={selectedVendorId}
                      onChange={(e) => onVendorChange(e.target.value)}
                    >
                      <option value="">Select a vendor</option>
                      {vendors.map((vendor) => (
                        <option key={vendor.userId} value={vendor.userId}>
                          {`${vendor.firstName || ''} ${vendor.lastName || ''}`.trim() || vendor.email} ({vendor.userId})
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-2">Search Product</label>
                    <input
                      type="text"
                      className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
                      placeholder="Search by Product name, GS code, Old GS, or Product ID"
                      value={vendorSearchQuery}
                      onChange={(e) => setVendorSearchQuery(e.target.value)}
                    />
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={handleRevokeSelected}
                    disabled={
                      revoking ||
                      selectedVendorAssignedProductIds.length === 0 ||
                      !selectedVendorId
                    }
                    className="bg-red-600 text-white px-4 py-2 rounded font-semibold hover:bg-red-700 disabled:opacity-50"
                  >
                    {revoking ? 'Revoking...' : `Revoke Access (${selectedVendorAssignedProductIds.length})`}
                  </button>
                </div>

                {assignError && (
                  <div className="rounded border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm">{assignError}</div>
                )}
              </>
            )}
          </div>

          <div className="bg-white border border-gray-200 rounded-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-gray-900">Vendor Assigned Products</h3>
              <div className="text-xs text-gray-500">
                {selectedVendorId
                  ? `${vendorAssignedProducts.length} shown / ${vendorAssignedTotal} total`
                  : 'Select a vendor to load products'}
              </div>
            </div>

            {selectedVendorId && vendorAssignedProducts.length > 0 && (
              <div className="mb-3">
                <button
                  type="button"
                  className="text-sm font-semibold text-blue-700 hover:underline"
                  onClick={toggleSelectAllVendorAssigned}
                >
                  {allFilteredVendorAssignedProductIds.length > 0 && allFilteredVendorAssignedProductIds.every((id) => selectedVendorAssignedProductIds.includes(id))
                    ? 'Clear all'
                    : 'Select all'}
                </button>
              </div>
            )}

            {!selectedVendorId ? (
              <p className="text-sm text-gray-500">Select a vendor to view assigned products.</p>
            ) : loadingVendorProducts ? (
              <TableSkeletonRows rows={8} />
            ) : vendorAssignedProducts.length === 0 ? (
              <p className="text-sm text-gray-500">No vendor products match your current search.</p>
            ) : (
              <>
                <div className="overflow-auto max-h-[28rem]">
                  <table className="min-w-full text-sm">
                    <thead>
                      <tr className="text-left border-b">
                        <th className="py-2 pr-4 font-semibold">Select</th>
                        <th className="py-2 pr-4">Product Name</th>
                        <th className="py-2 pr-4">GS Code</th>
                        <th className="py-2 pr-4">Old GS</th>
                        <th className="py-2 pr-4">Product ID</th>
                      </tr>
                    </thead>
                    <tbody>
                      {vendorAssignedProducts.map((item) => (
                        <tr key={`vendor-assigned-${item.productId}`} className="border-b last:border-b-0 hover:bg-red-50/40">
                          <td className="py-2 pr-4">
                            <SelectionToggle
                              checked={selectedVendorAssignedProductIds.includes(item.productId)}
                              onClick={() => toggleVendorAssignedProductId(item.productId)}
                              label={`Select ${item.productName || item.productId}`}
                            />
                          </td>
                          <td className="py-2 pr-4">{item.productName}</td>
                          <td className="py-2 pr-4 font-mono text-blue-700">{item.communetCode}</td>
                          <td className="py-2 pr-4 font-mono text-gray-600">{getDisplayOldGs(item) || '-'}</td>
                          <td className="py-2 pr-4">{item.productId}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <PaginationControls page={vendorAssignedPage} pages={vendorAssignedPages} onChange={setVendorAssignedPage} />
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
