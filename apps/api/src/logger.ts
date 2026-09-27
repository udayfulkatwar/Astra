import pino, { type Logger } from 'pino';

/** Structured JSON logger with secret redaction (spec §15, ARCHITECTURE §12). */
export function createLogger(level: string): Logger {
  return pino({
    level,
    base: { service: 'astra-api' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        '*.token',
        '*.password',
        '*.apiKey',
        '*.secret',
        'headers.authorization',
      ],
      censor: '[REDACTED]',
    },
  });
}
