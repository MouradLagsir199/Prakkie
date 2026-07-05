import { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { z } from 'zod';
import { verifyAccessToken, type AccessClaims } from './auth';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown
  ) {
    super(message);
  }
}

export function json(status: number, body: unknown): HttpResponseInit {
  return { status, jsonBody: body };
}

export async function parseBody<T extends z.ZodTypeAny>(req: HttpRequest, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON');
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new HttpError(400, 'validation_failed', 'Request body failed validation', result.error.flatten());
  }
  return result.data;
}

export async function requireAuth(req: HttpRequest): Promise<AccessClaims> {
  const header = req.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw new HttpError(401, 'unauthorized', 'Missing bearer token');
  try {
    return await verifyAccessToken(token);
  } catch {
    throw new HttpError(401, 'unauthorized', 'Invalid or expired token');
  }
}

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<HttpResponseInit>;

/** Uniform error envelope; HttpError → its status, anything else → logged 500. */
export function handler(fn: Handler): Handler {
  return async (req, ctx) => {
    try {
      return await fn(req, ctx);
    } catch (err) {
      if (err instanceof HttpError) {
        return json(err.status, { error: err.code, message: err.message, details: err.details });
      }
      ctx.error('Unhandled error', err);
      return json(500, { error: 'internal', message: 'Internal server error' });
    }
  };
}
