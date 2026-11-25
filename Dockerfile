# 亚马逊卖家助手 · 生产镜像
# 构建：docker build -t amazon-seller-tools .
# 或：  docker compose up -d --build
FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8000

COPY --chown=node:node package.json server.js index.html ./

USER node
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
