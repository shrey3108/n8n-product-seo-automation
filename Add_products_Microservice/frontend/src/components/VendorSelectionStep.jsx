import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { API_BASE_URL } from '../services/api';
import AddVendorModal from './AddVendorModal';

export default function VendorSelectionStep({ onNext, setVendorInfo }) {
  const [vendors, setVendors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedVendorId, setSelectedVendorId] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);

  const fetchVendors = useCallback(async () => {
    try {
      const response = await axios.get(`${API_BASE_URL}/vendors`);
      setVendors(response.data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchVendors();
  }, [fetchVendors]);

  const handleContinue = () => {
    if (!selectedVendorId) return alert('Please select a vendor code.');
    const vendor = vendors.find(v => String(v.added_by) === String(selectedVendorId));
    setVendorInfo(vendor);
    onNext();
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center p-12 animation-fade-in">
        <div className="w-12 h-12 border-4 border-blue-200 border-t-blue-800 rounded-full animate-spin mb-4"></div>
        <p className="text-gray-600 font-bold">Loading Vendor Directory...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8 text-center text-red-600 bg-red-50 rounded-xl my-8">
        <h2 className="font-bold mb-2">Failed to load vendors</h2>
        <p>{error}</p>
      </div>
    );
  }

  return (
    <div className="animation-fade-in max-w-2xl mx-auto">
      <div className="flex items-center gap-3 mb-8">
        <span className="text-2xl">👤</span>
        <h2 className="text-xl font-bold text-navy">Vendor Assignment</h2>
      </div>

      <div className="bg-white p-6 md:p-8 rounded-xl shadow-sm border border-gray-100">
        <p className="text-gray-600 mb-6">
          Please select your <strong>Added By</strong> ID code to begin. This determines which catalog the product will be saved to.
        </p>

        <div className="mb-6">
          <div className="flex justify-between items-end mb-2">
            <label className="block text-sm font-bold text-navy">Added By (Vendor ID)</label>
            <button 
              onClick={() => setIsModalOpen(true)}
              className="text-sm font-bold text-blue-700 hover:bg-blue-50 px-3 py-1 rounded-lg transition"
            >
              + Add New Vendor
            </button>
          </div>
          <select 
            className="w-full text-lg p-4 border-2 border-gray-300 rounded-xl focus:border-blue-600 focus:ring-0 outline-none transition bg-gray-50 bg-white"
            value={selectedVendorId}
            onChange={(e) => setSelectedVendorId(e.target.value)}
          >
            <option value="" disabled>Select your ID code...</option>
            {vendors.map((v, idx) => (
              <option key={idx} value={v.added_by}>
                {v.added_by} - {v.vendor_details.split('-')[0].trim()}
              </option>
            ))}
          </select>
        </div>

        {selectedVendorId && (
          <div className="bg-blue-50 border border-blue-100 p-4 rounded-lg mb-8 text-sm">
            <h4 className="font-bold text-blue-900 mb-2">Vendor Details Confirmed:</h4>
            <ul className="text-blue-800 space-y-1">
              <li><strong>Contact:</strong> {vendors.find(v => String(v.added_by) === String(selectedVendorId))?.vendor_contact}</li>
              <li><strong>Prefix Code:</strong> {vendors.find(v => String(v.added_by) === String(selectedVendorId))?.code_prefix}</li>
            </ul>
          </div>
        )}

        <div className="flex justify-end">
          <button 
            type="button" 
            onClick={handleContinue}
            disabled={!selectedVendorId}
            className="bg-blue-800 hover:bg-blue-700 text-white font-bold py-3 px-8 rounded-lg shadow-lg transition-transform active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Authenticate & Continue →
          </button>
        </div>
      </div>

      <AddVendorModal 
        isOpen={isModalOpen} 
        onClose={() => setIsModalOpen(false)} 
        onVendorAdded={fetchVendors} 
      />
    </div>
  );
}
