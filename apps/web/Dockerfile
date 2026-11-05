# AgentOS web UI. Build context: repository root.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY workers/agent/package.json workers/agent/
COPY apps/web/package.json apps/web/
RUN npm ci -w apps/web --include-workspace-root=false --ignore-scripts
COPY apps/web apps/web
RUN npm run build -w apps/web

FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
