import React, { useMemo, useState, useEffect } from 'react';
import {
  searchProductsForVariant,
  fetchVariantParent,
  generateProductContent,
  finalizeVariant,
  uploadImages,
  API_BASE_URL,
} from '../services/api';

export default function VariantCreateTab({ sellerId: sellerIdProp = '', userRole: userRoleProp = 'seller' }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchMessage, setSearchMessage] = useState('Search by product name, new GS code, or old GS code.');

  const [selectedParent, setSelectedParent] = useState(null);
  const [loadingParent, setLoadingParent] = useState(false);

  const [formData, setFormData] = useState({
    productName: '',
    productOGCode: '',
    unit: 'Piece',
    stockQuantity: '',
    wholeSaleQuantity: '',
    wholeSale: '',
    retail: '',
    costPrice: '',
    description: '',
    images: [],
  });

  const [generatedTitle, setGeneratedTitle] = useState('');
  const [generatedDescription, setGeneratedDescription] = useState('');

  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [categoriesList, setCategoriesList] = useState([]);
  const [categoriesLoading, setCategoriesLoading] = useState(true);
  const [subcategoriesList, setSubcategoriesList] = useState([]);
  const [subcategoriesLoading, setSubcategoriesLoading] = useState(false);

  const role = String(userRoleProp || 'seller').toLowerCase();
  const sellerId = String(sellerIdProp || '').trim();

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
    if (!selectedParent?.categoryId) {
      setSubcategoriesList([]);
      return;
    }
    setSubcategoriesLoading(true);
    fetch(`${API_BASE_URL}/categories/${selectedParent.categoryId}/subcategories`)
      .then((res) => res.json())
      .then((json) => {
        const list = Array.isArray(json) ? json : (json.subcategories || []);
        setSubcategoriesList(list);
      })
      .catch(() => setSubcategoriesList([]))
      .finally(() => setSubcategoriesLoading(false));
  }, [selectedParent?.categoryId]);

  const canSearch = useMemo(() => query.trim().length >= 2, [query]);

  const handleSearch = async () => {
    if (!canSearch) {
      setSearchMessage('Type at least 2 characters to search.');
      return;
    }

    setSearching(true);
    setSearchMessage('Searching products...');
    try {
      const data = await searchProductsForVariant({ q: query.trim(), vendorId: sellerId, role });
      const products = Array.isArray(data?.products) ? data.products : [];
      setResults(products);
      setSearchMessage(products.length > 0 ? `Found ${products.length} products.` : 'No matching products found.');
    } catch (err) {
      setSearchMessage(err.response?.data?.error || err.message || 'Search failed');
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  const loadParent = async (productId) => {
    setLoadingParent(true);
    setStatus('Loading selected parent...');
    try {
      const product = await fetchVariantParent(productId);
      setSelectedParent(product || null);
      setFormData({
        productName: product?.productName || '',
        productOGCode: '',
        unit: product?.unit || 'Piece',
        stockQuantity: product?.stock || '',
        wholeSaleQuantity: product?.wholesaleQuantity || '',
        wholeSale: product?.wholesale || '',
        retail: product?.retail || '',
        costPrice: product?.costPrice || '',
        description: product?.description || '',
        images: Array.isArray(product?.images) ? product.images.filter(Boolean).slice(0, 4) : [],
      });
      setGeneratedTitle('');
      setGeneratedDescription('');
      setStatus('Parent loaded. Generate AI content, then save copy listing.');
    } catch (err) {
      setStatus(err.response?.data?.error || err.message || 'Failed to load parent');
    } finally {
      setLoadingParent(false);
    }
  };

  const updateField = (name, value) => {
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleImageUpload = async (event) => {
    const pickedFiles = Array.from(event.target.files || []).filter((file) => file && String(file.type || '').startsWith('image/'));
    event.target.value = '';

    if (pickedFiles.length === 0) return;

    const currentImages = Array.isArray(formData.images) ? formData.images.filter(Boolean).slice(0, 4) : [];
    const availableSlots = Math.max(0, 4 - currentImages.length);

    if (availableSlots === 0) {
      setStatus('Maximum 4 images are allowed. Remove an image before adding a new one.');
      return;
    }

    const filesToUpload = pickedFiles.slice(0, availableSlots);
    if (filesToUpload.length < pickedFiles.length) {
      setStatus(`Only ${availableSlots} image(s) were added because the maximum is 4.`);
    } else {
      setStatus(`Uploading ${filesToUpload.length} image(s). Uploaded images are auto-enhanced.`);
    }

    try {
      const uploadResult = await uploadImages(filesToUpload);
      const urls = Array.isArray(uploadResult?.urls) ? uploadResult.urls.filter(Boolean) : [];
      const fileErrors = Array.isArray(uploadResult?.fileErrors) ? uploadResult.fileErrors : [];

      if (urls.length === 0) {
        throw new Error('Image upload failed. Please try again.');
      }

      updateField('images', [...currentImages, ...urls].slice(0, 4));
      if (fileErrors.length > 0) {
        setStatus(`${urls.length} image(s) uploaded and enhanced. ${fileErrors.length} file(s) failed.`);
      } else {
        setStatus(`${urls.length} image(s) uploaded and enhanced.`);
      }
    } catch (err) {
      setStatus(err.response?.data?.error || err.response?.data?.message || err.message || 'Failed to upload images');
    }
  };

  const handleRemoveImageAt = (indexToRemove) => {
    const currentImages = Array.isArray(formData.images) ? formData.images.filter(Boolean).slice(0, 4) : [];
    updateField('images', currentImages.filter((_, idx) => idx !== indexToRemove));
    setStatus('Image removed from form. Save Copy Listing to persist this update.');
  };

  const handleGenerate = async () => {
    if (!selectedParent?.productId) {
      setStatus('Select a parent product first.');
      return;
    }

    setGenerating(true);
    setStatus('Generating AI title and description...');
    try {
      const result = await generateProductContent({
        product_name: formData.productName || selectedParent.productName || '',
        brand: selectedParent?.manufacturerId || '',
        ean: formData.productOGCode || selectedParent?.productOGCode || selectedParent?.communetCode || '',
        category: selectedParent?.categoryId || '',
        subcategory: selectedParent?.subCategoryId || '',
        unit: formData.unit || selectedParent?.unit || 'Piece',
        wholesale_qty: formData.wholeSaleQuantity || '',
        price_wholesale: formData.wholeSale || '',
        price_retail: formData.retail || '',
        image_urls: (Array.isArray(formData.images) ? formData.images : []).filter(Boolean).join(','),
      });

      const content = result?.generated_content || {};
      const title = String(content.seo_title || '').trim();

      let combinedDescription = String(content.overview || '').trim();
      if (Array.isArray(content.features) && content.features.length > 0) {
        combinedDescription += `${combinedDescription ? '\n\n' : ''}KEY FEATURES:\n`;
        combinedDescription += content.features.map((f) => `• ${String(f).trim()}`).join('\n');
      }
      if (content.detailed_description) {
        combinedDescription += `${combinedDescription ? '\n\n' : ''}DETAILED DESCRIPTION:\n${String(content.detailed_description).trim()}`;
      }
      if (Array.isArray(content.specs) && content.specs.length > 0) {
        combinedDescription += `${combinedDescription ? '\n\n' : ''}TECHNICAL SPECIFICATIONS:\n`;
        combinedDescription += content.specs
          .filter((s) => s?.key && s?.value)
          .map((s) => `${String(s.key).trim()}: ${String(s.value).trim()}`)
          .join('\n');
      }

      setGeneratedTitle(title);
      setGeneratedDescription(combinedDescription.trim());
      if (title) {
        updateField('productName', title);
      }
      if (combinedDescription.trim()) {
        updateField('description', combinedDescription.trim());
      }
      setStatus('AI generation completed. Review values and save copy listing.');
    } catch (err) {
      setStatus(err.response?.data?.error || err.message || 'AI generation failed');
    } finally {
      setGenerating(false);
    }
  };

  const handleSaveVariant = async () => {
    if (!selectedParent?.productId) {
      setStatus('Select a parent product first.');
      return;
    }

    setSaving(true);
    setStatus('Saving copy listing...');
    try {
      const payload = {
        vendorId: sellerId,
        parentProductId: selectedParent.productId,
        actorRole: role,
        actorId: sellerId,
        variantAttributes: {},
        productData: {
          productName: formData.productName,
          productOGCode: formData.productOGCode,
          unit: formData.unit,
          stockQuantity: Number(formData.stockQuantity || 0),
          wholeSaleQuantity: Number(formData.wholeSaleQuantity || 0),
          wholeSale: Number(formData.wholeSale || 0),
          retail: Number(formData.retail || 0),
          costPrice: Number(formData.costPrice || 0),
          description: formData.description,
          image_urls: (Array.isArray(formData.images) ? formData.images : []).filter(Boolean).join(','),
        },
      };

      const result = await finalizeVariant(payload);
      const productCode = result?.product?.communetCode || 'N/A';
      setStatus(`Copy listing created successfully. New Communets code: ${productCode}`);
    } catch (err) {
      setStatus(err.response?.data?.error || err.message || 'Variant save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-4">
        <h2 className="text-lg font-bold text-indigo-900">Create Copy Listing via AI Pipeline</h2>
        <p className="text-sm text-indigo-800 mt-1">
          Search parent product by product name, new GS code, or old GS code. Parent category, subcategory, brand, and vendor are inherited and locked.
        </p>
      </div>

      <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-3">
        <label className="block text-sm font-semibold text-gray-700">Search Parent Product</label>
        <div className="flex gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type product name, GS code, or old GS code"
            className="flex-1 border border-gray-300 rounded px-3 py-2"
          />
          <button
            type="button"
            onClick={handleSearch}
            disabled={searching || !canSearch}
            className="bg-blue-700 text-white px-4 py-2 rounded font-semibold hover:bg-blue-800 disabled:opacity-50"
          >
            {searching ? 'Searching...' : 'Search'}
          </button>
        </div>
        <p className="text-sm text-gray-700">{searchMessage}</p>

        {results.length > 0 && (
          <div className="border border-gray-200 rounded-lg overflow-hidden">
            <div className="max-h-64 overflow-y-auto">
              {results.map((item) => (
                <button
                  key={item.productId}
                  type="button"
                  onClick={() => loadParent(item.productId)}
                  className="w-full text-left p-3 border-b border-gray-100 hover:bg-gray-50"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-semibold text-gray-900">{item.productName}</div>
                  </div>
                  <div className="text-xs text-gray-600">
                    New GS: {item.communetCode || 'N/A'} | Old GS: {item.legacyGsCode || 'N/A'} | Product ID: {item.productId}
                  </div>
                  {item.categoryName && (
                    <div className="mt-1 text-[11px] font-medium text-indigo-700">Category: {item.categoryName}</div>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {loadingParent && <div className="text-sm text-gray-600">Loading selected parent...</div>}

      {selectedParent && (
        <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-4">
          <h3 className="font-semibold text-gray-900">Selected Parent</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-600">Parent Product Name</label>
              <input value={selectedParent.productName || ''} readOnly className="w-full bg-gray-100 border border-gray-300 rounded px-3 py-2" />
            </div>
            <div>
              <label className="text-xs text-gray-600">Parent New GS</label>
              <input value={selectedParent.communetCode || ''} readOnly className="w-full bg-gray-100 border border-gray-300 rounded px-3 py-2 font-mono" />
            </div>
            <div>
              <label className="text-xs text-gray-600">Category (Locked)</label>
              <input value={selectedParent.categoryId || ''} readOnly className="w-full bg-gray-100 border border-gray-300 rounded px-3 py-2" />
            </div>
            <div>
              <label className="text-xs text-gray-600">Subcategory (Locked)</label>
              <input value={selectedParent.subCategoryId || ''} readOnly className="w-full bg-gray-100 border border-gray-300 rounded px-3 py-2" />
            </div>
            <div>
              <label className="text-xs text-gray-600">Brand/Manufacturer (Locked)</label>
              <input value={selectedParent.manufacturerId || ''} readOnly className="w-full bg-gray-100 border border-gray-300 rounded px-3 py-2" />
            </div>
            <div>
              <label className="text-xs text-gray-600">Vendor (Locked)</label>
              <input value={selectedParent.vendor || ''} readOnly className="w-full bg-gray-100 border border-gray-300 rounded px-3 py-2" />
            </div>
          </div>

          <h4 className="font-semibold text-gray-900">Variant Editable Fields</h4>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-600">Product Name</label>
              <input value={formData.productName} onChange={(e) => updateField('productName', e.target.value)} className="w-full border border-gray-300 rounded px-3 py-2" />
            </div>
            <div>
              <label className="text-xs text-gray-600">Product Code</label>
              <input value={formData.productOGCode} onChange={(e) => updateField('productOGCode', e.target.value)} className="w-full border border-gray-300 rounded px-3 py-2" />
            </div>
            <div>
              <label className="text-xs text-gray-600">Unit</label>
              <select value={formData.unit} onChange={(e) => updateField('unit', e.target.value)} className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none">
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
              <input type="number" value={formData.stockQuantity} onChange={(e) => updateField('stockQuantity', e.target.value)} className="w-full border border-gray-300 rounded px-3 py-2" />
            </div>
            <div>
              <label className="text-xs text-gray-600">Wholesale Quantity</label>
              <input type="number" value={formData.wholeSaleQuantity} onChange={(e) => updateField('wholeSaleQuantity', e.target.value)} className="w-full border border-gray-300 rounded px-3 py-2" />
            </div>
            <div>
              <label className="text-xs text-gray-600">Wholesale Price</label>
              <input type="number" value={formData.wholeSale} onChange={(e) => updateField('wholeSale', e.target.value)} className="w-full border border-gray-300 rounded px-3 py-2" />
            </div>
            <div>
              <label className="text-xs text-gray-600">Retail Price</label>
              <input type="number" value={formData.retail} onChange={(e) => updateField('retail', e.target.value)} className="w-full border border-gray-300 rounded px-3 py-2" />
            </div>
            <div>
              <label className="text-xs text-gray-600">Partner Price</label>
              <input type="number" value={formData.costPrice} onChange={(e) => updateField('costPrice', e.target.value)} className="w-full border border-gray-300 rounded px-3 py-2" />
            </div>
          </div>

          <div>
            <label className="text-xs text-gray-600">Description</label>
            <textarea
              value={formData.description}
              onChange={(e) => updateField('description', e.target.value)}
              rows={6}
              className="w-full border border-gray-300 rounded px-3 py-2"
            />
          </div>

          <div className="md:col-span-2">
            <label className="text-xs text-gray-600">Images</label>
            <div className="mt-2 flex flex-wrap gap-3">
              {(Array.isArray(formData.images) ? formData.images : []).filter(Boolean).slice(0, 4).map((imageUrl, index) => (
                <div key={`${imageUrl}-${index}`} className="relative h-24 w-24 overflow-hidden rounded-lg border border-gray-200 bg-gray-50">
                  <img src={imageUrl} alt={`Variant ${index + 1}`} className="h-full w-full object-cover" />
                  <button
                    type="button"
                    onClick={() => handleRemoveImageAt(index)}
                    className="absolute right-1 top-1 rounded-full bg-white/90 px-2 py-0.5 text-[10px] font-semibold text-red-600 shadow hover:bg-white"
                  >
                    Remove
                  </button>
                </div>
              ))}
              {Array.from({ length: Math.max(0, 4 - (Array.isArray(formData.images) ? formData.images.filter(Boolean).length : 0)) }).map((_, index) => (
                <label key={`upload-slot-${index}`} className="flex h-24 w-24 cursor-pointer items-center justify-center rounded-lg border-2 border-dashed border-gray-300 bg-gray-50 text-center text-xs font-medium text-gray-500 hover:border-blue-400 hover:text-blue-600">
                  <div>
                    <div className="text-lg leading-none">+</div>
                    <div>Add Image</div>
                  </div>
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={handleImageUpload}
                    className="hidden"
                  />
                </label>
              ))}
            </div>
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={handleGenerate}
              disabled={generating}
              className="bg-indigo-700 text-white px-4 py-2 rounded font-semibold hover:bg-indigo-800 disabled:opacity-50"
            >
              {generating ? 'Generating...' : 'Generate AI Title & Description'}
            </button>
            <button
              type="button"
              onClick={handleSaveVariant}
              disabled={saving}
              className="bg-green-700 text-white px-4 py-2 rounded font-semibold hover:bg-green-800 disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save Copy Listing'}
            </button>
          </div>

          {(generatedTitle || generatedDescription) && (
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-3">
              <h5 className="font-semibold text-gray-900 mb-1">AI Output Preview</h5>
              {generatedTitle && <p className="text-sm"><strong>Title:</strong> {generatedTitle}</p>}
              {generatedDescription && <p className="text-sm mt-2 whitespace-pre-line"><strong>Description:</strong> {generatedDescription}</p>}
            </div>
          )}
        </div>
      )}

      {status && (
        <div className="text-sm text-gray-700 bg-blue-50 border border-blue-200 rounded-lg p-3">
          {status}
        </div>
      )}
    </div>
  );
}
