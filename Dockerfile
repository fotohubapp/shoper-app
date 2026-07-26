# FOTOhub AI for Shoper
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8811 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/data
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit
COPY --from=build /app/dist ./dist
COPY public ./public
RUN mkdir -p /app/data
VOLUME ["/app/data"]
EXPOSE 8811
CMD ["node", "dist/server.js"]
