import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';

export async function healthz(_request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  return {
    status: 200,
    jsonBody: { status: 'ok', service: 'prakkie-api', time: new Date().toISOString() },
  };
}

app.http('healthz', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: healthz,
});
