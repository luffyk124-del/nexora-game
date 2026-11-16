import { describe, expect, it } from 'vitest';
import { ITEM_MAP, MANUFACTURING_RECIPES } from '../data/catalog';
import {
  calculateAccruedPayout,
  calculateCompanyHourlyNet,
  calculateDailyStipend,
  calculateDynamicItemPrice,
  calculateLevelProgress,
  calculateManufacturingCost,
  calculateMarketTaxRate,
  calculatePropertyHourlyNet,
  hasOrgPermission,
  isValidUsername,
  validateTransfer,
} from '../lib/economy';
import type { WorldEvent } from '../types/game';

const sampleEvents: WorldEvent[] = [
  {
    id: 'evt_silicon_boom',
    titleAr: 'طفرة الرقائق',
    titleEn: 'Chip Boom',
    descriptionAr: 'زيادة الطلب',
    descriptionEn: 'Surge',
    effectType: 'demand_surge',
    targetItemId: 'microchips',
    priceMultiplier: 1.2,
    taxDelta: 0,
    active: true,
    createdAt: null,
  },
  {
    id: 'evt_tax_holiday',
    titleAr: 'خفض ضريبي',
    titleEn: 'Tax Cut',
    descriptionAr: 'خصم 1%',
    descriptionEn: '1% off',
    effectType: 'tax_cut',
    priceMultiplier: 1.0,
    taxDelta: -0.01,
    active: true,
    createdAt: null,
  },
];

describe('NEXORA Core Economy & Security Invariants', () => {
  it('validates usernames strictly (3-24 chars, alphanumeric + underscore)', () => {
    expect(isValidUsername('Khalid_01')).toBe(true);
    expect(isValidUsername('ab')).toBe(false);
    expect(isValidUsername('bad name!')).toBe(false);
    expect(isValidUsername('a'.repeat(25))).toBe(false);
  });

  it('computes XP and multi-level progression accurately', () => {
    expect(calculateLevelProgress(0)).toEqual({
      level: 1,
      currentLevelXp: 0,
      nextLevelXp: 200,
      progressPercent: 0,
    });
    const lv2 = calculateLevelProgress(200);
    expect(lv2.level).toBe(2);
    expect(lv2.currentLevelXp).toBe(0);
    expect(lv2.nextLevelXp).toBe(320);

    const lv3 = calculateLevelProgress(520);
    expect(lv3.level).toBe(3);
  });

  it('prevents negative balances, zero/negative amounts, and self-transfers', () => {
    expect(validateTransfer('u1', 'u1', 2500, 100)).toEqual({
      valid: false,
      reason: 'SELF_OR_MISSING_RECIPIENT',
    });
    expect(validateTransfer('u1', 'u2', 2500, 0)).toEqual({
      valid: false,
      reason: 'INVALID_AMOUNT',
    });
    expect(validateTransfer('u1', 'u2', 2500, -50)).toEqual({
      valid: false,
      reason: 'INVALID_AMOUNT',
    });
    expect(validateTransfer('u1', 'u2', 500, 600)).toEqual({
      valid: false,
      reason: 'INSUFFICIENT_FUNDS',
    });
    expect(validateTransfer('u1', 'u2', 2500, 500)).toEqual({ valid: true });
  });

  it('calculates market tax rate factoring in Trade skill and World Events with floor/ceiling', () => {
    // Base 5% - 1% event = 4%
    expect(calculateMarketTaxRate(0, sampleEvents)).toBeCloseTo(0.04, 4);
    // Max trade skill Lv.10 (-4%) + -1% event -> clamped at 1% floor
    expect(calculateMarketTaxRate(10, sampleEvents)).toBeCloseTo(0.01, 4);
  });

  it('adjusts dynamic item prices by supply scarcity and active world events', () => {
    const scarcePrice = calculateDynamicItemPrice('microchips', 10, sampleEvents);
    const abundantPrice = calculateDynamicItemPrice('microchips', 500, sampleEvents);
    expect(scarcePrice).toBeGreaterThan(abundantPrice);
  });

  it('calculates company hourly net profit with Management and Finance skills', () => {
    const base = calculateCompanyHourlyNet(
      { baseRevenuePerHour: 200, expensePerHour: 60, level: 1, employeesCount: 3 },
      { management: 0, finance: 0 }
    );
    const skilled = calculateCompanyHourlyNet(
      { baseRevenuePerHour: 200, expensePerHour: 60, level: 2, employeesCount: 5 },
      { management: 3, finance: 4 }
    );
    expect(skilled.netHourly).toBeGreaterThan(base.netHourly);
    expect(skilled.expenseHourly).toBeGreaterThan(0);
  });

  it('calculates property rent yield and handles vacant maintenance correctly', () => {
    const leased = calculatePropertyHourlyNet(
      { rentPerHour: 200, maintenancePerHour: 45, level: 1, isRented: true },
      2
    );
    expect(leased.netHourly).toBeGreaterThan(155);

    const vacant = calculatePropertyHourlyNet(
      { rentPerHour: 200, maintenancePerHour: 45, level: 1, isRented: false },
      2
    );
    expect(vacant.netHourly).toBe(-45);
  });

  it('reduces manufacturing processing cost based on Industry skill with a 10 N-Credit floor', () => {
    const recipe = MANUFACTURING_RECIPES[0];
    const baseCost = calculateManufacturingCost(recipe, 0);
    const skilledCost = calculateManufacturingCost(recipe, 5);
    expect(skilledCost).toBeLessThan(baseCost);
    expect(skilledCost).toBeGreaterThanOrEqual(10);
  });

  it('enforces organization RBAC permissions strictly', () => {
    expect(hasOrgPermission({ role: 'leader', permissions: [] }, 'manage_treasury')).toBe(true);
    expect(
      hasOrgPermission({ role: 'deputy', permissions: ['manage_members', 'manage_treasury'] }, 'manage_treasury')
    ).toBe(true);
    expect(hasOrgPermission({ role: 'officer', permissions: ['manage_members'] }, 'manage_treasury')).toBe(false);
    expect(hasOrgPermission({ role: 'member', permissions: [] }, 'manage_members')).toBe(false);
  });

  it('caps accrued hourly payout at 12 hours and scales daily stipend cleanly', () => {
    const oneHour = 3_600_000;
    expect(calculateAccruedPayout(120, 0, oneHour * 2)).toBe(240);
    expect(calculateAccruedPayout(120, 0, oneHour * 30)).toBe(1440); // capped at 12h
    expect(calculateDailyStipend(5, 3)).toBeGreaterThan(calculateDailyStipend(1, 0));
  });
  it('keeps market prices within the configured event multiplier bounds', () => {
    const extremeHigh: WorldEvent[] = Array.from({ length: 5 }, (_, index) => ({
      ...sampleEvents[0],
      id: `evt_high_${index}`,
      stackGroup: `high_${index}`,
      priceMultiplier: 2,
    }));
    const extremeLow: WorldEvent[] = Array.from({ length: 5 }, (_, index) => ({
      ...sampleEvents[0],
      id: `evt_low_${index}`,
      stackGroup: `low_${index}`,
      priceMultiplier: 0.1,
    }));

    // Compare against the unrounded supply-adjusted reference so the event
    // multiplier is bounded before the final integer rounding in production.
    const supplyAdjustedPrice = ITEM_MAP.microchips.basePrice * 1.05;
    const high = calculateDynamicItemPrice('microchips', 100, extremeHigh, 1_000);
    const low = calculateDynamicItemPrice('microchips', 100, extremeLow, 1_000);

    expect(high).toBeLessThanOrEqual(Math.round(supplyAdjustedPrice * 1.45));
    expect(low).toBeGreaterThanOrEqual(Math.round(supplyAdjustedPrice * 0.7));
  });

  it('clamps market tax even when world events apply extreme modifiers', () => {
    const extremeEvents: WorldEvent[] = [
      { ...sampleEvents[0], id: 'evt_tax_extreme_low', taxDelta: -1 },
      { ...sampleEvents[1], id: 'evt_tax_extreme_high', taxDelta: 1, stackGroup: 'tax_high' },
    ];

    expect(calculateMarketTaxRate(0, extremeEvents, 1_000)).toBeGreaterThanOrEqual(0.01);
    expect(calculateMarketTaxRate(0, extremeEvents, 1_000)).toBeLessThanOrEqual(0.12);
  });

  it('limits active world events to three unique effect groups', async () => {
    const { getActiveWorldEvents } = await import('../lib/economy');
    const events: WorldEvent[] = Array.from({ length: 5 }, (_, index) => ({
      ...sampleEvents[0],
      id: `evt_group_${index}`,
      stackGroup: `group_${index}`,
    }));

    const active = getActiveWorldEvents(events, 1_000);
    expect(active).toHaveLength(3);
    expect(new Set(active.map((event) => event.stackGroup)).size).toBe(3);
  });

});
