// 跨包契约测试（2026-09-16 评审 P3-10）：
// 前端 ConfigCenter 页手工维护了一份服务名单，漂移会导致发布/状态查询
// 出现"后端认识但前端不展示"或反之的灰名单。前后端不能直接 import，
// 这里直接读前端页面源码提取 SERVICES 的 key 与后端真源 CONFIG_SERVICES
// 比对；前端侧还有一份正向测试（ConfigCenterServices.test.ts）。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_SERVICES } from '../store/services.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendPage = path.resolve(
  here,
  '../../../frontend/src/pages/ConfigCenter/index.tsx',
);

describe('前后端配置服务名单一致性', () => {
  it('前端 ConfigCenter SERVICES 的 key 与后端 CONFIG_SERVICES 相同', () => {
    const src = fs.readFileSync(frontendPage, 'utf8');
    const block = src.match(/export const SERVICES[\s\S]*?=\s*\[([\s\S]*?)\n\]/);
    expect(block, '前端必须保持 `export const SERVICES = [...]` 字面量结构').not.toBeNull();
    const keys = [...block![1].matchAll(/key:\s*'([^']+)'/g)].map((m) => m[1]);
    expect(keys).toEqual([...CONFIG_SERVICES]);
  });
});
