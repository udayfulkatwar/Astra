/**
 * Bearer-token authentication with roles (ARCHITECTURE §6). Tokens are compared as SHA-256
 * digests in constant time. Roles: viewer (read), automation (n8n), operator (human control).
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { AstraError } from '@astra/core';
import type { FastifyReply, FastifyRequest } from 'fastify';

export type Role = 'viewer' | 'automation' | 'operator';

export interface Principal {
  readonly role: Role;
  /** Stable, non-secret identity used in audit records. */
  readonly id: string;
}

const digest = (s: string) => createHash('sha256').update(s).digest();

export class TokenAuthenticator {
  private readonly entries: { hash: Buffer; principal: Principal }[];

  constructor(tokens: { operator: string; automation: string; viewer?: string | undefined }) {
    this.entries = [
      { hash: digest(tokens.operator), principal: { role: 'operator', id: 'operator' } },
      { hash: digest(tokens.automation), principal: { role: 'automation', id: 'n8n' } },
      ...(tokens.viewer
        ? [{ hash: digest(tokens.viewer), principal: { role: 'viewer' as const, id: 'viewer' } }]
        : []),
    ];
  }

  authenticate(header: string | undefined): Principal | null {
    if (!header?.startsWith('Bearer ')) return null;
    const presented = digest(header.slice('Bearer '.length).trim());
    let match: Principal | null = null;
    for (const e of this.entries) {
      // Compare against every entry (no early exit) to keep timing independent of the match.
      if (timingSafeEqual(e.hash, presented)) match = e.principal;
    }
    return match;
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

/** Route guard: the request must carry a token for one of the allowed roles. */
export function requireRole(auth: TokenAuthenticator, ...allowed: Role[]) {
  return (req: FastifyRequest, _reply: FastifyReply, done: (err?: Error) => void) => {
    const principal = auth.authenticate(req.headers.authorization);
    if (!principal) return done(new AstraError('UNAUTHORIZED', 'missing or invalid bearer token'));
    if (!allowed.includes(principal.role)) {
      return done(
        new AstraError('FORBIDDEN', `role ${principal.role} may not perform this action`),
      );
    }
    req.principal = principal;
    done();
  };
}

export const READ_ROLES: Role[] = ['viewer', 'automation', 'operator'];
