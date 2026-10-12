# AINVR Web UI

AINVR 的网页控制台，包含仪表盘、视频通道、AI 通道、实时监看、全景播放器、录像回放、识别历史、配置中心、授权与关于页面。

本目录包含完整前端源码、组件、接口客户端、静态资源、依赖锁定文件、测试和容器构建配置。品牌配置位于 `../deploy/branding/branding.yaml`，产品名及版权方均为 AINVR，联系人默认留空。

## 开发和验证

使用 `.nvmrc` 中的 Node.js 版本，然后执行：

```sh
npm ci --no-audit --no-fund
npm run dev
npm run build
npm run lint
npm run test:run -- --maxWorkers=2
```

开发页面默认监听 5173 端口，`/api` 代理到本机 3001 端口，`/live` 代理到本机 8080 端口。构建文件生成在 `dist/`。

页面数据、登录、品牌读取及业务操作依赖后端接口；复制前端并通过构建，不代表后端、AI 和录像服务已经完成移植。`nginx.conf` 的生产反向代理配置也需要在部署阶段按实际服务位置调整。

## AINVR 标识

- 软件包名：`ainvr-web-ui`。
- 浏览器存储键和内部事件使用 `ainvr` 前缀。
- 授权码文件采用 `AINVR-LIC3-` 前缀，下载申请文件采用 `AINVR-request-` 前缀。
- 视频识别 SEI 标识为 16 字节：ASCII `AINVR-SEI-v1` 加上十六进制 `00 00 00 01`。AI 服务的生产端与录像解析端必须同步采用相同标识；JSON 载荷字段保持原接口形式。
- 录像目录示例：`/home/sunrise/ainvr/data/recordings`。

AINVR 自身产品品牌和版权署名为 AINVR；第三方依赖仍保留各自原始许可。
