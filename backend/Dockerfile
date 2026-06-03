FROM node:20-alpine

# Install system dependencies needed for Prisma and OpenSSL
RUN apk add --no-cache openssl libc6-compat

WORKDIR /usr/src/app

COPY package.json ./
RUN npm install --legacy-peer-deps

COPY . .

EXPOSE 5000

CMD ["npm", "run", "dev"]
