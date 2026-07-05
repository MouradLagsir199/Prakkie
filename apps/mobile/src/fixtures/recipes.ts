/**
 * Fixture data for building screens before the backend lands (WS4 lane 3).
 * Shapes follow @prakkie/shared Recipe loosely; replaced by API data in WS1/WS5.
 */

export interface FixtureRecipe {
  id: string;
  title: string;
  imageUrl: string;
  timeTotalMin: number;
  pricePerPortionCents: number;
  bonusTip: boolean;
  collections: string[];
  keyIngredients: string[];
}

export const FIXTURE_USER = { name: 'Mourad', initial: 'M' };

export const FIXTURE_COLLECTIONS = ['Doordeweeks', 'Meal prep', 'Vega', 'Feestdagen'];

export const FIXTURE_RECIPES: FixtureRecipe[] = [
  {
    id: '1',
    title: 'Shakshuka met feta',
    imageUrl: 'https://images.unsplash.com/photo-1590412200988-a436970781fa?w=500&q=60',
    timeTotalMin: 25,
    pricePerPortionCents: 185,
    bonusTip: true,
    collections: ['Doordeweeks', 'Vega'],
    keyIngredients: ['eieren', 'tomaat', 'feta', 'paprika'],
  },
  {
    id: '2',
    title: 'Nasi goreng met kip',
    imageUrl: 'https://images.unsplash.com/photo-1512058564366-18510be2db19?w=500&q=60',
    timeTotalMin: 30,
    pricePerPortionCents: 210,
    bonusTip: false,
    collections: ['Doordeweeks'],
    keyIngredients: ['rijst', 'kip', 'prei', 'ketjap'],
  },
  {
    id: '3',
    title: 'Courgettesoep met kip',
    imageUrl: 'https://images.unsplash.com/photo-1547592166-23ac45744acd?w=500&q=60',
    timeTotalMin: 35,
    pricePerPortionCents: 160,
    bonusTip: false,
    collections: ['Meal prep'],
    keyIngredients: ['courgette', 'kip', 'bouillon', 'ui'],
  },
  {
    id: '4',
    title: 'Pasta pesto met cherrytomaat',
    imageUrl: 'https://images.unsplash.com/photo-1473093295043-cdd812d0e601?w=500&q=60',
    timeTotalMin: 20,
    pricePerPortionCents: 175,
    bonusTip: true,
    collections: ['Doordeweeks', 'Vega'],
    keyIngredients: ['pasta', 'pesto', 'cherrytomaat', 'parmezaan'],
  },
  {
    id: '5',
    title: 'Bloemkoolcurry',
    imageUrl: 'https://images.unsplash.com/photo-1585937421612-70a008356fbe?w=500&q=60',
    timeTotalMin: 40,
    pricePerPortionCents: 150,
    bonusTip: false,
    collections: ['Vega', 'Meal prep'],
    keyIngredients: ['bloemkool', 'kokosmelk', 'rijst', 'kerrie'],
  },
  {
    id: '6',
    title: 'Kipdijfilet uit de oven',
    imageUrl: 'https://images.unsplash.com/photo-1598103442097-8b74394b95c6?w=500&q=60',
    timeTotalMin: 50,
    pricePerPortionCents: 240,
    bonusTip: false,
    collections: ['Feestdagen'],
    keyIngredients: ['kipdijfilet', 'citroen', 'knoflook', 'rozemarijn'],
  },
  {
    id: '7',
    title: 'Courgette-kip wraps',
    imageUrl: 'https://images.unsplash.com/photo-1626700051175-6818013e1d4f?w=500&q=60',
    timeTotalMin: 25,
    pricePerPortionCents: 195,
    bonusTip: true,
    collections: ['Doordeweeks'],
    keyIngredients: ['courgette', 'kip', 'wraps', 'crème fraîche'],
  },
  {
    id: '8',
    title: 'Linzensoep met komijn',
    imageUrl: 'https://images.unsplash.com/photo-1616501268209-edfff098fdd2?w=500&q=60',
    timeTotalMin: 45,
    pricePerPortionCents: 130,
    bonusTip: false,
    collections: ['Vega', 'Meal prep'],
    keyIngredients: ['linzen', 'wortel', 'komijn', 'tomaat'],
  },
];
