// Open Food Facts parquet → NL-subset met alleen de benodigde kolommen.
// DuckDB leest lokaal of via httpfs (range-requests: alleen de gefilterde
// row-groups/kolommen gaan over de lijn). Het HF-schema wisselt per export
// (product_name is soms VARCHAR, soms LIST<STRUCT(lang,text)>), dus de query
// wordt opgebouwd uit een DESCRIBE in plaats van hard aangenomen.
import { DuckDBInstance } from '@duckdb/node-api';

const sqlQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

export async function extractNlProducts(parquetSource, { country = 'en:netherlands' } = {}) {
  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  try {
    if (/^https?:/i.test(parquetSource)) {
      await conn.run('INSTALL httpfs; LOAD httpfs;');
    }
    const src = `read_parquet(${sqlQuote(parquetSource)})`;

    const described = await conn.runAndReadAll(`DESCRIBE SELECT * FROM ${src}`);
    const columns = new Map(
      described.getRowObjects().map((row) => [String(row.column_name), String(row.column_type)])
    );
    const has = (name) => columns.has(name);
    const typeOf = (name) => columns.get(name) ?? '';

    if (!has('code')) throw new Error(`OFF parquet mist kolom 'code' (${parquetSource})`);
    if (!has('product_name')) throw new Error(`OFF parquet mist kolom 'product_name'`);

    // naam: voorkeur nl → main → eerste, wanneer het de meertalige lijstvorm is
    const nameExpr = typeOf('product_name').includes('STRUCT')
      ? `coalesce(
           list_filter(product_name, x -> x.lang = 'nl')[1].text,
           list_filter(product_name, x -> x.lang = 'main')[1].text,
           product_name[1].text
         )`
      : 'product_name';

    const countryExpr = !has('countries_tags')
      ? 'true'
      : typeOf('countries_tags').startsWith('VARCHAR[')
        ? `list_contains(countries_tags, ${sqlQuote(country)})`
        : `countries_tags LIKE ${sqlQuote(`%${country}%`)}`;

    const quantityExpr = has('quantity') ? 'quantity' : 'NULL';
    const pqExpr = has('product_quantity') ? 'TRY_CAST(product_quantity AS DOUBLE)' : 'NULL';
    const pquExpr = has('product_quantity_unit') ? 'product_quantity_unit' : 'NULL';
    const brandsExpr = has('brands') ? 'brands' : 'NULL';
    const obsoleteFilter = has('obsolete') ? 'AND coalesce(obsolete, false) = false' : '';

    const reader = await conn.runAndReadAll(`
      SELECT code AS ean,
             ${nameExpr} AS name,
             ${brandsExpr} AS brands,
             ${quantityExpr} AS quantity,
             ${pqExpr} AS product_quantity,
             ${pquExpr} AS product_quantity_unit
      FROM ${src}
      WHERE ${countryExpr}
        AND code IS NOT NULL
        AND regexp_matches(code, '^(\\d{8}|\\d{12,14})$')
        ${obsoleteFilter}
    `);
    return reader.getRowObjects().map((row) => ({
      ean: row.ean === null ? null : String(row.ean),
      name: row.name === null ? null : String(row.name),
      brands: row.brands === null ? null : String(row.brands),
      quantity: row.quantity === null ? null : String(row.quantity),
      productQuantity: row.product_quantity === null ? null : Number(row.product_quantity),
      productQuantityUnit: row.product_quantity_unit === null ? null : String(row.product_quantity_unit),
    }));
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
}
