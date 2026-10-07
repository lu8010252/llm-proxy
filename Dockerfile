FROM node:20-alpine

# 装时区数据,保证"每天固定时间点自动恢复"这个功能算的时间是对的
RUN apk add --no-cache tzdata
ENV TZ=Asia/Shanghai

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js config.example.json ./
COPY public ./public

RUN mkdir -p logs

EXPOSE 8787

ENV PORT=8787

CMD ["node", "server.js"]
