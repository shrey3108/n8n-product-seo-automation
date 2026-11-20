import axios from 'axios';

const API_BASE_URL = `/ai-api/bulk`;

export const parseXlsx = async (file) => {
  const formData = new FormData();
  formData.append('file', file);
  const response = await axios.post(`${API_BASE_URL}/parse-xlsx`, formData);
  return response.data;
};

export const parsePdf = async (file) => {
  const formData = new FormData();
  formData.append('file', file);
  const response = await axios.post(`${API_BASE_URL}/parse-pdf`, formData, {
    timeout: 120000, // PDF extraction can take a while
  });
  return response.data;
};

export const uploadBulkImages = async (images) => {
  const response = await axios.post(`${API_BASE_URL}/upload-images`, { images }, {
    timeout: 180000,
  });
  return response.data.urls;
};

export const startBulkJob = async (products, vendorId, vendorEmail, actorRole, actorId, autoSaveEnabled = false) => {
  const response = await axios.post(`${API_BASE_URL}/start-job`, {
    products,
    vendorId,
    vendorEmail,
    actorRole,
    actorId,
    autoSaveEnabled,
  }, {
    timeout: 30000,
  });
  return response.data; // { jobId, message }
};

export const updateBulkJobAutoSave = async (jobId, autoSaveEnabled) => {
  const response = await axios.post(`${API_BASE_URL}/job-autosave/${jobId}`, {
    autoSaveEnabled,
  });
  return response.data;
};

export const getJobStatus = async (jobId) => {
  const response = await axios.get(`${API_BASE_URL}/job-status/${jobId}`);
  return response.data; // { id, status, processed, total, successCount, failCount, items }
};

export const getJobSummary = async (jobId) => {
  const response = await axios.get(`${API_BASE_URL}/job-summary/${jobId}`);
  return response.data; // { id, status, processed, total, successCount, failCount, ... } (no items)
};

export const getJobItems = async (jobId, page = 1, limit = 50) => {
  const response = await axios.get(`${API_BASE_URL}/job-items/${jobId}`, {
    params: { page, limit },
  });
  return response.data; // { items, total, page, limit, pages }
};

export const stopBulkJob = async (jobId) => {
  const response = await axios.post(`${API_BASE_URL}/stop-job/${jobId}`);
  return response.data;
};

export const listBulkJobs = async () => {
  const response = await axios.get(`${API_BASE_URL}/jobs`);
  return response.data;
};

export const listAssignableVendors = async ({ actorId, actorEmail }) => {
  const response = await axios.get(`${API_BASE_URL}/vendor-list`, {
    params: { actorId, actorEmail },
  });
  return response.data;
};

export const assignUploadedProducts = async (payload) => {
  const response = await axios.post(`${API_BASE_URL}/assign-products`, payload, {
    timeout: 30000,
  });
  return response.data;
};

export const listAssignableProducts = async ({ actorId, actorEmail, page = 1, limit = 50, search = '' }) => {
  const response = await axios.get(`${API_BASE_URL}/assignable-products`, {
    params: { actorId, actorEmail, page, limit, search },
  });
  return response.data;
};

export const listVendorAssignedProducts = async ({ actorId, actorEmail, vendorUserId, page = 1, limit = 50, search = '' }) => {
  const response = await axios.get(`${API_BASE_URL}/vendor-assigned-products`, {
    params: { actorId, actorEmail, vendorUserId, page, limit, search },
  });
  return response.data;
};

export const revokeAssignedProducts = async (payload) => {
  const response = await axios.post(`${API_BASE_URL}/revoke-products`, payload, {
    timeout: 30000,
  });
  return response.data;
};

export const resetReservedProducts = async ({ actorId, actorEmail, scope = 'actor' }) => {
  const response = await axios.post(`${API_BASE_URL}/reset-reserved-products`, {
    actorId,
    actorEmail,
    scope,
  }, {
    timeout: 30000,
  });
  return response.data;
};
