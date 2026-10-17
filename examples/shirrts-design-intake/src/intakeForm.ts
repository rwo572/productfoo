// The design intake form we have today.
//
// A fixed list of fields. The customer fills it in once and hits submit. It
// cannot ask a follow-up question, so "describe your design" comes back as
// "something cool" about half the time and the order becomes an email thread.

import {
  GARMENTS,
  PLACEMENTS,
  SIZES,
  type Garment,
  type Placement,
  type Problem,
  type Size,
  type ValidationResult,
} from "./types.js";

export interface IntakeFormFields {
  garment: string;
  size: string;
  color: string;
  quantity: string;
  /** Free text. This is the field that fails. */
  designDescription: string;
}

export interface IntakeSubmission {
  garment: Garment;
  size: Size;
  color: string;
  quantity: number;
  designDescription: string;
}

export interface FormField {
  name: keyof IntakeFormFields;
  label: string;
  kind: "select" | "text" | "number" | "textarea";
  options?: readonly string[];
  required: boolean;
}

/** The form, as it is printed on the website today. */
export const INTAKE_FORM_FIELDS: readonly FormField[] = [
  { name: "garment", label: "Garment", kind: "select", options: GARMENTS, required: true },
  { name: "size", label: "Size", kind: "select", options: SIZES, required: true },
  { name: "color", label: "Shirt color", kind: "text", required: true },
  { name: "quantity", label: "How many?", kind: "number", required: true },
  { name: "designDescription", label: "Describe your design", kind: "textarea", required: true },
];

/**
 * Everything the form can check. Note what is missing: there is no placement
 * field at all, and nothing here can tell "a big red dragon on the back, three
 * colors" apart from "something cool".
 */
export function validateIntakeForm(fields: IntakeFormFields): ValidationResult<IntakeSubmission> {
  const problems: Problem[] = [];

  const garment = fields.garment.trim() as Garment;
  if (!GARMENTS.includes(garment)) {
    problems.push({ field: "garment", message: `Pick one of: ${GARMENTS.join(", ")}.` });
  }

  const size = fields.size.trim().toUpperCase() as Size;
  if (!SIZES.includes(size)) {
    problems.push({ field: "size", message: `Pick one of: ${SIZES.join(", ")}.` });
  }

  const color = fields.color.trim();
  if (color.length === 0) {
    problems.push({ field: "color", message: "Shirt color is required." });
  }

  const quantity = Number.parseInt(fields.quantity.trim(), 10);
  if (!Number.isInteger(quantity) || quantity < 1) {
    problems.push({ field: "quantity", message: "Quantity must be a whole number of 1 or more." });
  }

  const designDescription = fields.designDescription.trim();
  if (designDescription.length === 0) {
    problems.push({ field: "designDescription", message: "Tell us about your design." });
  }

  if (problems.length > 0) {
    return { ok: false, value: null, problems };
  }

  return {
    ok: true,
    value: { garment, size, color, quantity, designDescription },
    problems: [],
  };
}

/** The shop has no field for this, so it is guessed by hand off the free text. */
export function guessPlacement(_submission: IntakeSubmission): Placement | null {
  // There is nothing to guess from. The form never asked.
  void PLACEMENTS;
  return null;
}
