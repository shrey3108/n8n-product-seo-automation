import React, { useState, useEffect, useRef } from 'react';
import { API_BASE_URL } from '../services/api';



// ── Searchable brand dropdown ─────────────────────────────────────────────────
const SearchableSelect = ({ name, value, onChange, options, placeholder }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const wrapperRef = useRef(null);

  useEffect(() => { setSearch(value || ''); }, [value]);
  useEffect(() => {
    function handleClickOutside(event) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target)) setIsOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const filtered = options.filter(o => o.label.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="relative" ref={wrapperRef}>
      <input
        type="text"
        className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
        placeholder={placeholder}
        value={search}
        onChange={(e) => { setSearch(e.target.value); onChange({ target: { name, value: e.target.value } }); setIsOpen(true); }}
        onFocus={() => setIsOpen(true)}
      />
      {isOpen && filtered.length > 0 && (
        <ul className="absolute z-10 w-full bg-white border border-gray-300 rounded-lg mt-1 max-h-60 overflow-y-auto shadow-lg">
          {filtered.map(o => (
            <li key={o.value} className="p-3 hover:bg-gray-100 cursor-pointer"
              onClick={() => { setSearch(o.label); onChange({ target: { name, value: o.label } }); setIsOpen(false); }}>
              {o.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
export default function ProductInfoStep({ data, updateData, onNext, onBack }) {
  const [manufacturers, setManufacturers] = useState([]);
  const [manufacturersError, setManufacturersError] = useState(false);
  const [categories, setCategories] = useState([]);
  const [categoriesLoading, setCategoriesLoading] = useState(true);
  const [subcategories, setSubcategories] = useState([]);
  const [subcategoriesLoading, setSubcategoriesLoading] = useState(false);

  useEffect(() => {
    fetch(`${API_BASE_URL}/manufacturers`)
      .then(res => res.json())
      .then(json => {
        const list = Array.isArray(json) ? json : (json.manufacturers || []);
        if (list.length > 0) setManufacturers(list);
        else setManufacturersError(true);
      })
      .catch(() => setManufacturersError(true));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    fetch(`${API_BASE_URL}/categories`)
      .then(res => res.json())
      .then(json => {
        const list = Array.isArray(json) ? json : (json.categories || []);
        setCategories(list);
      })
      .catch(() => setCategories([]))
      .finally(() => setCategoriesLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!data.category) {
      setSubcategories([]);
      return;
    }
    setSubcategoriesLoading(true);
    fetch(`${API_BASE_URL}/categories/${data.category}/subcategories`)
      .then(res => res.json())
      .then(json => {
        const list = Array.isArray(json) ? json : (json.subcategories || []);
        setSubcategories(list);
      })
      .catch(() => setSubcategories([]))
      .finally(() => setSubcategoriesLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.category]);

  const handleProductCodeChange = (e) => {
    const productCode = e.target.value;
    updateData({
      ...data,
      productOGCode: productCode,
    });
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    if (name === 'productOGCode') { handleProductCodeChange(e); return; }
    if (name === 'category') {
      updateData({ ...data, category: value, subcategory: '' });
    } else {
      updateData({ ...data, [name]: value });
    }
  };

  const handleNext = (e) => {
    e.preventDefault();
    if (!data.productName) return alert('Product Name is required');
    onNext();
  };

  // Border colors
  const eanBorderClass = 'border-gray-300 focus:ring-blue-500';

  return (
    <div className="animation-fade-in">
      <div className="flex items-center gap-3 mb-6">
        <span className="text-2xl">📝</span>
        <h2 className="text-xl font-bold text-navy">Product Information</h2>
      </div>
      <form onSubmit={handleNext} className="space-y-5">
        {/* Product Name */}
        <div>
          <label className="block text-sm font-semibold text-gray-700 mb-1">
            Product Name <span className="text-red-500">*</span>
          </label>
          <input
            type="text" name="productName" value={data.productName} onChange={handleChange}
            className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
            placeholder="e.g. Acme Super Widget" required
          />
        </div>

        {/* Brand + Product Code row */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-1">Brand / Manufacturer</label>
            {manufacturersError ? (
              <input type="text" name="brand" value={data.brand || ''} onChange={handleChange}
                className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
                placeholder="Brand Name" />
            ) : (
              <SearchableSelect name="brand" value={data.brand} onChange={handleChange}
                placeholder="Search Brand..."
                options={manufacturers.map(m => ({ label: m.manufacturerName, value: m.manufacturerId }))} />
            )}
          </div>

          {/* Product code field with live check */}
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-1">
              Product Code
              <span className="ml-2 text-xs font-normal text-gray-400">(Optional)</span>
            </label>
            <input
              type="text" name="productOGCode" value={data.productOGCode || ''} onChange={handleChange}
              className={`w-full p-3 border rounded-lg focus:ring-2 focus:outline-none ${eanBorderClass}`}
              placeholder="e.g. 1234567890123"
            />
          </div>
        </div>

        {/* Stock row */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-1">
              Stock Quantity
            </label>
            <input type="number" name="stockQty" value={data.stockQty} onChange={handleChange} min="0"
              className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
              placeholder="e.g. 100" />
          </div>
          <div></div>
        </div>

        {/* Category & Subcategory */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-1">Category</label>
            <select name="category" value={data.category} onChange={handleChange}
              className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
              disabled={categoriesLoading}>
              <option value="" disabled>{categoriesLoading ? 'Loading...' : '-- Select Category --'}</option>
              {categories.map(cat => <option key={cat.categoryId} value={cat.categoryId}>{cat.categoryName}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-1">Subcategory</label>
            <select name="subcategory" value={data.subcategory} onChange={handleChange}
              className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
              disabled={!data.category || subcategoriesLoading}>
              <option value="">{subcategoriesLoading ? 'Loading...' : '-- Select Subcategory --'}</option>
              {subcategories.map(sub => <option key={sub.categoryId} value={sub.categoryId}>{sub.categoryName}</option>)}
            </select>
          </div>
        </div>

        {/* Nav buttons */}
        <div className="flex justify-between pt-4">
          <button type="button" onClick={onBack}
            className="bg-gray-200 hover:bg-gray-300 text-gray-800 font-bold py-3 px-6 rounded-lg transition-colors">
            ← Back
          </button>
          <button
            type="submit"
            className="bg-blue-800 hover:bg-blue-700 text-white font-bold py-3 px-8 rounded-lg transition-colors"
          >
            Next Step →
          </button>
        </div>
      </form>
    </div>
  );
}
