# ===== 构建阶段 =====
FROM node:24-alpine AS builder
WORKDIR /app

# 先装依赖（缓存层）
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# 拷贝源码构建
COPY vite.config.ts tsconfig.json tsconfig.app.json tsconfig.node.json index.html tailwind.config.js postcss.config.js ./
COPY public/ ./public/
COPY src/ ./src/
RUN npm run build

# ===== 运行阶段（nginx）=====
FROM nginx:alpine AS runtime

# 拷贝 nginx 配置
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --chmod=755 25-trusted-proxy.sh /docker-entrypoint.d/25-trusted-proxy.sh

# 拷贝静态资源
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
