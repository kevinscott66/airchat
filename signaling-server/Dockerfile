FROM node:22-alpine

# su-exec — чтобы сбросить права после chown на том. Без него выбор был бы
# между «работать от root» и «не иметь права писать в базу токенов».
RUN apk add --no-cache su-exec

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY index.js push.js wire.js tokenStore.js ./
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "index.js"]
