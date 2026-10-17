// What an order costs.
//
// Base price per garment, times the number of shirts, plus a rush surcharge if
// they want it this week.

import type { Garment, SizeRun } from "./types.js";

export const BASE_PRICE_USD: Record<Garment, number> = {
  tee: 18,
  "long-sleeve": 24,
  hoodie: 42,
  crewneck: 36,
};

/** Rush jobs jump the queue, and the queue is the shop's whole capacity. */
export const RUSH_SURCHARGE_RATE = 0.25;

export interface PriceQuote {
  garment: Garment;
  quantity: number;
  unitPriceUsd: number;
  subtotalUsd: number;
  rushSurchargeUsd: number;
  totalUsd: number;
}

export function totalShirts(sizeRun: SizeRun[]): number {
  return sizeRun.reduce((sum, entry) => sum + entry.quantity, 0);
}

export function quote(garment: Garment, quantity: number, rush = false): PriceQuote {
  const unitPriceUsd = BASE_PRICE_USD[garment];
  const subtotalUsd = unitPriceUsd * quantity;
  const rushSurchargeUsd = rush ? Math.round(subtotalUsd * RUSH_SURCHARGE_RATE * 100) / 100 : 0;
  return {
    garment,
    quantity,
    unitPriceUsd,
    subtotalUsd,
    rushSurchargeUsd,
    totalUsd: Math.round((subtotalUsd + rushSurchargeUsd) * 100) / 100,
  };
}
