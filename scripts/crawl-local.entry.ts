// Local discovery-crawl runner (bundled via esbuild, see crawl-local.mjs usage
// in scripts/discovery-crawl-burst.md). The Azure HTTP trigger dies at the
// 230s/5min consumption limits — a local run has no such cap, so this is how
// we fill Ontdek with hundreds of recipes in one go.
// Usage: node dist --domain leukerecepten.nl --cap 400
import { crawlSource } from '../services/functions-ingest/src/crawler/crawl';

const args = process.argv.slice(2);
const domain = args[args.indexOf('--domain') + 1];
const cap = Number(args[args.indexOf('--cap') + 1] || 150);
if (!domain) throw new Error('--domain required');

const stats = await crawlSource(domain, cap);
console.log(JSON.stringify(stats));
process.exit(0);
