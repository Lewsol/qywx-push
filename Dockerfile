FROM node:24.14.0

WORKDIR /app

ENV NODE_ENV=production

# 复制 package 文件
COPY package*.json ./

# 设置npm配置以提高稳定性
RUN npm config set registry https://registry.npmmirror.com \
    && npm config set fetch-retry-mintimeout 20000 \
    && npm config set fetch-retry-maxtimeout 120000

# 严格按锁文件安装生产依赖
RUN npm ci --omit=dev

# 复制应用代码
COPY . .

EXPOSE 12121

CMD ["npm", "start"]
