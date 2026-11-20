import React, { useMemo, useState, useEffect } from 'react';
import {
  fetchExistingProductByGs,
  generateProductContent,
  saveExistingProductEdit,
  uploadImages,
  API_BASE_URL
} from '../services/api';

function normalizeGs(code = '') {
  return String(code || '').trim().toUpperCase();
}

function hasLookupCode(text) {
  return Boolean(normalizeGs(text));
}

function buildEditState(product = {}) {
  return {
    productName: product.productName || '',
    productOGCode: product.productOGCode || '',
    unit: product.unit || 'Piece',
    stockQuantity: product.stock || product.stockQuantity || 0,
    categoryID: product.categoryId || product.categoryID || '',
    subCategoryID: product.subCategoryId || product.subCategoryID || '',
    description: product.description || '',
    wholeSale: product.wholesale || product.wholeSale || 0,
    wholeSaleQuantity: product.wholesaleQuantity || product.wholeSaleQuantity || 0,
    retail: product.retail || 0,
    costPrice: product.costPrice || 0,
    manufacturerID: product.manufacturerId || product.manufacturerID || '',
    vendor: product.vendor || '',
    images: Array.isArray(product.images) ? product.images.filter(Boolean).slice(0, 4) : []
  };
}

function buildSavePayload(editData = {}, product = {}) {
  const payload = { ...(editData || {}) };
  const isVariantChild = Boolean(product?.isVariant && product?.parentProductId);

  if (isVariantChild) {
    delete payload.manufacturerID;
    delete payload.manufacturerId;
    delete payload.categoryID;
    delete payload.categoryId;
    delete payload.subCategoryID;
    delete payload.subCategoryId;
    delete payload.vendor;
  }

  return payload;
}

export default function ExistingProductRegenerateTab({ sellerId: sellerIdProp = '', userRole: userRoleProp = 'seller' }) {
  const [lookupCode, setLookupCode] = useState('');
  const [message, setMessage] = useState('Enter a product code to load an existing product.');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploadingImages, setUploadingImages] = useState(false);
  const [successNotice, setSuccessNotice] = useState('');
  const [regenerating, setRegenerating] = useState(false);
  const [resolvedCode, setResolvedCode] = useState('');
  const [product, setProduct] = useState(null);
  const [editData, setEditData] = useState(null);
  const [canEdit, setCanEdit] = useState(false);
  const [hasAccess, setHasAccess] = useState(false);
  const [categoriesList, setCategoriesList] = useState([]);
  const [categoriesLoading, setCategoriesLoading] = useState(true);
  const [subcategoriesList, setSubcategoriesList] = useState([]);
  const [subcategoriesLoading, setSubcategoriesLoading] = useState(false);
  React.useEffect(() => {
    const shouldWarn = regenerating;
    if (!shouldWarn) return undefined;

    const warningMessage = 'AI regeneration is in progress. Leaving now may interrupt it. Do you want to leave?';

    const onBeforeUnload = (e) => {
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
  }, [regenerating]);

  useEffect(() => {
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
    if (!editData?.categoryID) {
      setSubcategoriesList([]);
      return;
    }
    setSubcategoriesLoading(true);
    fetch(`${API_BASE_URL}/categories/${editData.categoryID}/subcategories`)
      .then((res) => res.json())
      .then((json) => {
        const list = Array.isArray(json) ? json : (json.subcategories || []);
        setSubcategoriesList(list);
      })
      .catch(() => setSubcategoriesList([]))
      .finally(() => setSubcategoriesLoading(false));
  }, [editData?.categoryID]);

  const sellerIdFromUrl = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('sellerId') || '';
  }, []);

  const actorId = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return String(
      params.get('actorId') ||
      params.get('adminId') ||
      params.get('userId') ||
      params.get('sellerId') ||
      ''
    ).trim();
  }, []);

  const sellerId = String(sellerIdProp || sellerIdFromUrl || '').trim();
  const role = String(userRoleProp || 'seller').toLowerCase();
  const isSeller = role === 'seller';

  const images = Array.isArray(editData?.images) ? editData.images.filter(Boolean).slice(0, 4) : [];
  const normalizedCode = normalizeGs(lookupCode);

  const handleLookup = async () => {
    setLoading(true);
    setMessage('Checking product...');
    setSuccessNotice('');
    setResolvedCode('');
    setProduct(null);
    setEditData(null);
    setCanEdit(false);
    setHasAccess(false);

    if (isSeller && !sellerId) {
      setMessage('Seller ID missing. Open this page from the dashboard context.');
      setLoading(false);
      return;
    }

    if (!hasLookupCode(normalizedCode)) {
      setMessage('Enter a code before loading. Any legacy or new code format is allowed.');
      setLoading(false);
      return;
    }

    const loadByGs = async () => fetchExistingProductByGs({
      code: normalizedCode,
      vendorId: isSeller ? sellerId : '',
      role
    });

    try {
      const data = await loadByGs();

      const resolved = normalizeGs(data.resolvedCode || data.product?.communetCode || normalizedCode);
      const editable = Boolean(data.canEdit);
      const mine = Boolean(data.isMine);

      setResolvedCode(resolved);
      setCanEdit(editable);
      setHasAccess(mine);

      if (!data.product) {
        setMessage('Product exists, but the product record could not be loaded.');
        return;
      }

      if (!mine) {
        setProduct(data.product || null);
        setMessage('You do not have access to this product code.');
        return;
      }

      const editableProduct = data.product || null;
      setProduct(editableProduct);
      setEditData(buildEditState(editableProduct || {}));
      setMessage(`Loaded product code ${resolved}. Code stays read-only; title and description can be regenerated.`);
    } catch (err) {
      const status = err.response?.status;
      const backendError = err.response?.data?.error || err.response?.data?.message;
      const errorMessage = status === 404
        ? 'No such product code in main product table.'
        : (backendError || err.message || 'Lookup failed');
      setMessage(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const handleFieldChange = (field, value) => {
    setEditData((prev) => ({ ...prev, [field]: value }));
  };

  const handleRegenerate = async () => {
    if (!editData) {
      setMessage('Load a product first.');
      return;
    }

    setRegenerating(true);
    setSuccessNotice('');
    setMessage('Regenerating title and description...');

    try {
      const result = await generateProductContent({
        product_name: editData.productName || '',
        brand: editData.manufacturerID || '',
        ean: editData.productOGCode || resolvedCode || '',
        category: editData.categoryID || '',
        subcategory: editData.subCategoryID || '',
        unit: editData.unit || '',
        wholesale_qty: editData.wholeSaleQuantity || '',
        price_wholesale: editData.wholeSale || '',
        price_retail: editData.retail || '',
        image_urls: images.join(',')
      });

      const uiData = result.generated_content || {};
      let combinedDescription = uiData.overview ? `${uiData.overview}\n\n` : '';

      if (Array.isArray(uiData.features) && uiData.features.length > 0) {
        combinedDescription += 'KEY FEATURES:\n';
        uiData.features.forEach((feature) => {
          if (String(feature).trim()) combinedDescription += `• ${String(feature).trim()}\n`;
        });
        combinedDescription += '\n';
      }

      if (uiData.detailed_description) {
        combinedDescription += `DETAILED DESCRIPTION:\n${uiData.detailed_description}\n\n`;
      }

      if (Array.isArray(uiData.specs) && uiData.specs.length > 0) {
        combinedDescription += 'TECHNICAL SPECIFICATIONS:\n';
        uiData.specs.forEach((spec) => {
          if (spec?.key && spec?.value) combinedDescription += `${spec.key}: ${spec.value}\n`;
        });
      }

      setEditData((prev) => ({
        ...prev,
        productName: uiData.seo_title || prev.productName,
        description: combinedDescription.trim() || prev.description
      }));
      setMessage('AI regeneration complete. Review the fields and save changes.');
    } catch (err) {
      setMessage(err.response?.data?.error || err.message || 'AI regeneration failed');
    } finally {
      setRegenerating(false);
    }
  };

  const handleSave = async () => {
    if (!product?.productId || !editData) {
      setMessage('Load a product first before saving.');
      return;
    }

    setSaving(true);
    setSuccessNotice('');
    setMessage('Saving product changes...');

    try {
      const savePayload = buildSavePayload(editData, product);
      const result = await saveExistingProductEdit({
        productId: product.productId,
        vendorId: isSeller ? sellerId : '',
        updateData: savePayload,
        actorRole: role,
        actorId
      });
      setMessage(result.message || 'Product updated successfully.');
      setSuccessNotice('Product saved successfully. Changes are now live in Product List.');
    } catch (err) {
      setMessage(err.response?.data?.error || err.response?.data?.message || err.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleImageUpload = async (event) => {
    if (!product?.productId || !editData) {
      setMessage('Load a product first.');
      event.target.value = '';
      return;
    }

    const pickedFiles = Array.from(event.target.files || []).filter((file) => file && String(file.type || '').startsWith('image/'));
    event.target.value = '';
    if (pickedFiles.length === 0) return;

    const availableSlots = Math.max(0, 4 - images.length);
    if (availableSlots === 0) {
      setMessage('Maximum 4 images are allowed. Remove an image before adding a new one.');
      return;
    }

    const filesToUpload = pickedFiles.slice(0, availableSlots);
    if (filesToUpload.length < pickedFiles.length) {
      setMessage(`Only ${availableSlots} image(s) were added because the maximum is 4.`);
    } else {
      setMessage(`Uploading ${filesToUpload.length} image(s). Uploaded images are auto-enhanced.`);
    }

    setUploadingImages(true);
    setSuccessNotice('');

    try {
      const uploadResult = await uploadImages(filesToUpload);
      const urls = Array.isArray(uploadResult?.urls) ? uploadResult.urls.filter(Boolean) : [];
      const fileErrors = Array.isArray(uploadResult?.fileErrors) ? uploadResult.fileErrors : [];

      if (urls.length === 0) {
        throw new Error('Image upload failed. Please try again.');
      }

      setEditData((prev) => {
        const existing = Array.isArray(prev?.images) ? prev.images.filter(Boolean).slice(0, 4) : [];
        const merged = [...existing, ...urls].slice(0, 4);
        return { ...prev, images: merged };
      });

      if (fileErrors.length > 0) {
        setMessage(`${urls.length} image(s) uploaded and enhanced. ${fileErrors.length} file(s) failed.`);
      } else {
        setMessage(`${urls.length} image(s) uploaded and enhanced.`);
      }
    } catch (err) {
      setMessage(err.response?.data?.error || err.response?.data?.message || err.message || 'Failed to upload images');
    } finally {
      setUploadingImages(false);
    }
  };

  const handleRemoveImageAt = (indexToRemove) => {
    setEditData((prev) => {
      const current = Array.isArray(prev?.images) ? prev.images.filter(Boolean).slice(0, 4) : [];
      return { ...prev, images: current.filter((_, idx) => idx !== indexToRemove) };
    });
    setMessage('Image removed from form. Click Save Changes to persist this update.');
    setSuccessNotice('');
  };

  return (
    <div className="space-y-5">
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h2 className="text-lg font-bold text-blue-900">Existing Product Regenerate</h2>
        <p className="text-sm text-blue-800 mt-1">
          Enter a product code first. If the product belongs to your account, the form will prefill and the code will stay read-only.
        </p>
      </div>

      <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-3">
        <label className="block text-sm font-semibold text-gray-700">Product Code</label>
        <div className="flex gap-2">
          <input
            value={lookupCode}
            onChange={(e) => setLookupCode(e.target.value)}
            placeholder="CODE2604000001"
            className="flex-1 border border-gray-300 rounded px-3 py-2 font-mono"
          />
          <button
            type="button"
            onClick={handleLookup}
            disabled={loading}
            className="bg-blue-700 text-white px-4 py-2 rounded font-semibold hover:bg-blue-800 disabled:opacity-50"
          >
            {loading ? 'Checking...' : 'Load'}
          </button>
        </div>
        <p className="text-sm text-gray-700">{message}</p>
      </div>

      {canEdit && editData && product && (
        <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-4">
          <h3 className="font-semibold text-gray-900">Editable Product</h3>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-600">Product Code (read-only)</label>
              <input
                value={resolvedCode || product.communetCode || ''}
                readOnly
                className="w-full border border-gray-300 rounded px-3 py-2 font-mono bg-gray-100"
              />
            </div>
            <div>
              <label className="text-xs text-gray-600">Product Name</label>
              <input
                value={editData.productName}
                onChange={(e) => handleFieldChange('productName', e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2"
              />
            </div>
            <div>
              <label className="text-xs text-gray-600">Product Code</label>
              <input
                value={editData.productOGCode}
                onChange={(e) => handleFieldChange('productOGCode', e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2"
              />
            </div>
            <div>
              <label className="text-xs text-gray-600">Unit</label>
              <select
                value={editData.unit}
                onChange={(e) => handleFieldChange('unit', e.target.value)}
                className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
              >
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
              <label className="text-xs text-gray-600">Stock Quantity</label>
              <input
                type="number"
                value={editData.stockQuantity}
                onChange={(e) => handleFieldChange('stockQuantity', e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2"
              />
            </div>
            <div>
              <label className="text-xs text-gray-600">Wholesale Price</label>
              <input
                type="number"
                value={editData.wholeSale}
                onChange={(e) => handleFieldChange('wholeSale', e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2"
              />
            </div>
            <div>
              <label className="text-xs text-gray-600">Wholesale Quantity</label>
              <input
                type="number"
                value={editData.wholeSaleQuantity}
                onChange={(e) => handleFieldChange('wholeSaleQuantity', e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2"
              />
            </div>
            <div>
              <label className="text-xs text-gray-600">Retail Price</label>
              <input
                type="number"
                value={editData.retail}
                onChange={(e) => handleFieldChange('retail', e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2"
              />
            </div>
            <div>
              <label className="text-xs text-gray-600">Partner Price</label>
              <input
                type="number"
                value={editData.costPrice}
                onChange={(e) => handleFieldChange('costPrice', e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2"
              />
            </div>
            <div>
              <label className="text-xs text-gray-600">Manufacturer ID</label>
              <input
                value={editData.manufacturerID}
                onChange={(e) => handleFieldChange('manufacturerID', e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2"
              />
            </div>
            <div>
              <label className="text-xs text-gray-600">Category ID</label>
              <select
                value={editData.categoryID}
                onChange={(e) => {
                  handleFieldChange('categoryID', e.target.value);
                  handleFieldChange('subCategoryID', '');
                }}
                className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
                disabled={categoriesLoading}
              >
                <option value="">{categoriesLoading ? 'Loading...' : '-- Select Category --'}</option>
                {categoriesList.map(cat => (
                  <option key={cat.categoryId} value={cat.categoryId}>{cat.categoryName}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-600">Subcategory ID</label>
              <select
                value={editData.subCategoryID}
                onChange={(e) => handleFieldChange('subCategoryID', e.target.value)}
                className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
                disabled={!editData.categoryID || subcategoriesLoading}
              >
                <option value="">{subcategoriesLoading ? 'Loading...' : '-- Select Subcategory --'}</option>
                {subcategoriesList.map(sub => (
                  <option key={sub.categoryId} value={sub.categoryId}>{sub.categoryName}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="text-xs text-gray-600">Description</label>
            <textarea
              value={editData.description}
              onChange={(e) => handleFieldChange('description', e.target.value)}
              rows={6}
              className="w-full border border-gray-300 rounded px-3 py-2"
            />
          </div>

          <div>
            <div className="flex items-center justify-between gap-3 mb-2">
              <h4 className="text-sm font-semibold text-gray-900">Images</h4>
              <span className="text-xs text-gray-500">{images.length} image(s)</span>
            </div>

            <div className="mb-3 rounded border border-blue-200 bg-blue-50 p-3">
              <label className="block text-xs font-semibold text-blue-900 mb-2">Add Images (max 4 total)</label>
              <input
                type="file"
                multiple
                accept="image/*"
                onChange={handleImageUpload}
                disabled={uploadingImages || saving || regenerating}
                className="w-full border border-blue-200 rounded px-3 py-2 text-sm bg-white disabled:opacity-50"
              />
              <p className="mt-2 text-[11px] text-blue-800">
                All newly uploaded images are automatically enhanced before being saved.
              </p>
            </div>

            {images.length > 0 ? (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {images.map((src, idx) => (
                  <div key={`${src}-${idx}`} className="relative aspect-square rounded-lg overflow-hidden border border-gray-200 bg-gray-50">
                    <img src={src} alt={`Product ${idx + 1}`} className="w-full h-full object-cover" />
                    <button
                      type="button"
                      onClick={() => handleRemoveImageAt(idx)}
                      disabled={uploadingImages || saving || regenerating}
                      className="absolute right-1 top-1 rounded bg-red-600/90 px-2 py-1 text-[10px] font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-gray-500 italic">No images available.</p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleRegenerate}
              disabled={regenerating || saving || uploadingImages}
              className="bg-violet-700 text-white px-4 py-2 rounded font-semibold hover:bg-violet-800 disabled:opacity-50"
            >
              {regenerating ? 'Regenerating...' : 'Regenerate AI Title + Description'}
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || regenerating || uploadingImages}
              className="bg-emerald-700 text-white px-4 py-2 rounded font-semibold hover:bg-emerald-800 disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>

          {successNotice && (
            <div className="rounded border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
              {successNotice}
            </div>
          )}
        </div>
      )}

      {resolvedCode && !canEdit && hasAccess === false && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
          This product was found, but you do not have permission to edit it from this account.
        </div>
      )}
    </div>
  );
}