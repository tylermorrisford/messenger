# syntax=docker/dockerfile:1
FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml prisma.config.ts ./
COPY client/package.json client/
COPY prisma ./prisma

FROM base AS build
RUN pnpm install --frozen-lockfile --filter messenger-api
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm prisma generate
RUN pnpm build

# prisma stays in dependencies so this image can also run `prisma migrate deploy`
FROM base AS prod-deps
RUN pnpm install --frozen-lockfile --filter messenger-api --prod
RUN pnpm prisma generate

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/package.json /app/prisma.config.ts ./
COPY --from=prod-deps /app/prisma ./prisma
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
