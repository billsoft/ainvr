import path from 'node:path'
import { createRequire } from 'node:module'
const root = path.resolve(import.meta.dirname, '../..'), front = path.join(root, 'srs-web-console/frontend')
const fixtureRequire = createRequire(path.join(front, 'package.json'))
const react = fixtureRequire('@vitejs/plugin-react').default
const tailwindcss = fixtureRequire('tailwindcss'), autoprefixer = fixtureRequire('autoprefixer')
const tailwindConfig = fixtureRequire(path.join(front, 'tailwind.config.js')).default
export default {
  root: import.meta.dirname, plugins: [react()],
  resolve: { alias: { '@': path.join(front, 'src'), 'react': path.join(front, 'node_modules/react'), 'react-dom': path.join(front, 'node_modules/react-dom'), 'react-router-dom': path.join(front, 'node_modules/react-router-dom') } },
  css: { postcss: { plugins: [tailwindcss({ ...tailwindConfig, content: [path.join(front, 'src/**/*.{ts,tsx}'), path.join(import.meta.dirname, 'ui*.tsx')] }), autoprefixer()] } },
  build: { outDir: path.join(root, 'out/search-ui-preview'), emptyOutDir: false, rollupOptions: { input: path.join(import.meta.dirname, 'ui.html') } },
  server: { host: '127.0.0.1', port: 28119, strictPort: true, fs: { allow: [root] } },
}
