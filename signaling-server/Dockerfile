FROM node:22-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY index.js ./

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

USER node
CMD ["node", "index.js"]
