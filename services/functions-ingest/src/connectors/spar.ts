import {
  euroToCents,
  parsePackSize,
  type BronzeEnvelope,
  type ChainConnector,
  type NormalizedProduct,
} from './types';

/**
 * SPAR silver parser — bronze rows from scrapers/spar.py (product page
 * JSON-LD Product + parsed "product information" HTML sections).
 * raw = { url, json_ld_product, json_ld_offer, breadcrumbs, package,
 *         price_jsonld/price_visible/price_data_layer, availability, images, ... }.
 * No promo data on product pages; SPAR applies offers in the cart, so price
 * coverage is honestly partial — unpriced rows are skipped (null).
 */

interface SparOffer {
  price?: string | number | null;
  url?: string | null;
  availability?: string | null;
}

interface SparJsonLdProduct {
  name?: string | null;
  brand?: string | null;
  category?: string | null;
  image?: string | null;
  sku?: string | null;
  gtin13?: string | null;
  gtin?: string | null;
  gtin14?: string | null;
  gtin8?: string | null;
  url?: string | null;
  offers?: SparOffer | null;
}

interface SparRaw {
  url?: string | null;
  canonical_url?: string | null;
  json_ld_product?: SparJsonLdProduct | null;
  json_ld_offer?: SparOffer | null;
  breadcrumbs?: { position?: string; name?: string; url?: string }[] | null;
  product_name?: string | null;
  brand?: string | null;
  package?: string | null;
  sku?: string | null;
  gtin13?: string | null;
  price_jsonld?: string | null;
  price_visible?: string | null;
  price_data_layer?: string | null;
  availability?: string | null;
  images?: string[] | null;
  product_information_sections?: Record<
    string,
    { title?: string; text?: string; articles?: Record<string, string> }
  > | null;
}

/** SPAR writes long-form Dutch units ("355 Milliliter", "340 Gram") — shorten for parsePackSize. */
function normalisePackText(text: string | null | undefined): string | null {
  if (!text) return null;
  return text
    .toLowerCase()
    .replace(/milliliter/g, 'ml')
    .replace(/kilogram/g, 'kg');
}

export const sparConnector: ChainConnector = {
  chainId: 'spar',
  capabilities: { promos: false, eans: true, deepLinks: true, fullAssortment: true },

  parse(envelope: BronzeEnvelope): NormalizedProduct | null {
    const raw = envelope.raw as SparRaw;
    const jsonld = raw.json_ld_product ?? null;

    const name = jsonld?.name ?? raw.product_name ?? null;
    const ean =
      jsonld?.gtin13 ?? jsonld?.gtin ?? jsonld?.gtin14 ?? jsonld?.gtin8 ?? raw.gtin13 ?? null;
    const skuId = jsonld?.sku ?? raw.sku ?? ean;
    if (!skuId || !name) return null;

    const offer = jsonld?.offers ?? raw.json_ld_offer ?? null;
    const priceCents = euroToCents(
      offer?.price ?? raw.price_jsonld ?? raw.price_visible ?? raw.price_data_layer
    );
    if (priceCents === null) return null; // unpriced rows are useless for comparison

    const packText =
      raw.package ??
      raw.product_information_sections?.['omschrijving']?.articles?.['inhoud_en_gewicht'];
    const pack = parsePackSize(normalisePackText(packText));

    // breadcrumbs end with the product itself — categories are everything before it
    const categoryPath = (raw.breadcrumbs ?? [])
      .slice(0, -1)
      .map((b) => b.name)
      .filter((n): n is string => !!n);

    const availability = offer?.availability ?? raw.availability ?? null;
    const brand = jsonld?.brand || raw.brand || null; // "" → null

    return {
      skuId: String(skuId),
      ean: ean ? String(ean) : null,
      name,
      brand,
      packSizeValue: pack.value,
      packSizeUnit: pack.unit,
      priceCents,
      unitPriceCentsPerStd: null,
      stdUnit: null,
      promo: null,
      categoryPath: categoryPath.length ? categoryPath : jsonld?.category ? [jsonld.category] : [],
      imageUrl: jsonld?.image ?? raw.images?.[0] ?? null,
      productUrl: jsonld?.url ?? offer?.url ?? raw.canonical_url ?? raw.url ?? null,
      available: availability === null || /InStock|LimitedAvailability|PreOrder/i.test(availability),
    };
  },
};
