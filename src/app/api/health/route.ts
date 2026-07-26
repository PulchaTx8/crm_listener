import { NextResponse } from 'next/server';

// Sem isto o Next otimiza a rota estaticamente no build e o HEALTHCHECK passa a
// medir um arquivo pré-renderizado em vez do processo vivo.
export const dynamic = 'force-dynamic';

/**
 * Liveness probe consumida pelo `HEALTHCHECK` do Dockerfile e pelo proxy do
 * EasyPanel.
 *
 * Deliberadamente trivial: **não toca no banco**. Um health check que consulta o
 * Supabase transforma uma oscilação do banco em restart de contêiner — o app
 * continua vivo e capaz de servir páginas, então derrubá-lo só piora o incidente.
 * A validação de configuração já acontece no boot (`src/instrumentation.ts`), de
 * modo que um contêiner mal configurado sequer chega a responder aqui.
 */
export function GET() {
  return NextResponse.json({ status: 'ok', uptime: Math.round(process.uptime()) });
}
