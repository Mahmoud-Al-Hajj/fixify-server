// The names in the categories table (schema.sql), in id order. Single source
// for the AI prompt and the diagnosis schemas.
export const CATEGORY_NAMES = [
  "Electrician",
  "Plumber",
  "AC & Refrigeration",
  "Carpenter",
  "Painter",
  "Appliance Repair",
  "Generator & Solar",
  "Aluminium & Glass",
  "Tiling & Masonry",
  "Locksmith",
  "Satellite & Internet",
  "Cleaning",
  "Moving & Delivery",
  "Pest Control",
  "Welding & Metalwork",
] as const;

export type CategoryName = (typeof CATEGORY_NAMES)[number];
