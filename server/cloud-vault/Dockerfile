FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY index.js README.md sync-db.js ./

RUN mkdir -p /var/lib/airchat-cloud-vault-example \
  && chown -R node:node /var/lib/airchat-cloud-vault-example

ENV NODE_ENV=production
ENV PORT=3010
ENV CLOUD_VAULT_DIR=/var/lib/airchat-cloud-vault-example
VOLUME ["/var/lib/airchat-cloud-vault-example"]
EXPOSE 3010

USER node
CMD ["node", "index.js"]
