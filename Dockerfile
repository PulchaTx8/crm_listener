# syntax=docker/dockerfile:1
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# NEXT_PUBLIC_* variables are inlined into the client bundle during `next build`
# — setting them only in the runtime environment (EasyPanel's Environment tab)
# does NOT reach an already-compiled bundle. They have to arrive as build args.
# NEVER declare SUPABASE_SERVICE_ROLE_KEY as an ARG: build args are baked into
# the image layers and become a leaked secret.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
# Deliberately scoped to the build stage: the secrets do not exist during
# `next build`. If it leaks into runtime, `src/lib/env.ts` falls into the loose
# branch and the app starts with no configuration, failing on the first query.
ENV SKIP_ENV_VALIDATION=1
RUN npm run build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
# Next's standalone entrypoint is generated with
# `const hostname = process.env.HOSTNAME || '0.0.0.0'`, and Docker ALWAYS injects
# HOSTNAME with the container ID. Without this line the process listens only on
# the IP that hostname resolves to — never on 0.0.0.0, never on 127.0.0.1.
# Behind EasyPanel the container joins two networks (the service one and the
# Traefik proxy one), so the proxy may hit an interface with no listener → 502,
# and a health check on localhost would never work. The image's ENV takes
# precedence over the value injected by the daemon.
ENV HOSTNAME=0.0.0.0
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
# `wget` comes from BusyBox on node:24-alpine. The /api/health route does not
# touch the database on purpose: a Supabase blip must not become a container
# restart.
#
# The port must NOT be hardcoded: deploy platforms override PORT (EasyPanel
# injects 80), and Next listens on the effective value. A healthcheck pinned to
# 3000 would hit a port with no listener and mark the container unhealthy
# forever. This is the shell form, so ${PORT} expands at runtime.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-3000}/api/health || exit 1
CMD ["node", "server.js"]
