FROM node:22-slim

WORKDIR /app

# Copy package.json and install dependencies
COPY package.json package-lock.json* ./
RUN npm install

# Copy the rest of the application
COPY . .

# Expose the Wrangler dev server port
EXPOSE 8787

# Run the dev server
CMD ["npm", "run", "dev"]
