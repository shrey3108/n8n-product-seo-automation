import axios from 'axios';

const FILE_SIZE_LIMIT_MB = 1;
const FILE_SIZE_LIMIT_MESSAGE = `File too large. Maximum allowed file size is ${FILE_SIZE_LIMIT_MB}MB.`;

let interceptorInstalled = false;
let fetchInterceptorInstalled = false;
let lastAlertAt = 0;

const show413Alert = () => {
  const now = Date.now();
  // Prevent alert spam when multiple requests fail together.
  if (now - lastAlertAt < 1200) return;
  lastAlertAt = now;
  window.alert(`⚠️ ${FILE_SIZE_LIMIT_MESSAGE}`);
};

export const configureAxiosGlobalHandlers = () => {
  if (interceptorInstalled) return;

  axios.interceptors.response.use(
    (response) => response,
    (error) => {
      const status = Number(error?.response?.status || 0);
      if (status === 413) {
        show413Alert();
        error.message = FILE_SIZE_LIMIT_MESSAGE;
        if (!error.response) error.response = {};
        if (!error.response.data || typeof error.response.data !== 'object') {
          error.response.data = {};
        }
        error.response.data.error = FILE_SIZE_LIMIT_MESSAGE;
      }
      return Promise.reject(error);
    }
  );

  interceptorInstalled = true;

  if (!fetchInterceptorInstalled && typeof window !== 'undefined' && typeof window.fetch === 'function') {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      if (Number(response?.status || 0) === 413) {
        show413Alert();
      }
      return response;
    };
    fetchInterceptorInstalled = true;
  }
};
