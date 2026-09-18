# Stage 1: Build Web UI
FROM node:20-alpine AS builder
WORKDIR /app/webui
COPY webui/package*.json ./
RUN npm install
COPY webui/ ./
RUN npm run build

# Stage 2: Production Run
FROM node:20-alpine
RUN apk add --no-cache curl
WORKDIR /app

COPY package*.json ./
COPY . .
COPY --from=builder /app/webui/dist ./webui/dist

ENV DOWNLOAD_DIR=/downloads
ENV TZ=Asia/Jakarta
ENV WEB_GUI=true

EXPOSE 8080
VOLUME ["/downloads"]

CMD ["node", "server/index.js"]
