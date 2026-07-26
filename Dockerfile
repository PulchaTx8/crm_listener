# syntax=docker/dockerfile:1
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# As variáveis NEXT_PUBLIC_* são inlined no bundle do cliente durante o
# `next build` — defini-las apenas no ambiente de runtime (aba Environment do
# EasyPanel) NÃO alcança um bundle já compilado. Precisam chegar como build args.
# NUNCA declarar SUPABASE_SERVICE_ROLE_KEY como ARG: build args ficam gravados
# nas camadas da imagem e viram segredo vazado.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
# Escopo deliberadamente restrito ao estágio de build: os segredos não existem
# durante o `next build`. Se vazar para o runtime, `src/lib/env.ts` cai no ramo
# frouxo e o app sobe sem configuração nenhuma, falhando na primeira query.
ENV SKIP_ENV_VALIDATION=1
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
# O entrypoint standalone do Next é gerado com
# `const hostname = process.env.HOSTNAME || '0.0.0.0'`, e o Docker SEMPRE injeta
# HOSTNAME com o ID do contêiner. Sem esta linha o processo escuta só no IP que
# aquele hostname resolve — nunca em 0.0.0.0, nunca em 127.0.0.1. Atrás do
# EasyPanel o contêiner entra em duas redes (a do serviço e a do proxy Traefik),
# então o proxy pode acertar uma interface sem listener → 502, e um health check
# em localhost nunca funcionaria. O ENV da imagem tem precedência sobre o valor
# injetado pelo daemon.
ENV HOSTNAME=0.0.0.0
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
# `wget` vem do BusyBox na node:22-alpine. A rota /api/health não toca no banco
# de propósito: uma oscilação do Supabase não pode virar restart de contêiner.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server.js"]
