# 后端运行时镜像。
# 不需要编译步骤：本项目用 Node 的类型擦除直接跑 .ts，
# 且 tsconfig 开了 erasableSyntaxOnly（不使用 enum/参数属性等需要转译的语法）。
FROM node:24-alpine

WORKDIR /app

# 先只拷依赖清单：源码改动不会让依赖层失效
COPY package.json package-lock.json* ./
# 镜像里只要运行时依赖（typecheck 用的 typescript 不进镜像）
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src

ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    WIIB_DB=/data/prediction.sqlite \
    LIVE_DB=/data/live.sqlite

RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8787

# 用 node 自带的健康检查而不是装 curl：容器里能少一个包就少一个
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.ts"]
