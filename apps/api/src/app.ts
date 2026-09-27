/** Fastify application factory (no listening; main.ts or tests drive it). */
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { AstraError, type ErrorCode } from '@astra/core';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { ZodError } from 'zod';
import { TokenAuthenticator } from './auth';
import { registerRoutes } from './routes';
import type { AstraRuntime } from './runtime/runtime';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  SAFETY_BLOCK: 422,
  UNAVAILABLE: 503,
  CONFIG_INVALID: 500,
  INTERNAL: 500,
};

export interface AppOptions {
  readonly runtime: AstraRuntime;
  readonly logger: Logger;
  readonly tokens: { operator: string; automation: string; viewer?: string | undefined };
  readonly corsOrigins: readonly string[];
  readonly rateLimitPerMinute?: number;
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  // Explicit generics: a pino Logger instance would otherwise specialise the instance type.
  const app = Fastify<Server, IncomingMessage, ServerResponse, FastifyBaseLogger>({
    loggerInstance: opts.logger,
    bodyLimit: 1_048_576,
    genReqId: () => crypto.randomUUID(),
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: [...opts.corsOrigins],
    methods: ['GET', 'POST'],
    allowedHeaders: ['Authorization', 'Content-Type'],
  });
  await app.register(rateLimit, { max: opts.rateLimitPerMinute ?? 600, timeWindow: '1 minute' });

  app.setErrorHandler((err, req, reply) => {
    let status = 500;
    let code: string = 'INTERNAL';
    let message = 'internal error';
    if (err instanceof AstraError) {
      status = STATUS[err.code];
      code = err.code;
      message = err.message;
    } else if (err instanceof ZodError) {
      status = 400;
      code = 'VALIDATION';
      message = err.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; ');
    } else if (
      typeof (err as { statusCode?: number }).statusCode === 'number' &&
      (err as { statusCode: number }).statusCode < 500
    ) {
      status = (err as { statusCode: number }).statusCode;
      code = status === 429 ? 'RATE_LIMITED' : 'BAD_REQUEST';
      message = (err as Error).message;
    }
    if (status >= 500) req.log.error({ err }, 'request failed');
    void reply.status(status).send({ error: { code, message, requestId: req.id } });
  });
  app.setNotFoundHandler((req, reply) => {
    void reply.status(404).send({
      error: {
        code: 'NOT_FOUND',
        message: `route ${req.method} ${req.url} not found`,
        requestId: req.id,
      },
    });
  });

  const auth = new TokenAuthenticator(opts.tokens);
  registerRoutes(app, opts.runtime, auth);
  return app;
}
