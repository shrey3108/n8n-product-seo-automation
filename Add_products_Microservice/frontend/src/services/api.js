import axios from 'axios';

export const API_BASE_URL = `/ai-api`;
const UPLOAD_TIMEOUT_MS = 90000;

// Add request interceptor to attach Firebase ID Token from parent window
axios.interceptors.request.use(async (config) => {
  if (window.parent && typeof window.parent.getAiAuthToken === 'function') {
    try {
      const token = await window.parent.getAiAuthToken();
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
    } catch (e) {
      console.error('Failed to get token from parent window:', e);
    }
  }
  return config;
}, (error) => {
  return Promise.reject(error);
});

export const uploadImages = async (files, options = {}) => {
  const formData = new FormData();
  files.forEach((file) => formData.append('images', file));

  const response = await axios.post(`${API_BASE_URL}/upload`, formData, {
    params: { enhance: options.enhance ?? 'true' },
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: UPLOAD_TIMEOUT_MS,
  });
  return {
    urls: Array.isArray(response.data?.urls) ? response.data.urls : [],
    tempMediaIds: Array.isArray(response.data?.tempMediaIds) ? response.data.tempMediaIds : [],
    fileErrors: Array.isArray(response.data?.fileErrors) ? response.data.fileErrors : [],
  };
};

export const generateProductContent = async (payload) => {
  const response = await axios.post(`${API_BASE_URL}/product/generate`, payload);
  return response.data;
};

export const finalizeProduct = async (payload) => {
  const response = await axios.post(`${API_BASE_URL}/product/finalize`, payload);
  return response.data;
};

export const previewReservedMappings = async (file) => {
  const formData = new FormData();
  formData.append('file', file);

  const response = await axios.post(`${API_BASE_URL}/reserved-mapping/preview`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 180000,
  });
  return response.data;
};

export const previewSingleReservedMapping = async (payload) => {
  const response = await axios.post(`${API_BASE_URL}/reserved-mapping/preview-single`, payload, {
    timeout: 45000,
  });
  return response.data;
};

export const submitReservedMappings = async (payload) => {
  const response = await axios.post(`${API_BASE_URL}/reserved-mapping/submit`, payload);
  return response.data;
};

export const fetchAccessRequests = async ({ actorId, status = 'pending' }) => {
  const response = await axios.get(`${API_BASE_URL}/access/requests`, {
    params: { actorId, status },
  });
  return response.data;
};

export const decideAccessRequest = async ({ requestId, decision, note, actorId }) => {
  const response = await axios.post(`${API_BASE_URL}/access/requests/${requestId}/decision`, {
    decision,
    note,
    actorId,
  });
  return response.data;
};

export const fetchAccessAuditLogs = async ({ actorId }) => {
  const response = await axios.get(`${API_BASE_URL}/access/audit`, {
    params: { actorId },
  });
  return response.data;
};

export const fetchExistingProductByGs = async ({ code, vendorId, role }) => {
  const response = await axios.get(`${API_BASE_URL}/existing-product/by-gs`, {
    params: { code, vendorId, role },
  });
  return response.data;
};

export const saveExistingProductEdit = async ({ productId, vendorId, updateData, actorRole, actorId }) => {
  const response = await axios.put(`${API_BASE_URL}/existing-product/edit/${encodeURIComponent(productId)}`, {
    vendorId,
    updateData,
    actorRole,
    actorId,
  });
  return response.data;
};

export const searchProductsForVariant = async ({ q, vendorId, role }) => {
  const response = await axios.get(`${API_BASE_URL}/products/search`, {
    params: { q, vendorId, role },
  });
  return response.data;
};

export const fetchVariantParent = async (productId) => {
  const response = await axios.get(`${API_BASE_URL}/variant-parent/${encodeURIComponent(productId)}`);
  return response.data;
};

export const finalizeVariant = async (payload) => {
  const response = await axios.post(`${API_BASE_URL}/product/finalize-variant`, payload);
  return response.data;
};
