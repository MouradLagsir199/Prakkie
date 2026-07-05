/**
 * Registry of synced entities (plan/04 §5) — drives both /v1/sync and access
 * checks. `writable` is the exhaustive set of columns a client may set; ids,
 * owner_id, updated_at and checked_by are always server-controlled.
 */

export type EntityScope =
  | 'ownerHousehold' // row carries owner_id + optional household_id
  | 'listChild' // visibility via parent app.lists
  | 'planChild' // visibility via parent app.plans
  | 'userKeyed'; // row carries user_id (notes, corrections)

export interface EntityDef {
  table: string;
  scope: EntityScope;
  writable: string[];
  /** columns that must be serialised with JSON.stringify before binding */
  jsonb: string[];
  /**
   * LWW field groups (plan/04 §5): a mutation touching any member of a group
   * must carry the whole group; groups not touched keep their server values.
   */
  fieldGroups: string[][];
  /** required columns on first insert (beyond the server-set scope columns) */
  insertRequired: string[];
  /** false ⇒ no deleted_at column; sync deletes are hard deletes */
  hasTombstone?: boolean;
}

export const SYNC_ENTITIES = {
  recipes: {
    table: 'app.recipes',
    scope: 'ownerHousehold',
    writable: [
      'household_id', 'title', 'origin', 'source_url', 'source_platform', 'source_author',
      'images', 'servings_base', 'time_prep_min', 'time_cook_min', 'ingredients', 'steps',
      'nutrition', 'missing_fields', 'tags', 'cuisine', 'diet_flags', 'last_cooked_at',
    ],
    jsonb: ['images', 'ingredients', 'steps', 'nutrition'],
    fieldGroups: [['ingredients', 'steps'], ['tags', 'cuisine', 'diet_flags']],
    insertRequired: ['title', 'origin'],
  },
  recipe_collections: {
    table: 'app.recipe_collections',
    scope: 'ownerHousehold',
    writable: ['household_id', 'name', 'sort_order'],
    jsonb: [],
    fieldGroups: [],
    insertRequired: ['name'],
  },
  recipe_notes: {
    table: 'app.recipe_notes',
    scope: 'userKeyed',
    writable: ['recipe_id', 'note_text', 'modifications'],
    jsonb: ['modifications'],
    fieldGroups: [], // one writer per row (plan/04 §5) — plain LWW is safe
    insertRequired: ['recipe_id'],
  },
  lists: {
    table: 'app.lists',
    scope: 'ownerHousehold',
    writable: ['household_id', 'name', 'layout_chain_id', 'sort_order'],
    jsonb: [],
    fieldGroups: [],
    insertRequired: ['name'],
  },
  list_items: {
    table: 'app.list_items',
    scope: 'listChild',
    writable: [
      'list_id', 'name', 'quantity', 'unit', 'item_normalised', 'aisle_group_id',
      'sort_order', 'is_manual', 'provenance', 'matches', 'checked',
    ],
    jsonb: ['provenance', 'matches'],
    fieldGroups: [['checked'], ['name', 'quantity', 'unit'], ['aisle_group_id', 'sort_order'], ['matches']],
    insertRequired: ['list_id', 'name'],
  },
  plans: {
    table: 'app.plans',
    scope: 'ownerHousehold',
    writable: ['household_id', 'week_start', 'applied_template_id'],
    jsonb: [],
    fieldGroups: [],
    insertRequired: ['week_start'],
  },
  plan_entries: {
    table: 'app.plan_entries',
    scope: 'planChild',
    writable: ['plan_id', 'recipe_id', 'entry_date', 'meal_slot', 'servings', 'sort_order'],
    jsonb: [],
    fieldGroups: [],
    insertRequired: ['plan_id', 'recipe_id', 'servings'],
  },
  plan_templates: {
    table: 'app.plan_templates',
    scope: 'ownerHousehold',
    writable: ['household_id', 'name', 'entries'],
    jsonb: ['entries'],
    fieldGroups: [],
    insertRequired: ['name'],
  },
  pantry_items: {
    table: 'app.pantry_items',
    scope: 'ownerHousehold',
    writable: ['household_id', 'name', 'item_normalised', 'quantity', 'unit', 'ean', 'source', 'expires_at'],
    jsonb: [],
    fieldGroups: [],
    insertRequired: ['name'],
  },
  match_corrections: {
    table: 'app.match_corrections',
    scope: 'userKeyed',
    writable: ['chain_id', 'item_normalised', 'chosen_sku_id', 'rejected_sku_id'],
    jsonb: [],
    fieldGroups: [],
    insertRequired: ['chain_id', 'item_normalised', 'chosen_sku_id'],
    hasTombstone: false,
  },
} satisfies Record<string, EntityDef>;

export function getEntity(name: string): EntityDef | undefined {
  return (SYNC_ENTITIES as Record<string, EntityDef>)[name];
}

/** WHERE fragment limiting rows of `def` to what $1 (user id) may see. */
export function visibilityWhere(def: EntityDef, alias = 't'): string {
  const memberHouseholds = `SELECT household_id FROM app.household_members WHERE user_id = $1`;
  switch (def.scope) {
    case 'ownerHousehold':
      return `(${alias}.owner_id = $1 OR ${alias}.household_id IN (${memberHouseholds}))`;
    case 'listChild':
      return `${alias}.list_id IN (SELECT l.id FROM app.lists l WHERE l.owner_id = $1 OR l.household_id IN (${memberHouseholds}))`;
    case 'planChild':
      return `${alias}.plan_id IN (SELECT p.id FROM app.plans p WHERE p.owner_id = $1 OR p.household_id IN (${memberHouseholds}))`;
    case 'userKeyed':
      return `${alias}.user_id = $1`;
  }
}
