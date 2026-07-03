# syntax=docker/dockerfile:1
# OmniKube web image (React SPA served by nginx, /api reverse-proxied to the api
# service). Build context = frontend/:  docker build -t twwch/omnikube:frontend-dev frontend

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . ./
# PROD build → API/WS use same-origin relative paths; nginx proxies them to api.
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
