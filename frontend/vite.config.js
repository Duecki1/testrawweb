import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// CHANGE 'http://localhost:5000' to whatever port your Python/Node backend runs on!
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:1234', 
        changeOrigin: true,
      }
    }
  }
})
