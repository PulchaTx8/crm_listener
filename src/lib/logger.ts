import pino from 'pino';

const REDACT_PATHS = [
  'password',
  '*.password',
  'token',
  '*.token',
  'authorization',
  '*.authorization',
  'service_role',
  '*.service_role',
  'cpf',
  '*.cpf',
  'passaporte',
  '*.passaporte',
  'secret',
  '*.secret',
];

export interface Logger extends pino.Logger {
  withCorrelation(id: string): Logger;
}

export function createLogger(destination?: pino.DestinationStream): Logger {
  const base = pino(
    { level: process.env.LOG_LEVEL ?? 'info', redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } },
    destination,
  );
  return attach(base);
}

function attach(instance: pino.Logger): Logger {
  const logger = instance as Logger;
  logger.withCorrelation = (id: string) => attach(instance.child({ correlationId: id }));
  return logger;
}

export const logger = createLogger();
