// Run: node data/seed.js
// Wipes and re-seeds recipes + a default household profile with 13 recipes.

const path = require('path');
const db = require(path.join(__dirname, '..', 'app', 'db.js'));

const RECIPES = [
  {
    name: 'Overnight Oats with Banana',
    meal_type: 'breakfast', cuisine: 'american', kid_friendly: 1,
    prep_time: 5, servings: 2, est_cost: 2.5,
    calories: 320, protein: 10, fiber: 6, sugar: 12, sodium: 60,
    favorite: 0,
    ingredients: [
      { name: 'rolled oats', quantity: 1, unit: 'cup' },
      { name: 'milk', quantity: 1.5, unit: 'cup' },
      { name: 'banana', quantity: 1, unit: 'each' },
      { name: 'honey', quantity: 1, unit: 'tbsp' }
    ]
  },
  {
    name: 'Scrambled Eggs & Toast',
    meal_type: 'breakfast', cuisine: 'american', kid_friendly: 1,
    prep_time: 10, servings: 2, est_cost: 3,
    calories: 380, protein: 20, fiber: 3, sugar: 3, sodium: 420,
    ingredients: [
      { name: 'eggs', quantity: 4, unit: 'each' },
      { name: 'bread', quantity: 4, unit: 'slice' },
      { name: 'butter', quantity: 1, unit: 'tbsp' },
      { name: 'salt', quantity: 0.25, unit: 'tsp' }
    ]
  },
  {
    name: 'Greek Yogurt Parfait',
    meal_type: 'breakfast', cuisine: 'mediterranean', kid_friendly: 1,
    prep_time: 5, servings: 1, est_cost: 2.75,
    calories: 290, protein: 18, fiber: 4, sugar: 14, sodium: 90,
    ingredients: [
      { name: 'greek yogurt', quantity: 1, unit: 'cup' },
      { name: 'granola', quantity: 0.5, unit: 'cup' },
      { name: 'blueberries', quantity: 0.5, unit: 'cup' }
    ]
  },
  {
    name: 'Turkey Sandwich',
    meal_type: 'lunch', cuisine: 'american', kid_friendly: 1,
    prep_time: 10, servings: 1, est_cost: 4.5,
    calories: 430, protein: 28, fiber: 4, sugar: 5, sodium: 900,
    ingredients: [
      { name: 'bread', quantity: 2, unit: 'slice' },
      { name: 'sliced turkey', quantity: 4, unit: 'oz' },
      { name: 'cheddar cheese', quantity: 1, unit: 'slice' },
      { name: 'lettuce', quantity: 1, unit: 'cup' },
      { name: 'mayonnaise', quantity: 1, unit: 'tbsp' }
    ]
  },
  {
    name: 'Chickpea Salad Bowl',
    meal_type: 'lunch', cuisine: 'mediterranean', kid_friendly: 0,
    prep_time: 15, servings: 2, est_cost: 5,
    calories: 420, protein: 18, fiber: 12, sugar: 6, sodium: 320,
    ingredients: [
      { name: 'chickpeas', quantity: 1, unit: 'can' },
      { name: 'cucumber', quantity: 1, unit: 'each' },
      { name: 'cherry tomatoes', quantity: 1, unit: 'cup' },
      { name: 'feta cheese', quantity: 0.5, unit: 'cup' },
      { name: 'olive oil', quantity: 2, unit: 'tbsp' },
      { name: 'lemon', quantity: 1, unit: 'each' }
    ]
  },
  {
    name: 'Peanut Butter Banana Wrap',
    meal_type: 'lunch', cuisine: 'american', kid_friendly: 1,
    prep_time: 5, servings: 1, est_cost: 2,
    calories: 380, protein: 14, fiber: 5, sugar: 15, sodium: 280,
    ingredients: [
      { name: 'tortilla', quantity: 1, unit: 'each' },
      { name: 'peanut butter', quantity: 2, unit: 'tbsp' },
      { name: 'banana', quantity: 1, unit: 'each' }
    ]
  },
  {
    name: 'Apple and Cheese Slices',
    meal_type: 'snack', cuisine: 'american', kid_friendly: 1,
    prep_time: 3, servings: 1, est_cost: 1.5,
    calories: 200, protein: 7, fiber: 4, sugar: 12, sodium: 180,
    ingredients: [
      { name: 'apple', quantity: 1, unit: 'each' },
      { name: 'cheddar cheese', quantity: 1, unit: 'oz' }
    ]
  },
  {
    name: 'Hummus and Carrots',
    meal_type: 'snack', cuisine: 'mediterranean', kid_friendly: 1,
    prep_time: 3, servings: 2, est_cost: 2.5,
    calories: 180, protein: 6, fiber: 6, sugar: 5, sodium: 320,
    ingredients: [
      { name: 'hummus', quantity: 0.5, unit: 'cup' },
      { name: 'baby carrots', quantity: 2, unit: 'cup' }
    ]
  },
  {
    name: 'Sheet-Pan Chicken and Veggies',
    meal_type: 'dinner', cuisine: 'american', kid_friendly: 1,
    prep_time: 35, servings: 4, est_cost: 11,
    calories: 460, protein: 36, fiber: 6, sugar: 6, sodium: 520,
    ingredients: [
      { name: 'chicken breast', quantity: 1.5, unit: 'lb' },
      { name: 'broccoli', quantity: 1, unit: 'head' },
      { name: 'sweet potato', quantity: 2, unit: 'each' },
      { name: 'olive oil', quantity: 2, unit: 'tbsp' },
      { name: 'salt', quantity: 1, unit: 'tsp' }
    ]
  },
  {
    name: 'Spaghetti with Marinara',
    meal_type: 'dinner', cuisine: 'italian', kid_friendly: 1,
    prep_time: 20, servings: 4, est_cost: 7,
    calories: 520, protein: 14, fiber: 6, sugar: 9, sodium: 640,
    ingredients: [
      { name: 'spaghetti', quantity: 1, unit: 'lb' },
      { name: 'marinara sauce', quantity: 1, unit: 'jar' },
      { name: 'parmesan cheese', quantity: 0.5, unit: 'cup' }
    ]
  },
  {
    name: 'Black Bean Tacos',
    meal_type: 'dinner', cuisine: 'mexican', kid_friendly: 1,
    prep_time: 15, servings: 3, est_cost: 6,
    calories: 440, protein: 16, fiber: 12, sugar: 4, sodium: 560,
    ingredients: [
      { name: 'black beans', quantity: 2, unit: 'can' },
      { name: 'tortilla', quantity: 8, unit: 'each' },
      { name: 'cheddar cheese', quantity: 1, unit: 'cup' },
      { name: 'salsa', quantity: 1, unit: 'cup' }
    ]
  },
  {
    name: 'Slow-Cooker Chili',
    meal_type: 'dinner', cuisine: 'american', kid_friendly: 1,
    prep_time: 15, servings: 6, est_cost: 10,
    calories: 480, protein: 30, fiber: 10, sugar: 8, sodium: 720,
    favorite: 1,
    ingredients: [
      { name: 'ground beef', quantity: 1, unit: 'lb' },
      { name: 'kidney beans', quantity: 2, unit: 'can' },
      { name: 'diced tomatoes', quantity: 2, unit: 'can' },
      { name: 'onion', quantity: 1, unit: 'each' },
      { name: 'chili powder', quantity: 2, unit: 'tbsp' }
    ]
  },
  {
    name: 'Salmon with Rice and Peas',
    meal_type: 'dinner', cuisine: 'american', kid_friendly: 0,
    prep_time: 25, servings: 3, est_cost: 14,
    calories: 520, protein: 34, fiber: 5, sugar: 4, sodium: 420,
    ingredients: [
      { name: 'salmon fillet', quantity: 1, unit: 'lb' },
      { name: 'white rice', quantity: 1, unit: 'cup' },
      { name: 'frozen peas', quantity: 2, unit: 'cup' },
      { name: 'lemon', quantity: 1, unit: 'each' }
    ]
  }
];

function seed() {
  db.exec('DELETE FROM recipe_ingredients; DELETE FROM recipes;');
  const insertRecipe = db.prepare(`INSERT INTO recipes
    (name, meal_type, cuisine, kid_friendly, prep_time, servings, est_cost, calories, protein, fiber, sugar, sodium, favorite)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertIng = db.prepare(`INSERT INTO recipe_ingredients (recipe_id, name, quantity, unit, brand_preference) VALUES (?, ?, ?, ?, ?)`);
  const tx = db.transaction(() => {
    for (const r of RECIPES) {
      const info = insertRecipe.run(
        r.name, r.meal_type, r.cuisine || null, r.kid_friendly || 0, r.prep_time, r.servings, r.est_cost,
        r.calories || null, r.protein || null, r.fiber || null, r.sugar || null, r.sodium || null, r.favorite || 0
      );
      for (const ing of r.ingredients) {
        insertIng.run(info.lastInsertRowid, ing.name, ing.quantity, ing.unit, ing.brand_preference || null);
      }
    }
  });
  tx();
  console.log(`Seeded ${RECIPES.length} recipes.`);
}

seed();
