import React, { useState } from 'react';
import { createVendor } from '../services/api';

export default function AddVendorModal({ isOpen, onClose, onVendorAdded }) {
  const [formData, setFormData] = useState({
    vendorId: '',
    codePrefix: '',
    vendorDetails: '',
    vendorContact: '',
    vendorEmail: ''
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  if (!isOpen) return null;

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      await createVendor(formData);
      onVendorAdded(); // trigger a refresh of the vendors list in the parent
      onClose(); // close the modal
      setFormData({ vendorId: '', codePrefix: '', vendorDetails: '', vendorContact: '', vendorEmail: '' });
      alert('Vendor registered successfully! The new Google Sheet has been shared with their email.');
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 animation-fade-in p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh]">
        <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-gray-50">
          <h2 className="text-xl font-bold text-navy flex items-center gap-2">
            <span className="text-2xl">🤝</span> Onboard New Vendor
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 font-bold p-1">✕</button>
        </div>
        
        <div className="p-6 overflow-y-auto">
          {error && <div className="mb-4 p-3 bg-red-50 text-red-700 rounded-lg text-sm">{error}</div>}
          
          <form id="add-vendor-form" onSubmit={handleSubmit} className="space-y-4">
            
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1">
                Vendor ID (Added By code) <span className="text-red-500">*</span>
              </label>
              <input 
                type="text" name="vendorId" value={formData.vendorId} onChange={handleChange} required
                placeholder="e.g. V-1011"
                className="w-full p-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
              />
              <p className="text-xs text-gray-500 mt-1">Unique identifier used to group this vendor's items.</p>
            </div>

            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1">
                Vendor Name / Details <span className="text-red-500">*</span>
              </label>
              <input 
                type="text" name="vendorDetails" value={formData.vendorDetails} onChange={handleChange} required
                placeholder="e.g. Acme Wholesale Corp."
                className="w-full p-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1">
                Vendor Email Address <span className="text-red-500">*</span>
              </label>
              <input 
                type="email" name="vendorEmail" value={formData.vendorEmail} onChange={handleChange} required
                placeholder="vendor@company.com"
                className="w-full p-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
              />
              <p className="text-xs text-gray-500 mt-1">The new Google Sheet will be automatically shared with this email.</p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1">Code Prefix</label>
                <input 
                  type="text" name="codePrefix" value={formData.codePrefix} onChange={handleChange}
                  placeholder="e.g. ACM"
                  className="w-full p-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1">Contact Phone</label>
                <input 
                  type="text" name="vendorContact" value={formData.vendorContact} onChange={handleChange}
                  placeholder="e.g. +91 9876543210"
                  className="w-full p-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:outline-none"
                />
              </div>
            </div>
            
          </form>
        </div>

        <div className="p-6 border-t border-gray-100 bg-gray-50 flex justify-end gap-3 shrink-0">
          <button 
            type="button" onClick={onClose} disabled={loading}
            className="px-5 py-2.5 text-gray-700 font-semibold bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition"
          >
            Cancel
          </button>
          <button 
            type="submit" form="add-vendor-form" disabled={loading}
            className="px-5 py-2.5 text-white font-semibold bg-blue-700 hover:bg-blue-800 rounded-lg transition disabled:opacity-70 flex items-center gap-2"
          >
            {loading ? (
              <>
                <svg className="animate-spin h-5 w-5 text-white" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                Creating Sheet...
              </>
            ) : "Register & Share Sheet"}
          </button>
        </div>
      </div>
    </div>
  );
}
