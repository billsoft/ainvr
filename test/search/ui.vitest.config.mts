import path from 'node:path'
import ui from './ui.vite.config.mts'
const front = path.resolve(import.meta.dirname, '../../srs-web-console/frontend')
export default {
  ...ui,
  root: front,
  resolve: { ...ui.resolve, alias: { ...ui.resolve?.alias, vitest: path.join(front, 'node_modules/vitest') } },
  test: { environment: 'jsdom', globals: true, css: false, setupFiles: [path.join(front, 'src/test/setup.ts')],
    include: [path.join(import.meta.dirname, 'ui.test.ts')] },
}
