#!/usr/bin/env python3
"""Build a test-only host around frozen production arming components."""
import argparse,json,pathlib,shutil,subprocess
parser=argparse.ArgumentParser()
parser.add_argument('candidate',type=pathlib.Path)
args=parser.parse_args()
c=args.candidate
if c.resolve()!=c or not str(c).startswith('/mnt/ainvr-ssd/ainvr-alarm-refactor-web-'):
 raise SystemExit('Canonical isolated candidate required')
status=json.loads((c/'status.json').read_text())
if status['phase']!='passed' or status['deployment_performed']:
 raise SystemExit('Verified undeployed candidate required')
base=c/'source/srs-web-console/frontend'
h=c/'arming-harness'
h.mkdir()
(h/'node_modules').symlink_to(base/'node_modules',target_is_directory=True)
(h/'src').symlink_to(base/'src',target_is_directory=True)
shutil.copy2(pathlib.Path(__file__).with_name('arming_browser_harness.tsx'),h/'main.tsx')
for name in ['package.json','postcss.config.js','tailwind.config.js']:
 if (base/name).exists():shutil.copy2(base/name,h/name)
(h/'index.html').write_text('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"/><title>隔离布防验收</title></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>')
(h/'vite.config.ts').write_text("import {defineConfig} from 'vite';import react from '@vitejs/plugin-react';import path from 'node:path';export default defineConfig({plugins:[react()],base:'/__arming/',resolve:{alias:{'@':path.resolve(import.meta.dirname,'src')}}})")
subprocess.run(['npx','vite','build'],cwd=h,check=True)
