# 前端镜像分两段：构建产物是需要 dev 依赖的，运行时只需要 nginx

FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
# 构建要 dev 依赖（vite/tsc），显式带上，否则宿主 NODE_ENV=production 会把它们省掉
RUN npm ci --include=dev --no-audit --no-fund

COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src

# 构建只做类型检查与打包，不打接口；/api 由 nginx 反代到后端
RUN npm run build


FROM nginx:1.27-alpine AS runtime

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1

CMD ["nginx", "-g", "daemon off;"]
