// 启动入口
import './services/httpRuntime.js';
import { buildApp } from './app.js';

const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.HOST || '0.0.0.0';

async function main() {
  const app = await buildApp();

  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`[server] SRS Web Console BFF 已启动: http://${HOST}:${PORT}`);
    console.log(`[server] 数据目录: ${process.cwd()}/data`);
  } catch (err) {
    console.error('[server] 启动失败:', err);
    process.exit(1);
  }
}

main();
