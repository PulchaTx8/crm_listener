export async function register() {
  // Valida o ambiente no boot do servidor. Lança e impede o start se inválido.
  // O Next 15 engole a rejeição da promise devolvida por `register()`
  // (NextNodeServer.prepare().catch(...) em next-server.js) — sem o exit
  // explícito abaixo, o processo ficaria vivo respondendo 500 em toda
  // requisição, e um orquestrador (Docker/k8s/compose) veria um contêiner
  // "saudável" rodando um app quebrado. O process.exit(1) garante o sinal
  // certo: contêiner falho, não vivo servindo erro.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  try {
    await import('@/lib/env');
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
