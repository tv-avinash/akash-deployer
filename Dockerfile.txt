FROM node:20-slim

# Install Akash CLI
RUN apt-get update && apt-get install -y curl ca-certificates jq && rm -rf /var/lib/apt/lists/* \
 && curl -sL https://raw.githubusercontent.com/akash-network/node/main/client/install.sh | bash \
 && mv /root/bin/akash /usr/local/bin/akash \
 && akash version || true

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .

# Import key on container start if needed
CMD ["node", "server.js"]
