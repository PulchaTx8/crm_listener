export async function register() {
  // Valida o ambiente no boot do servidor. Lança e impede o start se inválido.
  await import('@/lib/env');
}
