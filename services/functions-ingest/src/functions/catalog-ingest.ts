import { app } from '@azure/functions';
import { BlobServiceClient } from '@azure/storage-blob';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { connectorFor } from '../connectors';
import { ingestChain } from '../lib/ingest';

/**
 * POST /api/ops/catalog-ingest  (function-key protected)
 * body: { chain: string, blobPath: string, sweep?: boolean }
 *
 * The nightly scrape (scrapers/*.py) uploads bronze JSONL to the raw-snapshots
 * container and calls this per chain. Each call is one single-chain
 * transaction — a failing/killed chain never touches the other ten.
 */
app.http('catalog-ingest', {
  methods: ['POST'],
  authLevel: 'function',
  route: 'ops/catalog-ingest',
  handler: async (req, ctx) => {
    const body = (await req.json().catch(() => null)) as {
      chain?: string;
      blobPath?: string;
      sweep?: boolean;
    } | null;
    if (!body?.chain || !body.blobPath) {
      return { status: 400, jsonBody: { error: 'invalid_request', message: 'chain and blobPath are required' } };
    }
    const connector = connectorFor(body.chain);
    if (!connector) {
      return { status: 404, jsonBody: { error: 'unknown_chain', message: `no connector for ${body.chain}` } };
    }

    const blobService = BlobServiceClient.fromConnectionString(process.env.AzureWebJobsStorage!);
    const blob = blobService.getContainerClient('raw-snapshots').getBlockBlobClient(body.blobPath);
    const download = await blob.download();
    const lines = createInterface({ input: download.readableStreamBody as unknown as Readable });

    try {
      const result = await ingestChain(connector, body.chain, lines, { sweep: body.sweep ?? true });
      ctx.log(`catalog-ingest ${body.chain}: ${JSON.stringify(result)}`);
      return { status: 200, jsonBody: result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.error(`catalog-ingest ${body.chain} failed: ${message}`);
      return { status: 500, jsonBody: { error: 'ingest_failed', message } };
    }
  },
});
