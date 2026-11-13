import { MongoClient, Binary, type Db, type Document } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { FacesError } from '../services/facesContract.js';
import type { FacesPhotoRef } from '../services/facesPhotos.js';

export interface FacesMongoConnection { uri: string; database: string }
export const FACES_HISTORY_INDEX = 'faces_history_all_spaces_v1';
export interface FacesMongoRow extends Document {
  _id: string; kind: 'template' | 'capture'; fingerprint: string; model: 'mbf' | 'r50'; space_id: string;
  state: 'pending' | 'extracted' | 'ready' | 'deleting' | 'expired'; expires_at: Date;
  data: Record<string, unknown>; vector?: Binary; photo?: FacesPhotoRef; purge_at?: Date;
}
export function facesVector(values: number[]): Binary {
  if (values.length !== 512 || values.some(value => !Number.isFinite(value))) throw new FacesError('invalid_embedding', '特征维度无效', 503);
  const bytes = Buffer.alloc(512 * 4); values.forEach((value, index) => bytes.writeFloatLE(value, index * 4)); return new Binary(bytes);
}
export function facesCosine(vector: Binary, query: number[]) {
  const bytes = Buffer.from(vector.buffer);
  if (bytes.length !== 512 * 4 || query.length !== 512) throw new FacesError('invalid_embedding', '历史特征维度无效', 503);
  let dot = 0, left = 0, right = 0;
  for (let index = 0; index < 512; index++) { const value = bytes.readFloatLE(index * 4), other = query[index]; if (!Number.isFinite(value) || !Number.isFinite(other)) throw new FacesError('invalid_embedding', '历史特征包含无效数值', 503); dot += value * other; left += value * value; right += other * other; }
  if (left < 1e-12 || right < 1e-12) throw new FacesError('invalid_embedding', '历史特征不可用', 503);
  return Math.max(-1, Math.min(1, dot / Math.sqrt(left * right)));
}
/** Dedicated face collections in the existing history DB; never text-vector collections. */
export class FacesMongo {
  private client: MongoClient | null = null; private database: Db | null = null; private signature = ''; private connecting: Promise<Db> | null = null;
  private readonly owner = randomUUID(); private sequence: Promise<unknown> = Promise.resolve();
  constructor(private readonly connection: () => Promise<FacesMongoConnection | null>) {}
  async db(): Promise<Db> {
    if (this.connecting) return this.connecting;
    this.connecting = this.connect().finally(() => { this.connecting = null; }); return this.connecting;
  }
  private async connect() {
    const config = await this.connection();
    if (!config || !/^mongodb(?:\+srv)?:\/\//.test(config.uri) || !/^[a-zA-Z0-9_-]{1,63}$/.test(config.database) || ['admin', 'config', 'local'].includes(config.database)) throw new FacesError('faces_history_unavailable', '人脸历史库尚未就绪', 503);
    const signature = JSON.stringify(config);
    if (signature === this.signature && this.database) return this.database;
    if (this.client) await this.client.close();
    this.database = null; this.signature = '';
    const client = new MongoClient(config.uri, { maxPoolSize: 2, serverSelectionTimeoutMS: 3000, connectTimeoutMS: 3000, socketTimeoutMS: 10000 });
    try {
      await client.connect(); const db = client.db(config.database), rows = db.collection<FacesMongoRow>('faces_records');
      await rows.createIndex({ kind: 1, model: 1, space_id: 1, 'data.channel_id': 1, 'data.captured_at': -1, _id: 1 });
      await rows.createIndex({ kind: 1, model: 1, state: 1, 'data.channel_id': 1, 'data.captured_at': -1, _id: 1 }, { name: FACES_HISTORY_INDEX });
      await rows.createIndex({ state: 1, expires_at: 1 });
      await rows.createIndex({ watchlist_pending: 1, state: 1, expires_at: 1, _id: 1 });
      await rows.createIndex({ purge_at: 1 }, { expireAfterSeconds: 0 });
      await db.collection('faces_query_states').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
      this.client = client; this.database = db; this.signature = signature; return db;
    } catch { await client.close().catch(() => undefined); throw new FacesError('faces_history_unavailable', '人脸历史库暂不可用', 503); }
  }
  async write<T>(work: (db: Db) => Promise<T>): Promise<T> {
    const task = this.sequence.catch(() => undefined).then(async () => {
      const db = await this.db(), now = new Date(), lease = new Date(Date.now() + 120000);
      try {
        const row = await db.collection<Document & { _id: string }>('faces_control').findOneAndUpdate({ _id: 'writer', $or: [{ owner: this.owner }, { expires_at: { $lte: now } }] }, { $set: { owner: this.owner, expires_at: lease } }, { upsert: true, returnDocument: 'after' });
        if (!row || row.owner !== this.owner) throw Error();
      } catch { throw new FacesError('faces_writer_busy', '人脸存储正在由另一实例处理，请稍后重试', 429); }
      return work(db);
    });
    this.sequence = task; return task;
  }
  async assertWriter(db: Db) {
    const active = await db.collection<Document & { _id: string }>('faces_control').findOne({ _id: 'writer', owner: this.owner, expires_at: { $gt: new Date() } });
    if (!active) throw new FacesError('faces_writer_expired', '人脸存储写入租约已失效，请使用原请求重试', 503);
  }
  async close() {
    await this.sequence.catch(() => undefined);
    if (this.database) await this.database.collection<Document & { _id: string }>('faces_control').deleteOne({ _id: 'writer', owner: this.owner }).catch(() => undefined);
    await this.client?.close(); this.database = null; this.client = null; this.signature = '';
  }
}
