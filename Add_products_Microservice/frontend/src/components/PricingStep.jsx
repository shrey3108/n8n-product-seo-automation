import React from 'react';

export default function PricingStep({ data, updateData, onBack, onNext }) {
  const handleChange = (e) => {
    updateData({ ...data, [e.target.name]: e.target.value });
  };

  const handleNext = (e) => {
    e.preventDefault();
    onNext();
  };

  return (
    <div className="animation-fade-in">
      <div className="flex items-center gap-3 mb-6">
        <span className="text-2xl">💰</span>
        <h2 className="text-xl font-bold text-navy">Pricing & Quotas</h2>
      </div>
      
      <form onSubmit={handleNext} className="space-y-5">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-1">Selling Unit</label>
            <select 
              name="unit" value={data.unit} onChange={handleChange}
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
            <label className="block text-sm font-semibold text-gray-700 mb-1">Min. Wholesale Qty</label>
            <input 
              type="number" name="wholesaleQty" value={data.wholesaleQty} onChange={handleChange}
              className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
              placeholder="e.g. 50" min="1"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-1">Wholesale Price (₹)</label>
            <input 
              type="number" name="priceWholesale" value={data.priceWholesale} onChange={handleChange}
              className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
              placeholder="e.g. 500.00" step="0.01" min="0"
            />
          </div>
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-1">Retail Price (MSRP) (₹)</label>
            <input 
              type="number" name="priceRetail" value={data.priceRetail} onChange={handleChange}
              className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
              placeholder="e.g. 999.00" step="0.01" min="0"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-semibold text-gray-700 mb-1">Partner Price (₹)</label>
          <input 
            type="number" name="costPrice" value={data.costPrice} onChange={handleChange}
            className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
            placeholder="e.g. 350.00" step="0.01" min="0"
          />
        </div>

        <div className="bg-blue-50 text-blue-800 p-4 rounded-lg mt-6 text-sm">
          💡 <strong>Pro Tip:</strong> Setting a competitive wholesale price helps attract bulk buyers on the B2B platform.
        </div>
        
        <div className="flex justify-between pt-6">
          <button type="button" onClick={onBack} className="bg-gray-200 hover:bg-gray-300 text-gray-800 font-bold py-3 px-6 rounded-lg transition-colors">
            ← Back
          </button>
          <button type="submit" className="bg-blue-800 hover:bg-blue-700 text-white font-bold py-3 px-8 rounded-lg transition-colors">
            Next Step →
          </button>
        </div>
      </form>
    </div>
  );
}
