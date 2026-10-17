// Shared vocabulary for a Shirrts custom-shirt order.
//
// These are the things the cutting table actually depends on. If any of them is
// missing or vague, the shop cannot cut fabric and the order turns into an email
// thread.

export type Garment = "tee" | "long-sleeve" | "hoodie" | "crewneck";

export const GARMENTS: readonly Garment[] = ["tee", "long-sleeve", "hoodie", "crewneck"];

export type Size = "XS" | "S" | "M" | "L" | "XL" | "2XL" | "3XL";

export const SIZES: readonly Size[] = ["XS", "S", "M", "L", "XL", "2XL", "3XL"];

/** Where on the garment the artwork goes. The cutter needs this before any cut. */
export type Placement = "front-center" | "front-left-chest" | "back-full" | "sleeve-left" | "sleeve-right";

export const PLACEMENTS: readonly Placement[] = [
  "front-center",
  "front-left-chest",
  "back-full",
  "sleeve-left",
  "sleeve-right",
];

export interface SizeRun {
  size: Size;
  quantity: number;
}

/** A validation problem the shop can hand back to a customer verbatim. */
export interface Problem {
  field: string;
  message: string;
}

export interface ValidationResult<T> {
  ok: boolean;
  value: T | null;
  problems: Problem[];
}
