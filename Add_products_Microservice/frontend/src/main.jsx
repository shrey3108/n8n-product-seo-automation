import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import './index.css';
import App from './App.jsx';
import BulkTrackPage from './components/BulkTrackPage.jsx';
import { configureAxiosGlobalHandlers } from './utils/configureAxiosGlobalHandlers.js';

configureAxiosGlobalHandlers();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter basename="/ai-front/">
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/track/:jobId" element={<BulkTrackPage />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
