# ===== 构建阶段 =====
FROM node:24-alpine AS builder
WORKDIR /app

# 先装依赖（缓存层）
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# 拷贝源码编译
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ===== 运行阶段 =====
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3001 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/data

# 只装生产依赖
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# 编译产物
COPY --from=builder /app/dist ./dist

# 数据卷（JSON 持久化）
VOLUME ["/app/data"]

EXPOSE 3001

CMD ["node", "dist/server.js"]
