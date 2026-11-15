import {
  BASE_MARKET_TAX_RATE,
  DAILY_STIPEND_BASE,
  ITEM_MAP,
  ROLE_DEFAULT_PERMISSIONS,
} from '../data/catalog';
import type {
  Company,
  ManufacturingRecipe,
  OrganizationMember,
  OrgPermission,
  PropertyAsset,
  SkillsMap,
  WorldEvent,
} from '../types/game';

/**
 * Computes player level, remaining XP toward next level, and threshold.
 * Level 1 -> 2 costs 200 XP; each level scales smoothly by +120 XP.
 */
export function xpForLevel(level: number): number {
  if (level <= 1) return 0;
  let total = 0;
  for (let l = 1; l < level; l++) {
    total += 200 + (l - 1) * 120;
  }
  return total;
}

export function xpStepForLevel(level: number): number {
  return 200 + Math.max(0, level - 1) * 120;
}

export function calculateLevelProgress(totalXp: number): {
  level: number;
  currentLevelXp: number;
  nextLevelXp: number;
  progressPercent: number;
} {
  let level = 1;
  let remaining = Math.max(0, Math.floor(totalXp));
  while (level < 200) {
    const step = xpStepForLevel(level);
    if (remaining < step) {
      return {
        level,
        currentLevelXp: remaining,
        nextLevelXp: step,
        progressPercent: Math.min(100, Math.round((remaining / step) * 100)),
      };
    }
    remaining -= step;
    level += 1;
  }
  return { level: 200, currentLevelXp: 0, nextLevelXp: 1, progressPercent: 100 };
}

/**
 * Calculates effective market tax rate factoring in Trade skill & World Events.
 * Clamped between 1% and 12% to prevent zero-tax exploits or punitive spikes.
 */
export function calculateMarketTaxRate(
  tradeSkillLevel: number,
  worldEvents: WorldEvent[]
): number {
  const skillDiscount = Math.max(0, tradeSkillLevel) * 0.004;
  const eventDelta = worldEvents
    .filter((e) => e.active)
    .reduce((acc, e) => acc + (e.taxDelta || 0), 0);
  const raw = BASE_MARKET_TAX_RATE - skillDiscount + eventDelta;
  return Number(Math.max(0.01, Math.min(0.12, raw)).toFixed(4));
}

/**
 * Computes dynamic market reference price based on supply volume and active world events.
 */
export function calculateDynamicItemPrice(
  itemId: string,
  activeSupplyQty: number,
  worldEvents: WorldEvent[]
): number {
  const item = ITEM_MAP[itemId];
  if (!item) return 0;
  const supplyFactor =
    activeSupplyQty <= 20
      ? 1.15
      : activeSupplyQty <= 100
      ? 1.05
      : activeSupplyQty >= 400
      ? 0.92
      : 1.0;

  let eventMultiplier = 1.0;
  for (const evt of worldEvents) {
    if (!evt.active) continue;
    if (!evt.targetItemId || evt.targetItemId === itemId) {
      eventMultiplier *= evt.priceMultiplier || 1.0;
    }
  }
  return Math.max(1, Math.round(item.basePrice * supplyFactor * eventMultiplier));
}

/**
 * Computes net hourly company profit factoring in Management (revenue) and Finance (expense).
 */
export function calculateCompanyHourlyNet(
  company: Pick<Company, 'baseRevenuePerHour' | 'expensePerHour' | 'level' | 'employeesCount'>,
  skills: Pick<SkillsMap, 'management' | 'finance'>
): {
  grossHourly: number;
  expenseHourly: number;
  netHourly: number;
} {
  const levelMultiplier = 1 + (company.level - 1) * 0.32;
  const staffBonus = 1 + Math.max(0, company.employeesCount - 1) * 0.05;
  const mgmtBonus = 1 + Math.max(0, skills.management) * 0.08;
  const grossHourly = Math.round(
    company.baseRevenuePerHour * levelMultiplier * staffBonus * mgmtBonus
  );

  const rawExpense =
    company.expensePerHour * (1 + (company.level - 1) * 0.2) +
    Math.max(0, company.employeesCount - 3) * 8;
  const financeReduction = Math.min(0.45, Math.max(0, skills.finance) * 0.05);
  const expenseHourly = Math.round(rawExpense * (1 - financeReduction));

  return {
    grossHourly,
    expenseHourly,
    netHourly: Math.max(15, grossHourly - expenseHourly),
  };
}

/**
 * Computes net hourly property rent factoring in Negotiation skill and lease state.
 */
export function calculatePropertyHourlyNet(
  property: Pick<PropertyAsset, 'rentPerHour' | 'maintenancePerHour' | 'level' | 'isRented'>,
  negotiationSkill: number
): {
  grossRent: number;
  maintenance: number;
  netHourly: number;
} {
  const levelMult = 1 + (property.level - 1) * 0.28;
  const negMult = 1 + Math.max(0, negotiationSkill) * 0.07;
  const grossRent = property.isRented
    ? Math.round(property.rentPerHour * levelMult * negMult)
    : 0;
  const maintenance = Math.round(property.maintenancePerHour * (1 + (property.level - 1) * 0.15));
  return {
    grossRent,
    maintenance,
    netHourly: grossRent - maintenance,
  };
}

/**
 * Computes manufacturing cost after Industry skill discount.
 */
export function calculateManufacturingCost(
  recipe: ManufacturingRecipe,
  industrySkill: number
): number {
  const discount = Math.min(0.45, Math.max(0, industrySkill) * 0.06);
  return Math.max(10, Math.round(recipe.processingCost * (1 - discount)));
}

/**
 * Computes daily stipend factoring in Finance skill and player level.
 */
export function calculateDailyStipend(level: number, financeSkill: number): number {
  const amount = DAILY_STIPEND_BASE + (level - 1) * 35 + financeSkill * 25;
  return Math.min(1500, Math.max(DAILY_STIPEND_BASE, Math.round(amount)));
}

/**
 * Checks if a member has a given organization permission (server/client parity).
 */
export function hasOrgPermission(
  member: Pick<OrganizationMember, 'role' | 'permissions'> | null | undefined,
  permission: OrgPermission
): boolean {
  if (!member) return false;
  if (member.role === 'leader') return true;
  if (member.permissions.includes(permission)) return true;
  return ROLE_DEFAULT_PERMISSIONS[member.role]?.includes(permission) ?? false;
}

/**
 * Validates transfer parameters before submission to prevent negative balances or self-transfers.
 */
export function validateTransfer(
  senderUid: string,
  recipientUid: string,
  senderBalance: number,
  amount: number
): { valid: boolean; reason?: string } {
  if (!recipientUid || senderUid === recipientUid) {
    return { valid: false, reason: 'SELF_OR_MISSING_RECIPIENT' };
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return { valid: false, reason: 'INVALID_AMOUNT' };
  }
  if (amount > senderBalance) {
    return { valid: false, reason: 'INSUFFICIENT_FUNDS' };
  }
  return { valid: true };
}

/**
 * Validates username format (3-24 alphanumeric or underscore, no spaces).
 */
export function isValidUsername(username: string): boolean {
  return /^[a-zA-Z0-9_]{3,24}$/.test(username.trim());
}

/**
 * Computes accrued payout since last collection timestamp (capped at 12 hours per claim,
 * minimum 1 minute yields fractional accrual with at least 1 credit once 2 minutes pass).
 */
export function calculateAccruedPayout(
  netPerHour: number,
  lastCollectedMs: number,
  nowMs: number
): number {
  if (netPerHour <= 0) return 0;
  const elapsedMs = Math.max(0, nowMs - lastCollectedMs);
  const cappedHours = Math.min(12, elapsedMs / 3_600_000);
  return Math.max(0, Math.floor(netPerHour * cappedHours));
}
