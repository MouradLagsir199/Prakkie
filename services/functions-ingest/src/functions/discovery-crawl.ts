import { app } from '@azure/functions';
import { crawlSource } from '../crawler/crawl';
import { query } from '../lib/db';

/**
 * WS7 crawler triggers: weekly timer walks all enabled sources sequentially
 * (politeness beats speed); admin HTTP trigger crawls one source on demand.
 */

app.http('discovery-crawl', {
  methods: ['POST'],
  authLevel: 'function',
  route: 'ops/discovery-crawl',
  handler: async (req, ctx) => {
    const body = (await req.json().catch(() => ({}))) as { domain?: string; cap?: number };
    if (!body.domain) return { status: 400, jsonBody: { error: 'domain required' } };
    try {
      const stats = await crawlSource(body.domain, body.cap ?? 150);
      ctx.log(`discovery-crawl ${body.domain}: ${JSON.stringify(stats)}`);
      return { status: 200, jsonBody: stats };
    } catch (err) {
      return { status: 500, jsonBody: { error: String(err instanceof Error ? err.message : err) } };
    }
  },
});

// zondagnacht 03:00 UTC — weekly refresh inside politeness rules
app.timer('discovery-crawl-weekly', {
  schedule: '0 0 3 * * 0',
  handler: async (_timer, ctx) => {
    const sources = await query<{ domain: string }>(
      `SELECT domain FROM discovery.crawl_sources WHERE enabled
       AND domain NOT IN (SELECT domain FROM discovery.blocklist)`
    );
    for (const { domain } of sources.rows) {
      try {
        const stats = await crawlSource(domain, 150);
        ctx.log(`weekly crawl ${domain}: saved ${stats.saved}/${stats.discovered}`);
      } catch (err) {
        ctx.error(`weekly crawl ${domain} failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  },
});
