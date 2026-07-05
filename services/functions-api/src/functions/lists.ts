import { z } from 'zod';
import { ChainId, ListItemProvenance } from '@prakkie/shared';
import { registerCrud } from '../lib/crud';
import { SYNC_ENTITIES } from '../lib/entities';

/** /v1/lists + /v1/list-items — multiple named lists (G5) and their lines. */

const ListBody = z.object({
  household_id: z.string().uuid().nullable().optional(),
  name: z.string().min(1),
  layout_chain_id: ChainId.optional(),
  sort_order: z.number().int().optional(),
});

registerCrud({
  name: 'lists',
  route: 'v1/lists',
  def: SYNC_ENTITIES.lists,
  createSchema: ListBody,
  updateSchema: ListBody.partial(),
});

const ListItemBody = z.object({
  list_id: z.string().uuid(),
  name: z.string().min(1),
  quantity: z.number().nullable().optional(),
  unit: z.string().nullable().optional(),
  item_normalised: z.string().nullable().optional(),
  aisle_group_id: z.number().int().nullable().optional(),
  sort_order: z.number().int().optional(),
  is_manual: z.boolean().optional(),
  provenance: z.array(ListItemProvenance).optional(),
  matches: z.record(z.unknown()).optional(),
  checked: z.boolean().optional(),
});

registerCrud({
  name: 'list-items',
  route: 'v1/list-items',
  def: SYNC_ENTITIES.list_items,
  createSchema: ListItemBody,
  updateSchema: ListItemBody.partial(),
  filters: { list_id: 't.list_id = ' },
});
