import React, { useRef, useState } from 'react';
import { finalizeProduct } from '../services/api';

export default function ReviewEditStep({ formData, setFormData, generatedContent, setGeneratedContent, uploadedUrls, uploadedTempMediaIds, vendorInfo, onBack, onSaved }) {
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [overrideApplied, setOverrideApplied] = useState(false);
  const [assignedCommunetsCode, setAssignedCommunetsCode] = useState('');
  const idempotencyKeyRef = useRef((typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `fallback-${Date.now()}-${Math.random().toString(16).slice(2)}`);

  const uiData = generatedContent?.generated_content || {};

  const handleTextChange = (field, value) => {
    setGeneratedContent(prev => ({
      ...prev,
      generated_content: { ...prev.generated_content, [field]: value }
    }));
  };

  const updateFeature = (index, value) => {
    const newFeatures = [...uiData.features];
    newFeatures[index] = value;
    handleTextChange('features', newFeatures);
  };
  const addFeature = () => handleTextChange('features', [...(uiData.features || []), ""]);
  const removeFeature = (index) => handleTextChange('features', uiData.features.filter((_, i) => i !== index));

  const updateSpec = (index, key, value) => {
    const newSpecs = [...uiData.specs];
    newSpecs[index] = { key, value };
    handleTextChange('specs', newSpecs);
  };
  const addSpec = () => handleTextChange('specs', [...(uiData.specs || []), { key: "", value: "" }]);
  const removeSpec = (index) => handleTextChange('specs', uiData.specs.filter((_, i) => i !== index));

  const handleFinalize = async () => {
    setIsSaving(true);

    // 1. Build the Combined Description String
    let combinedDescription = uiData.manual_combined;
    
    if (combinedDescription === undefined) {
      combinedDescription = uiData.overview ? `${uiData.overview}\n\n` : '';
      
      if (uiData.features && uiData.features.length > 0) {
        combinedDescription += "KEY FEATURES:\n";
        uiData.features.forEach(f => {
          if (f.trim()) combinedDescription += `• ${f}\n`;
        });
        combinedDescription += "\n";
      }

      if (uiData.detailed_description) {
        combinedDescription += `DETAILED DESCRIPTION:\n${uiData.detailed_description}\n\n`;
      }

      if (uiData.specs && uiData.specs.length > 0) {
        combinedDescription += "TECHNICAL SPECIFICATIONS:\n";
        uiData.specs.forEach(s => {
          if (s.key && s.value) combinedDescription += `${s.key}: ${s.value}\n`;
        });
      }
    }

    // 2. Map to the Native MongoDB Schema
    const payload = {
      vendorId: vendorInfo?.added_by,
      productData: {
        productName: uiData.seo_title || formData.productName || '',
        categoryID: formData.category || 'General',
        subCategoryID: formData.subcategory || undefined,
        brand: formData.brand || '',
        unit: formData.unit || 'Piece',
        retail: parseFloat(formData.priceRetail) || 0,
        wholeSale: parseFloat(formData.priceWholesale) || 0,
        wholeSaleQuantity: parseInt(formData.wholesaleQty) || 1,
        stockQuantity: parseInt(formData.stockQty) || 0,
        description: combinedDescription.trim(),
        costPrice: parseFloat(formData.costPrice) || null,
        productOGCode: formData.productOGCode || null,
        preUploadedImages: JSON.stringify(uploadedUrls),
        preUploadedTempMediaIds: JSON.stringify(uploadedTempMediaIds || []),
        idempotencyKey: idempotencyKeyRef.current,
      }
    };

    try {
      const finalizeRes = await finalizeProduct(payload);
      const newCode = String(finalizeRes?.product?.communetCode || '').trim();
      setAssignedCommunetsCode(newCode);
      setOverrideApplied(Boolean(finalizeRes?.overrideApplied));
      setSaveSuccess(true);
      if (typeof onSaved === 'function') {
        onSaved();
      }
    } catch (err) {
      const backendErrorMsg = err.response?.data?.error || err.message;
      alert("Error saving: " + backendErrorMsg);
    } finally {
      setIsSaving(false);
    }
  };

  if (saveSuccess) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-center animation-fade-in">
        <div className={`w-20 h-20 ${overrideApplied ? 'bg-orange-100 text-orange-500' : 'bg-green-100 text-green-500'} rounded-full flex items-center justify-center text-4xl mb-6 shadow-sm`}>
          {overrideApplied ? '🔄' : '✓'}
        </div>
        <h2 className="text-3xl font-bold text-navy mb-3">
          {overrideApplied ? 'Product Updated!' : 'Product Successfully Registered!'}
        </h2>
        <p className="text-gray-600 mb-6 max-w-md">
          {overrideApplied
            ? <>EAN/SKU already existed — <strong>{formData.productName}</strong> was <strong>updated</strong> instead of creating a duplicate. ✅</>
            : <>Your product <strong>{formData.productName}</strong> has been saved to the catalog.</>
          }
        </p>
        {assignedCommunetsCode && (
          <div className={`${overrideApplied ? 'bg-orange-50 border-orange-300' : 'bg-blue-50 border-blue-300'} border rounded-lg p-4 mb-8 max-w-md`}>
            <p className={`text-xs ${overrideApplied ? 'text-orange-600' : 'text-blue-600'} mb-1 font-semibold uppercase`}>
              {overrideApplied ? '🔄 Existing Product Code' : 'Product Code Assigned'}
            </p>
            <p className={`text-lg font-mono font-bold ${overrideApplied ? 'text-orange-900' : 'text-blue-900'}`}>{assignedCommunetsCode}</p>
          </div>
        )}
        <button onClick={() => window.location.reload()} className="bg-blue-800 text-white font-bold py-3 px-8 rounded-lg hover:bg-blue-700">
          List Another Product
        </button>
      </div>
    );
  }

  return (
    <div className="animation-fade-in">
      <div className="flex items-center gap-3 mb-6 bg-yellow-50 text-yellow-800 p-4 rounded-lg">
        <span className="text-2xl">⚡</span>
        <div>
          <h2 className="text-sm font-bold">Review Final Product Listing</h2>
          <p className="text-xs opacity-80">This is exactly how the data will be appended to the vendor's Excel catalog.</p>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden mb-8">
        <div className="bg-gray-50 px-4 py-3 border-b border-gray-200">
          <h3 className="font-bold text-navy">Vendor Catalog: {vendorInfo?.sheet_filename}</h3>
        </div>
        <div className="divide-y divide-gray-100">
          {(() => {
            const fields = [
              { label: '1. Added by', value: vendorInfo?.added_by, readonly: true },
              { label: '2. Product Name', value: uiData.seo_title || formData.productName, 
                onChange: (v) => handleTextChange('seo_title', v) },
              { label: '3. Product Code', value: formData.productOGCode,
                onChange: (v) => setFormData(prev => ({...prev, productOGCode: v})) },
              { label: '4. Unit', value: formData.unit,
                onChange: (v) => setFormData(prev => ({...prev, unit: v})) },
              { label: '5. Stock Quantity', value: formData.stockQty,
                onChange: (v) => setFormData(prev => ({...prev, stockQty: v})) },
              { label: '6. Category', value: formData.category,
                onChange: (v) => setFormData(prev => ({...prev, category: v})) },
              { label: '7. Sub Category', value: formData.subcategory,
                onChange: (v) => setFormData(prev => ({...prev, subcategory: v})) },
              { label: '8. Wholesale Price', value: formData.priceWholesale,
                onChange: (v) => setFormData(prev => ({...prev, priceWholesale: v})), prefix: '₹' },
              { label: '9. Wholesale Quantity', value: formData.wholesaleQty,
                onChange: (v) => setFormData(prev => ({...prev, wholesaleQty: v})) },
              { label: '10. Retail Price', value: formData.priceRetail,
                onChange: (v) => setFormData(prev => ({...prev, priceRetail: v})), prefix: '₹' },
              { label: '11. Vendor Details', value: vendorInfo?.vendor_details, readonly: true },
              { label: '12. Vendor Contact', value: vendorInfo?.vendor_contact, readonly: true },
              { label: '13. Partner Price', value: formData.costPrice,
                onChange: (v) => setFormData(prev => ({...prev, costPrice: v})), prefix: '₹' },
              { label: '14. Brand/Manufacture', value: formData.brand,
                onChange: (v) => setFormData(prev => ({...prev, brand: v})) },
            ];

            return fields.map((item, idx) => (
              <div key={idx} className="flex flex-col sm:flex-row px-4 py-3 hover:bg-slate-50 items-start sm:items-center gap-1 sm:gap-4">
                <div className="w-full sm:w-1/3 text-sm font-semibold text-gray-500">{item.label}</div>
                <div className="w-full sm:w-2/3 flex items-center gap-2">
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
            ));
          })()}
        </div>
      </div>

      <div className="space-y-6">
        <div>
          <h3 className="text-sm font-bold text-navy mb-2 flex items-center justify-between">
            <span>15. Combined Description (Editable)</span>
            <button 
              onClick={() => {
                // Re-compile from parts
                let combined = uiData.overview ? `${uiData.overview}\n\n` : '';
                if (uiData.features?.length > 0) combined += "KEY FEATURES:\n" + uiData.features.map(f => `• ${f}`).join('\n') + "\n\n";
                if (uiData.detailed_description) combined += `DETAILED DESCRIPTION:\n${uiData.detailed_description}\n\n`;
                if (uiData.specs?.length > 0) combined += "TECHNICAL SPECIFICATIONS:\n" + uiData.specs.map(s => `${s.key}: ${s.value}`).join('\n');
                handleTextChange('manual_combined', combined);
              }}
              className="text-xs bg-blue-100 text-blue-700 px-3 py-1 rounded hover:bg-blue-200 transition font-medium"
            >
              Reset to AI Output
            </button>
          </h3>
          <textarea
            className="w-full bg-white border border-gray-300 rounded-lg p-4 text-sm text-gray-700 font-mono focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
            rows={12}
            value={
              uiData.manual_combined !== undefined ? uiData.manual_combined : 
              (uiData.overview ? `${uiData.overview}\n\n` : '') +
              (uiData.features?.length > 0 ? "KEY FEATURES:\n" + uiData.features.map(f => `• ${f}`).join('\n') + "\n\n" : '') +
              (uiData.detailed_description ? `DETAILED DESCRIPTION:\n${uiData.detailed_description}\n\n` : '') +
              (uiData.specs?.length > 0 ? "TECHNICAL SPECIFICATIONS:\n" + uiData.specs.map(s => `${s.key}: ${s.value}`).join('\n') : '')
            }
            onChange={(e) => handleTextChange('manual_combined', e.target.value)}
            placeholder="Combined description content..."
          />
        </div>

        <div>
           <h3 className="text-sm font-bold text-navy mb-2">16-19. Product Images</h3>
           <div className="flex gap-4">
             {uploadedUrls.length > 0 ? uploadedUrls.map((url, i) => (
               <div key={i} className="w-24 h-24 rounded border border-gray-200 overflow-hidden relative">
                 <img src={url} alt={`Product ${i+1}`} className="w-full h-full object-cover" />
                 <span className="absolute bottom-0 inset-x-0 bg-black/60 text-white text-[10px] text-center font-bold py-1">Img {i+1}</span>
               </div>
             )) : <span className="text-sm italic text-gray-400">No images uploaded. Default product image will be shown automatically.</span>}
           </div>
        </div>
      </div>

      <div className="mt-8 pt-6 border-t border-gray-200 flex justify-between">
        <button type="button" onClick={onBack} className="bg-gray-200 hover:bg-gray-300 text-gray-800 font-bold py-3 px-6 rounded-lg transition-colors">
          ← Back
        </button>
        <button 
          onClick={handleFinalize} 
          disabled={isSaving}
          className="bg-green-600 hover:bg-green-500 text-white font-bold py-3 px-8 rounded-lg shadow-lg flex items-center gap-2 transition disabled:opacity-50"
        >
          {isSaving ? '⏳ Appending to Excel...' : '✅ Confirm & Save to Catalog'}
        </button>
      </div>
    </div>
  );
}
