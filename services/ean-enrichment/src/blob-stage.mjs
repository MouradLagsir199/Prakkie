// OFF-parquet cache in stprakkie<env>/openfoodfacts: één server-side kopie
// per venster (geen 4 GB door de job-replica heen), daarna leest DuckDB de
// blob rechtstreeks met een kortlevende user-delegation-SAS via httpfs.
import { DefaultAzureCredential } from '@azure/identity';
import {
  BlobSASPermissions,
  BlobServiceClient,
  generateBlobSASQueryParameters,
} from '@azure/storage-blob';

/** HF `resolve`-URL's redirecten naar een CDN; Azure copy-from-URL volgt geen
 *  redirects, dus we lossen de redirect zelf op. */
async function resolveRedirects(url) {
  const head = await fetch(url, { method: 'HEAD', redirect: 'follow' });
  if (head.ok) return head.url;
  // sommige CDN's weigeren HEAD — minimale GET met Range
  const get = await fetch(url, { headers: { Range: 'bytes=0-0' }, redirect: 'follow' });
  if (!get.ok && get.status !== 206) throw new Error(`OFF-bron onbereikbaar: ${get.status} ${url}`);
  await get.body?.cancel?.();
  return get.url;
}

export async function stageParquetInBlob({
  accountName,
  sourceUrl,
  containerName = 'openfoodfacts',
  blobName = 'food.parquet',
  maxAgeDays = 20,
  credential = new DefaultAzureCredential(),
  log = console.log,
}) {
  const service = new BlobServiceClient(`https://${accountName}.blob.core.windows.net`, credential);
  const container = service.getContainerClient(containerName);
  await container.createIfNotExists();
  const blob = container.getBlockBlobClient(blobName);

  const props = await blob.getProperties().catch(() => null);
  const ageMs = props ? Date.now() - new Date(props.lastModified).getTime() : Infinity;
  if (ageMs > maxAgeDays * 24 * 3600 * 1000) {
    const directUrl = await resolveRedirects(sourceUrl);
    log(`OFF-parquet verversen in blob (${blobName}) vanaf ${sourceUrl}…`);
    const poller = await blob.beginCopyFromURL(directUrl);
    const result = await poller.pollUntilDone();
    if (result.copyStatus !== 'success') throw new Error(`Blob-kopie mislukt: ${result.copyStatus}`);
    log('OFF-parquet gekopieerd naar blob.');
  } else {
    log(`OFF-parquet in blob is ${Math.round(ageMs / 864e5)} dagen oud — hergebruikt.`);
  }

  const startsOn = new Date(Date.now() - 5 * 60 * 1000);
  const expiresOn = new Date(Date.now() + 6 * 3600 * 1000);
  const delegationKey = await service.getUserDelegationKey(startsOn, expiresOn);
  const sas = generateBlobSASQueryParameters(
    {
      containerName,
      blobName,
      permissions: BlobSASPermissions.parse('r'),
      startsOn,
      expiresOn,
    },
    delegationKey,
    accountName
  ).toString();
  return `${blob.url}?${sas}`;
}
