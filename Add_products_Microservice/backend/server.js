import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import apiRoutes from './routes/api.js';
import bulkRoutes from './routes/bulk.js';
import connectDB from './config/db.js';

dotenv.config();

const app = express();
const PORT = process.env.MICROSERVICE_PORT || 5276;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const aiFrontendDistPath = path.resolve(__dirname, '../frontend/dist');

// Connect to MongoDB
connectDB();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Token verification middleware using the main backend verification channel
const authenticateUser = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split("Bearer ")[1];
    if (!token) {
      return res.status(401).json({ error: "Unauthorized: No token provided" });
    }

    const internalBackendUrl = process.env.INTERNAL_BACKEND_URL || 'http://localhost:5274';

    // Verify token with the main backend
    const response = await axios.get(`${internalBackendUrl}/v1/profile`, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    if (response.status === 200 && response.data?.user) {
      const user = response.data.user;

      // Allow only Seller, Admin, and SuperAdmin roles
      if (!['Seller', 'Admin', 'SuperAdmin'].includes(user.role)) {
        return res.status(403).json({ error: "Access Denied: Insufficient permissions" });
      }

      req.user = user;
      return next();
    } else {
      return res.status(401).json({ error: "Unauthorized: Invalid token" });
    }
  } catch (error) {
    console.error("AI Microservice Auth Error:", error.message);
    return res.status(401).json({ error: "Unauthorized: Token verification failed" });
  }
};

// Routes
// Mount bulk routes first so /api/bulk/* does not get swallowed by the api router catch-all proxy.
app.use('/api/bulk', authenticateUser, bulkRoutes);
app.use('/api', authenticateUser, apiRoutes);

// Serve built AI frontend assets in production.
app.use('/ai-front', express.static(aiFrontendDistPath));

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Backend is running' });
});

// SPA fallback for AI frontend routes.
app.get(/^\/ai-front(?:\/.*)?$/, (req, res) => {
  res.sendFile(path.join(aiFrontendDistPath, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
