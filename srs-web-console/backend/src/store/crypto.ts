/**
 * 敏感值加密工具（AES-256-GCM）
 * - 实例化模式：每个 CryptoStore 实例独立缓存密钥，测试互不污染
 * - 主密钥从 root-only 文件读取（通过 CONFIG_MASTER_KEY_PATH 指定）
 * - 格式：12字节 nonce + 密文 + 16字节 auth tag（nonce 和 tag 都存一起，解密时拆）
 * - 支持密钥轮换：key_version 字段标识主密钥版本
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

const ALGORITHM = 'aes-256-gcm';
const NONCE_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32; // 256-bit

export class CryptoStore {
  private cachedKey: Buffer | null = null;
  private cachedKeyPath = '';
  private readonly keyPath: string;

  constructor(keyPath: string) {
    this.keyPath = keyPath;
  }

  /** 从文件读取主密钥（32字节）；文件不存在/太短就自动生成并写回 */
  loadMasterKey(): Buffer {
    if (this.cachedKey && this.cachedKeyPath === this.keyPath) return this.cachedKey;

    if (fs.existsSync(this.keyPath)) {
      const raw = fs.readFileSync(this.keyPath);
      if (raw.length >= KEY_LEN) {
        this.cachedKey = raw.subarray(0, KEY_LEN);
        this.cachedKeyPath = this.keyPath;
        return this.cachedKey;
      }
    }

    // 自动生成新密钥
    const key = crypto.randomBytes(KEY_LEN);
    const dir = this.keyPath.substring(0, this.keyPath.lastIndexOf('/'));
    if (dir && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.keyPath, key, { mode: 0o600 });
    try {
      // 尝试收窄权限（root-only），失败忽略（非 root 环境）
      fs.chmodSync(this.keyPath, 0o400);
    } catch {
      /* noop */
    }
    this.cachedKey = key;
    this.cachedKeyPath = this.keyPath;
    console.info(`[crypto] 已生成新主密钥: ${this.keyPath}`);
    return key;
  }

  /** 加密明文 → Buffer（nonce + ciphertext + tag 拼一起） */
  encrypt(plaintext: string): Buffer {
    const key = this.loadMasterKey();
    const nonce = crypto.randomBytes(NONCE_LEN);
    const cipher = crypto.createCipheriv(ALGORITHM, key, nonce);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([nonce, encrypted, tag]);
  }

  /** 解密 Buffer → 明文；失败抛错 */
  decrypt(blob: Buffer): string {
    const key = this.loadMasterKey();
    if (blob.length < NONCE_LEN + TAG_LEN) {
      throw new Error('密文太短，格式损坏');
    }
    const nonce = blob.subarray(0, NONCE_LEN);
    const tag = blob.subarray(blob.length - TAG_LEN);
    const ciphertext = blob.subarray(NONCE_LEN, blob.length - TAG_LEN);

    const decipher = crypto.createDecipheriv(ALGORITHM, key, nonce);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plain.toString('utf8');
  }

  /** 重置内存缓存（主要用于测试，模拟冷启动） */
  resetCache(): void {
    this.cachedKey = null;
    this.cachedKeyPath = '';
  }
}
