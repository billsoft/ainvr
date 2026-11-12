import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
// Explicit opt-in build. Never added to the production router or main entry.
export default defineConfig({
  plugins:[react()],
  resolve:{alias:{'@':path.resolve(import.meta.dirname,'src')}},
  build:{rollupOptions:{input:path.resolve(import.meta.dirname,'vehicle-demo.html')}},
})
