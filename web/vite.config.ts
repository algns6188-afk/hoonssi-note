import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages 주소: https://algns6188-afk.github.io/hoonssi-note/
export default defineConfig({
  root: __dirname,
  base: process.env.WEB_BASE ?? '/hoonssi-note/',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true }
})
