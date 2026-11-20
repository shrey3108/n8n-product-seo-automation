import React, { useState, useEffect } from 'react';
import ProductInfoStep from './components/ProductInfoStep';
import PricingStep from './components/PricingStep';
import ImageUploadStep from './components/ImageUploadStep';
import ReviewEditStep from './components/ReviewEditStep';
import BulkImportPage from './components/BulkImportPage';
import ReservedGsMappingPage from './components/ReservedGsMappingPage';
import ExistingProductRegenerateTab from './components/ExistingProductRegenerateTab';
import VariantCreateTab from './components/VariantCreateTab';
import './index.css';

const SINGLE_DRAFT_KEY = 'ai-single-import-draft-v1';

function App() {
  const [mode, setMode] = useState('single'); // single | bulk | product-codes
  const [isEmbedded, setIsEmbedded] = useState(false);
  const [currentStep, setCurrentStep] = useState(0); // 0 is now Product Info
  const [singleTab, setSingleTab] = useState('new');
  const [vendorInfo, setVendorInfo] = useState({ added_by: '' });
  const [userRole, setUserRole] = useState('admin'); // seller | admin | superadmin

  useEffect(() => {
    // Read ?sellerId=... from URL when coming from Communets Dashboard
    const params = new URLSearchParams(window.location.search);
    const sellerId = params.get('sellerId');
    const email = params.get('email');
    const urlMode = params.get('mode');
    const urlSingleTab = params.get('singleTab');
    const embed = params.get('embed');
    const roleParam = (params.get('role') || '').toLowerCase();
    const resolvedRole = (roleParam === 'seller' || roleParam === 'admin' || roleParam === 'superadmin')
      ? roleParam
      : (sellerId ? 'seller' : 'admin');

    const allowedModes = resolvedRole === 'seller'
      ? ['single', 'bulk']
      : ['single', 'bulk', 'product-codes'];

    if (allowedModes.includes(urlMode)) {
      setMode(urlMode);
    }
    if (urlMode === 'reserved-mapping') {
      setMode('reserved-mapping');
    }
    if (urlSingleTab === 'new' || urlSingleTab === 'existing') {
      setSingleTab(urlSingleTab);
    }
    if (embed === 'true') {
      setIsEmbedded(true);
    }

    setUserRole(resolvedRole);

    if (sellerId) {
      setVendorInfo({ 
        added_by: sellerId, 
        vendor_details: 'Communets Seller', 
        vendor_contact: email || 'N/A',
        vendor_email: email || ''
      });
    }
  }, []);

  const [formData, setFormData] = useState({
    productName: '', brand: '', ean: '', category: '', subcategory: '',
    unit: 'Piece', stockQty: '', wholesaleQty: '', priceWholesale: '', priceRetail: '', costPrice: ''
  });
  const [images, setImages] = useState([]);
  const [uploadedUrls, setUploadedUrls] = useState([]);
  const [uploadedTempMediaIds, setUploadedTempMediaIds] = useState([]);
  const [generatedContent, setGeneratedContent] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(SINGLE_DRAFT_KEY);
      if (!raw) return;
      const draft = JSON.parse(raw);
      if (!draft || typeof draft !== 'object') return;

      if (draft.formData) setFormData(draft.formData);
      if (Array.isArray(draft.uploadedUrls)) setUploadedUrls(draft.uploadedUrls);
      if (Array.isArray(draft.uploadedTempMediaIds)) setUploadedTempMediaIds(draft.uploadedTempMediaIds);
      if (draft.generatedContent) setGeneratedContent(draft.generatedContent);
      if (Number.isInteger(draft.currentStep)) setCurrentStep(Math.max(0, Math.min(3, draft.currentStep)));
    } catch (_) {
      // Ignore malformed draft payload.
    }
  }, []);

  useEffect(() => {
    if (mode !== 'single' || singleTab !== 'new') return;

    const payload = {
      mode,
      singleTab,
      currentStep,
      formData,
      uploadedUrls,
      uploadedTempMediaIds,
      generatedContent,
      updatedAt: Date.now(),
    };
    try {
      localStorage.setItem(SINGLE_DRAFT_KEY, JSON.stringify(payload));
    } catch (_) {
      // Ignore storage quota/write issues in browser.
    }
  }, [mode, singleTab, currentStep, formData, uploadedUrls, uploadedTempMediaIds, generatedContent]);

  useEffect(() => {
    const shouldWarn = mode === 'single' && singleTab === 'new' && Boolean(isProcessing);
    if (!shouldWarn) return undefined;

    const warningMessage = 'AI processing is in progress. Leaving now may interrupt this run. Do you want to leave?';

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
  }, [mode, singleTab, isProcessing]);

  const clearSingleDraft = () => {
    try {
      localStorage.removeItem(SINGLE_DRAFT_KEY);
    } catch (_) {
      // Ignore storage issues.
    }
  };

  const handleNext = () => setCurrentStep(prev => prev + 1);
  const handleBack = () => setCurrentStep(prev => prev - 1);

  const steps = [
    { title: 'Product Info', icon: '📦' },
    { title: 'Pricing',      icon: '💰' },
    { title: 'Image',        icon: '🖼️' },
    { title: 'Review',       icon: '✨' }
  ];

  const isSeller = userRole === 'seller';
  const isAdminOrSuper = userRole === 'admin' || userRole === 'superadmin';
  const normalizedMode = mode === 'reserved-mapping' ? 'product-codes' : mode;
  const currentSingleTab = normalizedMode === 'single' ? singleTab : 'new';

  const modeTitle = {
    single: currentSingleTab === 'existing'
      ? 'Regenerate Product Content'
      : currentSingleTab === 'variant'
        ? 'Create Copy Listing'
        : 'Register Your Product',
    bulk: 'Bulk Import',
    'product-codes': 'Product Code Registry'
  };

  const modeDescription = {
    single: currentSingleTab === 'existing'
      ? 'Load an existing product, keep the code read-only, and regenerate AI title/description'
      : currentSingleTab === 'variant'
        ? 'Search any existing product, inherit parent fields, generate AI content, and save as a copy listing'
      : 'Fill in the details across simple steps - AI generates the rest',
    bulk: 'Upload an Excel or PDF catalog to generate AI-powered listings in bulk',
    'product-codes': 'Map product codes to reserved inventory registry'
  };

  return (
    <div className="min-h-screen pb-12">

      {/* ── Sticky Top Header ── */}
      {!isEmbedded && (
        <header className="app-header h-auto py-2 sm:h-16">
          <div className="flex items-center justify-between w-full h-full gap-4 flex-wrap sm:flex-nowrap">
            <div className="flex-shrink-0">
              <img src="/ai-front/logo.png" alt="Communets" className="h-8 sm:h-10 w-auto" />
            </div>

            {/* Mode Toggle */}
            <div className="mode-toggle">
              <button
                className={mode === 'single' ? 'active px-3 py-1.5 sm:px-4 sm:py-2' : 'px-3 py-1.5 sm:px-4 sm:py-2'}
                onClick={() => { setMode('single'); }}
              >
                ➕ Single
              </button>
              <button
                className={mode === 'bulk' ? 'active px-3 py-1.5 sm:px-4 sm:py-2' : 'px-3 py-1.5 sm:px-4 sm:py-2'}
                onClick={() => setMode('bulk')}
              >
                📦 Bulk Import
              </button>
              {isAdminOrSuper && (
                <button
                  className={mode === 'reserved-mapping' ? 'active px-3 py-1.5 sm:px-4 sm:py-2' : 'px-3 py-1.5 sm:px-4 sm:py-2'}
                  onClick={() => setMode('reserved-mapping')}
                >
                  🧭 Product Codes
                </button>
              )}
            </div>
          </div>
        </header>
      )}

      {/* ── Hero Banner ── */}
      {!isEmbedded && (
        <div className="hero-banner">
          <h1>
            {modeTitle[normalizedMode]}
          </h1>
          <p>{modeDescription[normalizedMode]}</p>
        </div>
      )}

      {/* ── Step Indicator (single mode only) ── */}
      {normalizedMode === 'single' && currentSingleTab === 'new' && (
        <div className="step-indicator">
          {steps.map((step, idx) => (
            <React.Fragment key={idx}>
              <div className={`step-node ${currentStep === idx ? 'active' : ''} ${currentStep > idx ? 'done' : ''}`}>
                <div className={`step-circle ${currentStep === idx ? 'active' : ''} ${currentStep > idx ? 'done' : ''}`}>
                  {currentStep > idx ? '✓' : idx + 1}
                </div>
                <div className="step-label">{step.title}</div>
              </div>
              {idx < steps.length - 1 && (
                <div className={`step-line ${currentStep > idx ? 'done' : ''}`} />
              )}
            </React.Fragment>
          ))}
        </div>
      )}

      {/* ── Main Content ── */}
      <main className={normalizedMode === 'single' ? 'max-w-2xl mx-auto px-4 sm:px-6 py-8' : 'max-w-7xl mx-auto px-4 sm:px-6 py-8'}>
        {normalizedMode === 'bulk' ? (
          <div className="card form-fade-in">
            <BulkImportPage userRole={userRole} />
          </div>
        ) : normalizedMode === 'product-codes' ? (
          <div className="card form-fade-in">
            <ReservedGsMappingPage />
          </div>
        ) : (
          <div className="card form-fade-in">
            {normalizedMode === 'single' && (
              <div className="mb-5">
                <div className="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-1">
                  <button
                    type="button"
                    onClick={() => setSingleTab('new')}
                    className={currentSingleTab === 'new'
                      ? 'px-4 py-2 rounded-md bg-white shadow-sm font-semibold text-gray-900'
                      : 'px-4 py-2 rounded-md text-gray-600 hover:text-gray-900'}
                  >
                    New Product
                  </button>
                  <button
                    type="button"
                    onClick={() => setSingleTab('existing')}
                    className={currentSingleTab === 'existing'
                      ? 'px-4 py-2 rounded-md bg-white shadow-sm font-semibold text-gray-900'
                      : 'px-4 py-2 rounded-md text-gray-600 hover:text-gray-900'}
                  >
                    Preexisting Product
                  </button>
                  <button
                    type="button"
                    onClick={() => setSingleTab('variant')}
                    className={currentSingleTab === 'variant'
                      ? 'px-4 py-2 rounded-md bg-white shadow-sm font-semibold text-gray-900'
                      : 'px-4 py-2 rounded-md text-gray-600 hover:text-gray-900'}
                  >
                    Copy Listing
                  </button>
                </div>
              </div>
            )}

            {normalizedMode === 'single' && currentSingleTab === 'new' ? (
              <>
                {currentStep === 0 && (
                  <ProductInfoStep data={formData} updateData={setFormData} onNext={handleNext} onBack={handleBack} vendorId={vendorInfo.added_by} />
                )}
                {currentStep === 1 && (
                  <PricingStep data={formData} updateData={setFormData} onBack={handleBack} onNext={handleNext} />
                )}
                {currentStep === 2 && (
                  <ImageUploadStep
                    images={images}
                    setImages={setImages}
                    onBack={handleBack}
                    onNext={handleNext}
                    setUploadedUrls={setUploadedUrls}
                    setUploadedTempMediaIds={setUploadedTempMediaIds}
                    setGeneratedContent={setGeneratedContent}
                    formData={formData}
                    isProcessing={isProcessing}
                    setIsProcessing={setIsProcessing}
                  />
                )}
                {currentStep === 3 && (
                  <ReviewEditStep
                    formData={formData}
                    setFormData={setFormData}
                    generatedContent={generatedContent}
                    setGeneratedContent={setGeneratedContent}
                    uploadedUrls={uploadedUrls}
                    uploadedTempMediaIds={uploadedTempMediaIds}
                    vendorInfo={vendorInfo}
                    onBack={handleBack}
                    onSaved={clearSingleDraft}
                  />
                )}
              </>
            ) : normalizedMode === 'single' && currentSingleTab === 'existing' ? (
              <ExistingProductRegenerateTab sellerId={vendorInfo.added_by} userRole={userRole} />
            ) : normalizedMode === 'single' && currentSingleTab === 'variant' ? (
              <VariantCreateTab sellerId={vendorInfo.added_by} userRole={userRole} />
            ) : null}
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
