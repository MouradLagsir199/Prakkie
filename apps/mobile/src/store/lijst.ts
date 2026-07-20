import { useCallback, useMemo, useState } from 'react';
import { newId, syncNow, upsertRow, useEntityRows } from '../data';
import { activeHouseholdId } from '../data/households';

/**
 * Lijst bouwen door te winkelen (owner 2026-07-13: "categorie browsing only",
 * de AI-resolve is gesloopt): elke tik op een productrij zet dat éne concrete
 * product — keten + sku + prijs gepind — direct op dé actuele lijst
 * (lists/list_items, zelfde model als altijd). Het resultaat-scherm prijst het
 * exact via /v1/lists/{id}/price; er komt geen matcher meer aan te pas.
 * Zelfde product nóg eens getikt = aantal +1.
 */

export interface PickedProduct {
  chain: string;
  sku_id: string;
  name: string;
  /** Actuele productprijs bij de tik (bonus indien actief, anders regulier).
   *  Reist mee in matches zodat Mijn lijstje niet op de server hoeft te
   *  wachten om een bewust gekozen product eerlijk te tonen. */
  unit_cents: number;
  /** de kale zoek/categorie-term — voedt de item-sheet als de user wil wisselen */
  term?: string | null;
  /** Bewust gekozen aantal verpakkingen. */
  quantity?: number;
}

interface ListRowLite { id: string; is_current?: boolean; name: string; week_start?: string | null }
export interface SavedListSummary { id: string; name: string; itemCount: number }
interface ItemRowLite {
  id: string; list_id: string; name: string; quantity: number | string | null; unit: string | null;
  item_normalised?: string | null; aisle_group_id?: number | null; is_manual?: boolean;
  matches?: Record<string, unknown>; checked?: boolean;
  provenance?: { recipe_title?: string; title?: string }[];
}
export interface ShoppingFingerprintItem {
  id: string; list_id: string; name: string; quantity: number | string | null; unit: string | null;
  checked?: boolean;
  matches?: Record<string, { sku_id: string; user_pinned?: boolean; preferred?: boolean; unit_cents?: number | null }>;
}

export interface ShoppingItemDescriptor {
  id: string;
  fingerprint: string;
}

/** Eén canonieke inhoudssleutel, gedeeld door de tab en Mijn lijstje. */
export function shoppingItemFingerprint(item: ShoppingFingerprintItem): string {
  return [
    item.id,
    item.name,
    item.quantity ?? '',
    item.unit ?? '',
    item.checked ? 1 : 0,
    JSON.stringify(item.matches ?? {}),
  ].join(':');
}

export function shoppingItemDescriptors(items: readonly ShoppingFingerprintItem[]): ShoppingItemDescriptor[] {
  return items.map((item) => ({ id: item.id, fingerprint: shoppingItemFingerprint(item) }));
}

export function shoppingListRevision(items: readonly ShoppingFingerprintItem[]): string {
  return shoppingItemDescriptors(items).map((item) => item.fingerprint).sort().join('|');
}

export function useBoodschappenLijst() {
  const { rows: listRows } = useEntityRows('lists');
  const { rows: itemRows } = useEntityRows('list_items');
  const [lastAdded, setLastAdded] = useState<string | null>(null);

  const currentList = useMemo(
    () => listRows.map((r) => ({ ...(r.row as unknown as ListRowLite), id: r.id })).find((l) => l.is_current) ?? null,
    [listRows]
  );
  const items = useMemo(
    () =>
      itemRows
        .map((r) => ({ ...(r.row as unknown as ShoppingFingerprintItem), id: r.id }))
        .filter((i) => currentList && i.list_id === currentList.id),
    [itemRows, currentList]
  );
  const count = items.filter((i) => !i.checked).length;

  // opgeslagen lijstjes (favorieten): lijsten zonder datum, niet de actuele —
  // zelfde filter als Mijn lijstje (owner 2026-07-14: ook snel inladen vanaf
  // het eerste Boodschappen-scherm, niet alleen vanuit Mijn lijstje)
  const allItemRowsLite = useMemo(
    () => itemRows.map((r) => ({ ...(r.row as unknown as ItemRowLite), id: r.id })),
    [itemRows]
  );
  const templates = useMemo<SavedListSummary[]>(
    () =>
      listRows
        .map((r) => ({ ...(r.row as unknown as ListRowLite), id: r.id }))
        .filter((l) => !(l.week_start ?? '').slice(0, 10) && !l.is_current)
        .map((l) => ({ id: l.id, name: l.name, itemCount: allItemRowsLite.filter((i) => i.list_id === l.id).length })),
    [listRows, allItemRowsLite]
  );

  /** favoriet lijstje inladen: items komen bóven op je huidige lijst (zelfde
   *  gedrag als de laad-sheet in Mijn lijstje) */
  const loadTemplate = useCallback(
    async (templateId: string) => {
      let listId = currentList?.id ?? null;
      if (!listId) {
        listId = newId();
        await upsertRow('lists', { name: 'Mijn boodschappen', is_current: true, household_id: await activeHouseholdId() }, listId);
      }
      const tplItems = allItemRowsLite.filter((i) => i.list_id === templateId);
      for (const it of tplItems) {
        await upsertRow(
          'list_items',
          {
            list_id: listId,
            name: it.name,
            quantity: it.quantity ?? null,
            unit: it.unit ?? null,
            item_normalised: it.item_normalised ?? null,
            aisle_group_id: it.aisle_group_id ?? null,
            is_manual: !!it.is_manual,
            matches: it.matches ?? {},
            checked: false,
            ...(it.provenance ? { provenance: it.provenance } : {}),
          },
          newId()
        );
      }
      syncNow(['lists', 'list_items']).catch(() => {});
    },
    [currentList?.id, allItemRowsLite]
  );

  /** Identifies the exact local list contents for the process-memory pricing
   *  cache. No network timestamp is involved, so ordinary re-renders keep the
   *  same warm scope. */
  const itemDescriptors = useMemo(() => shoppingItemDescriptors(items), [items]);
  const revision = useMemo(
    () => itemDescriptors.map((item) => item.fingerprint).sort().join('|'),
    [itemDescriptors]
  );

  /** concreet product op de lijst — gepind op de gekozen keten, prijs exact */
  const add = useCallback(
    async (p: PickedProduct) => {
      const amount = Math.max(1, Math.min(99, Math.round(p.quantity ?? 1)));
      let listId = currentList?.id ?? null;
      if (!listId) {
        listId = newId();
        await upsertRow(
          'lists',
          { name: 'Mijn boodschappen', is_current: true, household_id: await activeHouseholdId() },
          listId
        );
      }
      // zelfde product al op de lijst? dan aantal +1 i.p.v. een dubbele regel
      const existing = items.find(
        (i) => !i.checked && i.matches?.[p.chain]?.sku_id === p.sku_id && i.matches[p.chain]?.user_pinned
      );
      if (existing) {
        const qty = Math.max(1, Number(existing.quantity) || 1) + amount;
        const currentMatch = existing.matches?.[p.chain];
        await upsertRow(
          'list_items',
          {
            list_id: listId,
            name: existing.name,
            quantity: qty,
            // Ook regels die vóór de instant-prijswijziging zijn toegevoegd,
            // krijgen bij de volgende tik de actuele lokale stuksprijs mee.
            matches: {
              ...(existing.matches ?? {}),
              [p.chain]: {
                ...currentMatch,
                sku_id: p.sku_id,
                user_pinned: true,
                preferred: true,
                unit_cents: p.unit_cents,
              },
            },
          },
          existing.id
        );
      } else {
        await upsertRow(
          'list_items',
          {
            list_id: listId,
            name: p.name,
            quantity: amount,
            unit: null,
            item_normalised: p.term?.trim() ? p.term.trim().toLowerCase() : null,
            is_manual: true,
            matches: {
              [p.chain]: {
                sku_id: p.sku_id,
                confidence: 1,
                user_pinned: true,
                preferred: true,
                unit_cents: p.unit_cents,
              },
            },
            checked: false,
          },
          newId()
        );
      }
      setLastAdded(p.name);
      syncNow(['lists', 'list_items']).catch(() => {});
    },
    [currentList?.id, items]
  );

  /** Kale regels (recept-ingrediënten, weekplan) starten zonder productkeuze.
   *  De user stelt iedere supermarkt daarna zelf samen; er wordt nooit stil
   *  een naam-suggestie als gekozen product opgeslagen. */
  const addNames = useCallback(
    async (rows: { name: string; quantity?: number | null; unit?: string | null }[]) => {
      if (!rows.length) return;
      let listId = currentList?.id ?? null;
      if (!listId) {
        listId = newId();
        await upsertRow(
          'lists',
          { name: 'Mijn boodschappen', is_current: true, household_id: await activeHouseholdId() },
          listId
        );
      }
      for (const r of rows) {
        await upsertRow(
          'list_items',
          {
            list_id: listId,
            name: r.name,
            quantity: r.quantity ?? 1,
            unit: r.unit ?? null,
            item_normalised: r.name.toLowerCase(),
            is_manual: true,
            matches: {},
            checked: false,
          },
          newId()
        );
      }
      setLastAdded(rows[rows.length - 1]!.name);
      syncNow(['lists', 'list_items']).catch(() => {});
    },
    [currentList?.id]
  );

  return {
    count,
    lastAdded,
    add,
    addNames,
    templates,
    loadTemplate,
    currentListId: currentList?.id ?? null,
    itemIds: items.map((item) => item.id),
    itemDescriptors,
    revision,
  };
}
