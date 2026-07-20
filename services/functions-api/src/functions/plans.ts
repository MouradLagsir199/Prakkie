import { z } from 'zod';
import { MealSlot } from '@prakkie/shared';
import { registerCrud } from '../lib/crud';
import { SYNC_ENTITIES } from '../lib/entities';

/** /v1/plans + /v1/plan-entries + /v1/plan-templates — mockup 05 backend. */

const PlanBody = z.object({
  household_id: z.string().uuid().nullable().optional(),
  week_start: z.string().date(),
  applied_template_id: z.string().uuid().nullable().optional(),
});

registerCrud({
  name: 'plans',
  route: 'v1/plans',
  def: SYNC_ENTITIES.plans,
  createSchema: PlanBody,
  updateSchema: PlanBody.partial(),
  filters: { week_start: 't.week_start = ' },
});

const PlanEntryBody = z.object({
  plan_id: z.string().uuid(),
  // recept óf los cataloog-product (title + quantity/unit) — geen vrije tekst
  // meer, anders klopt de import naar het boodschappenlijstje niet (owner 2026-07-10)
  recipe_id: z.string().uuid().nullable().optional(),
  title: z.string().min(1).max(200).nullable().optional(),
  quantity: z.number().positive().nullable().optional(),
  unit: z.string().max(20).nullable().optional(),
  image_url: z.string().url().nullable().optional(),
  entry_date: z.string().date().nullable().optional(), // null = "Zonder datum" strip (H3)
  meal_slot: MealSlot.optional(),
  servings: z.number().int().positive(),
  sort_order: z.number().int().optional(),
});

registerCrud({
  name: 'plan-entries',
  route: 'v1/plan-entries',
  def: SYNC_ENTITIES.plan_entries,
  createSchema: PlanEntryBody,
  updateSchema: PlanEntryBody.partial(),
  filters: { plan_id: 't.plan_id = ' },
});

const PlanTemplateBody = z.object({
  household_id: z.string().uuid().nullable().optional(),
  name: z.string().min(1),
  entries: z
    .array(
      z.object({
        weekday: z.number().int().min(0).max(6).nullable(),
        meal_slot: MealSlot,
        recipe_id: z.string().uuid(),
        servings: z.number().int().positive(),
      })
    )
    .optional(),
});

registerCrud({
  name: 'plan-templates',
  route: 'v1/plan-templates',
  def: SYNC_ENTITIES.plan_templates,
  createSchema: PlanTemplateBody,
  updateSchema: PlanTemplateBody.partial(),
});
