FROM node:22-slim

WORKDIR /app

# Cloud Run's sandbox launcher uses the container's Node runtime to execute
# generated code in isolated, temporary sandboxes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production
EXPOSE 8080

CMD ["npm", "start"]
