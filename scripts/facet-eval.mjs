// Facet-eval — de release-poort van matching v2 Fase 0
// (docs/09_matching_architecture.md §7).
//
// Meet facet-precisie per categorie tegen een hand-gelabelde golden set, en
// controleert de anti-"wit brood"-poort (verify moet de bakmix uitsluiten).
//
// Twee modi:
//   live    : roept OpenAI aan om de facetten te extraheren (heeft OPENAI_API_KEY
//             of KEY_VAULT_NAME nodig). Standaard.
//   offline : FACET_EXTRACTION_FILE=<json {id: facets}> — evalueert een eerder
//             opgeslagen extractie zonder netwerk (voor herhaalbare CI/regressie).
//
// Poort: overall facet-accuraatheid ≥ FACET_BAR (default 0.90) EN alle
// verify-gate-verwachtingen kloppen. Exit 1 bij falen.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { extractFacets, normalizeFacets, resolveApiKey } from '../services/ean-enrichment/src/facet-extract.mjs';
import { verifyFacets } from '../services/ean-enrichment/src/facets.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = resolve(HERE, '../services/ean-enrichment/fixtures/facet-golden.json');
const BAR = Number(process.env.FACET_BAR ?? '0.90');
const FACET_KEYS = ['category', 'brand_tier', 'variant', 'flavor', 'form', 'type'];

const norm = (v) => (v == null || v === '' ? null : String(v).toLowerCase());
const sameSet = (a = [], b = []) =>
  a.length === b.length && [...a].map(norm).sort().join(',') === [...b].map(norm).sort().join(',');

function compareFacets(got, exp) {
  const wrong = [];
  for (const k of FACET_KEYS) if (norm(got[k]) !== norm(exp[k])) wrong.push(k);
  if (!sameSet(got.dietary, exp.dietary)) wrong.push('dietary');
  return { total: FACET_KEYS.length + 1, wrong };
}

async function loadExtractions(golden) {
  const file = process.env.FACET_EXTRACTION_FILE;
  if (file) {
    const raw = JSON.parse(await readFile(resolve(file), 'utf8'));
    return new Map(Object.entries(raw).map(([id, f]) => [id, normalizeFacets(f)]));
  }
  const apiKey = await resolveApiKey();
  const out = new Map();
  for (const item of golden) {
    process.stdout.write(`  extractie: ${item.id}…\r`);
    out.set(item.id, await extractFacets(item.raw, { apiKey }));
  }
  process.stdout.write('\n');
  return out;
}

async function main() {
  const golden = JSON.parse(await readFile(GOLDEN, 'utf8'));
  const extractions = await loadExtractions(golden);

  const perCat = new Map(); // category → {correct, total}
  let correct = 0;
  let total = 0;
  const facetMisses = [];
  const gateMisses = [];

  for (const item of golden) {
    const got = extractions.get(item.id);
    if (!got) { gateMisses.push(`${item.id}: geen extractie`); continue; }

    // Vergelijk de FINALE facetstruct (na schap-form-merge), want dat is wat het
    // systeem daadwerkelijk gebruikt — niet de rauwe LLM-output.
    const { verified, facets: finalFacets } = verifyFacets(got, item.raw);
    const { wrong, total: t } = compareFacets(finalFacets, item.expected);
    correct += t - wrong.length;
    total += t;
    const cat = item.expected.category;
    const acc = perCat.get(cat) ?? { correct: 0, total: 0 };
    acc.correct += t - wrong.length;
    acc.total += t;
    perCat.set(cat, acc);
    if (wrong.length) facetMisses.push(`${item.id}: fout op ${wrong.join(', ')}`);

    // verify-gate (anti-"wit brood"): verified moet matchen met de verwachting
    if (typeof item.expect_verified === 'boolean' && verified !== item.expect_verified) {
      gateMisses.push(`${item.id}: verified=${verified}, verwacht ${item.expect_verified}`);
    }
  }

  const overall = total ? correct / total : 0;
  console.log('\n=== Facet-eval (matching v2, Fase 0) ===');
  console.log(`items: ${golden.length}   modus: ${process.env.FACET_EXTRACTION_FILE ? 'offline' : 'live'}\n`);
  console.log('facet-accuraatheid per categorie:');
  for (const [cat, { correct: c, total: t }] of [...perCat].sort()) {
    console.log(`  ${cat.padEnd(20)} ${(c / t * 100).toFixed(1).padStart(5)}%  (${c}/${t})`);
  }
  console.log(`\n  OVERALL              ${(overall * 100).toFixed(1).padStart(5)}%  (${correct}/${total})`);

  if (facetMisses.length) {
    console.log('\nfacet-missers:');
    for (const m of facetMisses) console.log(`  - ${m}`);
  }
  console.log('\nverify-gate (moet 0 missers zijn):');
  console.log(gateMisses.length ? gateMisses.map((m) => `  ✗ ${m}`).join('\n') : '  ✓ alle verify-verwachtingen kloppen');

  const gatePass = gateMisses.length === 0;
  const barPass = overall >= BAR;
  console.log(`\nPoort: facet ≥ ${(BAR * 100).toFixed(0)}% → ${barPass ? 'PASS' : 'FAIL'}   verify-gate → ${gatePass ? 'PASS' : 'FAIL'}`);
  const ok = gatePass && barPass;
  console.log(ok ? '\n✅ GO — Fase 0 gehaald.' : '\n❌ NO-GO — onder de drempel; niet auto-toepassen.');
  process.exit(ok ? 0 : 1);
}

main().catch((err) => { console.error('facet-eval mislukt:', err); process.exit(2); });
