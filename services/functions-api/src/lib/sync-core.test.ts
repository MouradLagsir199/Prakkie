import { describe, expect, it } from 'vitest';
import { SYNC_ENTITIES } from './entities';
import { bindValue, decideFields } from './sync-core';

const listItems = SYNC_ENTITIES.list_items;

describe('decideFields — LWW per field group (plan/04 §5)', () => {
  it('no conflict: base equals server → every provided field applies', () => {
    const t = '2026-07-05T10:00:00.000Z';
    const { apply, conflict } = decideFields(listItems, { name: 'ui', quantity: 2 }, t, t);
    expect(conflict).toBe(false);
    expect(apply).toEqual({ name: 'ui', quantity: 2 });
  });

  it('conflict: only touched groups win, ungrouped fields still apply', () => {
    const { apply, conflict } = decideFields(
      listItems,
      { checked: true, is_manual: true }, // {checked} group + ungrouped is_manual
      '2026-07-05T09:00:00.000Z',
      '2026-07-05T10:00:00.000Z' // server row is newer → conflict
    );
    expect(conflict).toBe(true);
    expect(apply).toEqual({ checked: true, is_manual: true });
  });

  it('conflict: partial group send applies only the provided members', () => {
    const { apply } = decideFields(
      listItems,
      { name: 'bosui' }, // group is {name, quantity, unit}
      null, // client never saw the row → conflict path
      '2026-07-05T10:00:00.000Z'
    );
    expect(apply).toEqual({ name: 'bosui' });
  });

  it('filters non-writable fields (checked_by can never come from a client)', () => {
    const t = '2026-07-05T10:00:00.000Z';
    const { apply } = decideFields(listItems, { checked_by: 'evil', checked: true }, t, t);
    expect(apply).toEqual({ checked: true });
  });

  it('recipes conflict: {ingredients,steps} group applies as a unit', () => {
    const recipes = SYNC_ENTITIES.recipes;
    const { apply, conflict } = decideFields(
      recipes,
      { ingredients: [], steps: [{ order: 1, text: 'roer' }], title: 'Nasi' },
      '2026-07-05T09:00:00.000Z',
      '2026-07-05T10:00:00.000Z'
    );
    expect(conflict).toBe(true);
    expect(Object.keys(apply).sort()).toEqual(['ingredients', 'steps', 'title']);
  });
});

describe('bindValue', () => {
  it('stringifies jsonb columns and passes scalars through', () => {
    expect(bindValue(listItems, 'matches', { ah: { sku_id: 'x' } })).toBe('{"ah":{"sku_id":"x"}}');
    expect(bindValue(listItems, 'name', 'bosui')).toBe('bosui');
    expect(bindValue(listItems, 'matches', null)).toBeNull();
  });
});
