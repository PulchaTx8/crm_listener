export async function register() {
  // Validates the environment at server boot. Throws and prevents startup if
  // invalid. Next 15 swallows the rejection of the promise returned by
  // `register()` (NextNodeServer.prepare().catch(...) in next-server.js) —
  // without the explicit exit below, the process would stay alive answering 500
  // on every request, and an orchestrator (Docker/k8s/compose) would see a
  // "healthy" container running a broken app. The process.exit(1) sends the
  // right signal: failed container, not a live one serving errors.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  try {
    await import('@/lib/env');
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
