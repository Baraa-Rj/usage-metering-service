# syntax=docker/dockerfile:1

# ---- build: compile TypeScript to dist/ ----
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY migrations ./migrations
COPY src ./src
COPY client ./client
COPY agent ./agent
COPY loadtest ./loadtest
RUN npm run build

# ---- runtime: compiled JavaScript and production dependencies only ----
# One image runs the service (default), the demo client and the agent (other commands).
FROM node:26-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/src/server.js"]
