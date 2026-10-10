# BENDER — витрина для BotHost: лендинг + морда + мини-бот.
# Рабочая папка ВНЕ /app: на части нод BotHost монтирует /app из Git и затирает
# артефакты образа (см. bothost.ru/docs/common-errors).
FROM node:20-alpine

WORKDIR /usr/src/app

COPY package.json app.js ./
COPY public ./public

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "app.js"]
