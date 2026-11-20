import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'sanitize-malformed-uri',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (typeof req.url === 'string' && req.url.includes('%')) {
            req.url = req.url.replace(/%(?![0-9A-Fa-f]{2})/g, '%25');
          }
          next();
        });
      }
    }
  ],
  base: '/ai-front/',
  server: {
    port: 5174,
    strictPort: true,
    allowedHosts: true,
    hmr: {
      overlay: false,
    },

    proxy: {
      '/api': {
        target: 'http://localhost:5276',
        changeOrigin: true
      },
      '/ai-api': {
        target: 'http://localhost:5276',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ai-api/, '/api')
      }
    }
  },
})

