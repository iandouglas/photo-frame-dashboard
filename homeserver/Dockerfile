FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public

# State (pomodoro, alert ACKs) lives on a volume; run as the unprivileged node user.
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production \
    PORT=8080 \
    STATE_FILE=/data/state.json \
    TZ=UTC
USER node
EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
