import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Change 'sydney-house-prices' to your actual GitHub repository name
// e.g. if your repo is github.com/yourname/sydney-house-prices
// then base should be '/sydney-house-prices/'
export default defineConfig({
  plugins: [react()],
  base: '/sydney-house-prices/',
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
})
