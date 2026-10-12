import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CryptoStore } from '../store/crypto.js';

describe('CryptoStore 加密工具', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-crypto-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('首次调用自动生成 32 字节主密钥', () => {
    const keyPath = path.join(tmpDir, 'master.key');
    const store = new CryptoStore(keyPath);
    const key = store.loadMasterKey();
    expect(key.length).toBe(32);
    expect(fs.existsSync(keyPath)).toBe(true);
    const saved = fs.readFileSync(keyPath);
    expect(saved.length).toBe(32);
  });

  it('二次调用返回同一个密钥（缓存命中）', () => {
    const keyPath = path.join(tmpDir, 'master.key');
    const store = new CryptoStore(keyPath);
    const k1 = store.loadMasterKey();
    const k2 = store.loadMasterKey();
    expect(k1 === k2).toBe(true); // 同一引用
  });

  it('加密后解密能还原原文', () => {
    const keyPath = path.join(tmpDir, 'master.key');
    const store = new CryptoStore(keyPath);
    const plain = 'hello-world-secret-123';
    const blob = store.encrypt(plain);
    const decrypted = store.decrypt(blob);
    expect(decrypted).toBe(plain);
  });

  it('每次加密 nonce 不同，密文不同', () => {
    const keyPath = path.join(tmpDir, 'master.key');
    const store = new CryptoStore(keyPath);
    const plain = 'same-text';
    const a = store.encrypt(plain);
    const b = store.encrypt(plain);
    expect(a.equals(b)).toBe(false);
    // 但解密后一样
    expect(store.decrypt(a)).toBe(plain);
    expect(store.decrypt(b)).toBe(plain);
  });

  it('篡改密文会抛错（GCM auth tag 校验）', () => {
    const keyPath = path.join(tmpDir, 'master.key');
    const store = new CryptoStore(keyPath);
    const blob = store.encrypt('test');
    const tampered = Buffer.from(blob);
    tampered[20] ^= 0xff; // 改一个字节
    expect(() => store.decrypt(tampered)).toThrow();
  });

  it('支持中文和特殊字符', () => {
    const keyPath = path.join(tmpDir, 'master.key');
    const store = new CryptoStore(keyPath);
    const plain = '中文密码 🎉 「测试」';
    const decrypted = store.decrypt(store.encrypt(plain));
    expect(decrypted).toBe(plain);
  });

  it('两个不同实例（不同密钥文件）完全隔离，密文互不兼容', () => {
    const k1 = path.join(tmpDir, 'a.key');
    const k2 = path.join(tmpDir, 'b.key');
    const s1 = new CryptoStore(k1);
    const s2 = new CryptoStore(k2);
    const plain = '跨实例测试';
    const blob = s1.encrypt(plain);
    // 用 s2 解不开
    expect(() => s2.decrypt(blob)).toThrow();
    // 各自能解自己的
    expect(s1.decrypt(blob)).toBe(plain);
    expect(s2.decrypt(s2.encrypt(plain))).toBe(plain);
  });

  it('resetCache 后重新从磁盘读取，内容一致但引用不同', () => {
    const keyPath = path.join(tmpDir, 'master.key');
    const store = new CryptoStore(keyPath);
    const k1 = store.loadMasterKey();
    store.resetCache();
    const k2 = store.loadMasterKey();
    expect(k1 === k2).toBe(false); // 不是同一引用（缓存已清空）
    expect(k1.equals(k2)).toBe(true); // 内容相同
  });

  it('太短的密文抛出格式错误', () => {
    const keyPath = path.join(tmpDir, 'master.key');
    const store = new CryptoStore(keyPath);
    store.loadMasterKey(); // 确保已初始化
    expect(() => store.decrypt(Buffer.from([1, 2, 3]))).toThrow('密文太短');
  });
});
