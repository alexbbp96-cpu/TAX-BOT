export type ProgressionMode = 'pair_x6' | 'decade_x12';

export interface TaxBracketDef {
  id: string;
  index: number; // 1..36
  pairIndex: number; // 1..6
  cycleIndex: number; // 1..12
  tierIndex: 1 | 2 | 3;
  rate: 0.11 | 0.23 | 0.34;
  lower: number; // continuous lower bound (0, 110, 340, ...)
  displayLower: number; // discrete start label (1, 111, 341, ...)
  upper: number;
}

export interface TaxStepResult extends TaxBracketDef {
  taxable: number;
  tax: number;
  cumulativeTax: number;
  cumulativeNet: number;
  isActive: boolean;
  isCurrent: boolean;
}

export interface RateSummary {
  rate: 0.11 | 0.23 | 0.34;
  taxable: number;
  tax: number;
  shareOfTax: number;
}

export interface TaxComputationResult {
  income: number;
  mode: ProgressionMode;
  totalTax: number;
  netIncome: number;
  effectiveRate: number;
  marginalRate: number;
  activeCycle: number;
  activePair: number;
  nextThreshold: number | null;
  remainingToThreshold: number | null;
  excessIncome: number;
  excessTax: number;
  steps: TaxStepResult[];
  rateBreakdown: RateSummary[];
}

const RATES: readonly [0.11, 0.23, 0.34] = [0.11, 0.23, 0.34];

/**
 * Generates all 36 brackets (12 cycles of 11%, 23%, 34%) for the selected progression mode.
 *
 * - 'pair_x6':
 *   Pair 1 (Cycles 1 & 2):
 *     1. 11%: 1..110, 23%: 111..340, 34%: 341..1100
 *     2. 11%: 1101..2300, 23%: 2301..3400, 34%: 3401..11000
 *   Repeated 6 times (Pairs 1..6), scaling upper bounds by 10^(3*k) and continuing seamlessly
 *   from the previous upper bound.
 *
 * - 'decade_x12':
 *   Cycle 1: 1..110, 111..340, 341..1100
 *   Cycle 2: 1101..2300, 2301..3400, 3401..11000
 *   Cycles 3..12: Cycle 2 scaled by 10^(c-2) per cycle (11k..110k, 110k..1.1M, ...).
 */
export function buildTaxSchedule(mode: ProgressionMode): TaxBracketDef[] {
  const brackets: TaxBracketDef[] = [];
  let prevUpper = 0;
  let globalIndex = 0;

  if (mode === 'pair_x6') {
    const basePairUppers: Array<{
      cycleOffset: 0 | 1;
      tierIndex: 1 | 2 | 3;
      rate: 0.11 | 0.23 | 0.34;
      upperBase: number;
    }> = [
      {cycleOffset: 0, tierIndex: 1, rate: 0.11, upperBase: 110},
      {cycleOffset: 0, tierIndex: 2, rate: 0.23, upperBase: 340},
      {cycleOffset: 0, tierIndex: 3, rate: 0.34, upperBase: 1100},
      {cycleOffset: 1, tierIndex: 1, rate: 0.11, upperBase: 2300},
      {cycleOffset: 1, tierIndex: 2, rate: 0.23, upperBase: 3400},
      {cycleOffset: 1, tierIndex: 3, rate: 0.34, upperBase: 11000},
    ];

    for (let k = 0; k < 6; k++) {
      const scale = Math.pow(10, k * 3);
      for (const item of basePairUppers) {
        globalIndex += 1;
        const upper = item.upperBase * scale;
        const lower = prevUpper;
        const displayLower = prevUpper + 1;
        brackets.push({
          id: `${mode}-${globalIndex}`,
          index: globalIndex,
          pairIndex: k + 1,
          cycleIndex: k * 2 + item.cycleOffset + 1,
          tierIndex: item.tierIndex,
          rate: item.rate,
          lower,
          displayLower,
          upper,
        });
        prevUpper = upper;
      }
    }
  } else {
    // decade_x12: Cycle 1 is 110/340/1100; Cycles 2..12 scale 2300/3400/11000 by 10^(c-1)
    const cycle1Uppers = [110, 340, 1100];
    for (let t = 0; t < 3; t++) {
      globalIndex += 1;
      const upper = cycle1Uppers[t];
      brackets.push({
        id: `${mode}-${globalIndex}`,
        index: globalIndex,
        pairIndex: 1,
        cycleIndex: 1,
        tierIndex: (t + 1) as 1 | 2 | 3,
        rate: RATES[t],
        lower: prevUpper,
        displayLower: prevUpper + 1,
        upper,
      });
      prevUpper = upper;
    }

    const baseDecadeUppers = [2300, 3400, 11000];
    for (let c = 1; c < 12; c++) {
      const scale = Math.pow(10, c - 1);
      const cycleIndex = c + 1;
      const pairIndex = Math.ceil(cycleIndex / 2);
      for (let t = 0; t < 3; t++) {
        globalIndex += 1;
        const upper = baseDecadeUppers[t] * scale;
        brackets.push({
          id: `${mode}-${globalIndex}`,
          index: globalIndex,
          pairIndex,
          cycleIndex,
          tierIndex: (t + 1) as 1 | 2 | 3,
          rate: RATES[t],
          lower: prevUpper,
          displayLower: prevUpper + 1,
          upper,
        });
        prevUpper = upper;
      }
    }
  }

  return brackets;
}

export function computeProgressiveTax(
  incomeRaw: number,
  mode: ProgressionMode = 'pair_x6',
): TaxComputationResult {
  const income = Number.isFinite(incomeRaw) ? Math.max(0, incomeRaw) : 0;
  const schedule = buildTaxSchedule(mode);

  let cumulativeTax = 0;
  let activeCycle = income > 0 ? 1 : 0;
  let activePair = income > 0 ? 1 : 0;
  let marginalRate = income > 0 ? 0.11 : 0;
  let nextThreshold: number | null = schedule[0]?.upper ?? null;

  const rateTaxableMap: Record<number, number> = {0.11: 0, 0.23: 0, 0.34: 0};
  const rateTaxMap: Record<number, number> = {0.11: 0, 0.23: 0, 0.34: 0};

  const steps: TaxStepResult[] = schedule.map((bracket) => {
    const taxable =
      income > bracket.lower
        ? Math.min(income, bracket.upper) - bracket.lower
        : 0;
    const tax = taxable * bracket.rate;
    cumulativeTax += tax;

    const isActive = taxable > 0;
    const isCurrent = income > bracket.lower && income <= bracket.upper;

    if (isActive) {
      rateTaxableMap[bracket.rate] += taxable;
      rateTaxMap[bracket.rate] += tax;
      activeCycle = bracket.cycleIndex;
      activePair = bracket.pairIndex;
      marginalRate = bracket.rate;
    }

    if (isCurrent) {
      nextThreshold = bracket.upper;
    }

    const cumulativeCovered = Math.min(income, bracket.upper);
    return {
      ...bracket,
      taxable,
      tax,
      cumulativeTax,
      cumulativeNet: Math.max(0, cumulativeCovered - cumulativeTax),
      isActive,
      isCurrent,
    };
  });

  const lastUpper = schedule[schedule.length - 1]?.upper ?? 0;
  let excessIncome = 0;
  let excessTax = 0;

  if (income > lastUpper) {
    excessIncome = income - lastUpper;
    excessTax = excessIncome * 0.34;
    cumulativeTax += excessTax;
    rateTaxableMap[0.34] += excessIncome;
    rateTaxMap[0.34] += excessTax;
    marginalRate = 0.34;
    activeCycle = 12;
    activePair = 6;
    nextThreshold = null;
  } else if (income === 0) {
    nextThreshold = schedule[0]?.upper ?? null;
  }

  const totalTax = cumulativeTax;
  const netIncome = Math.max(0, income - totalTax);
  const effectiveRate = income > 0 ? totalTax / income : 0;
  const remainingToThreshold =
    nextThreshold !== null ? Math.max(0, nextThreshold - income) : null;

  const rateBreakdown: RateSummary[] = RATES.map((rate) => ({
    rate,
    taxable: rateTaxableMap[rate],
    tax: rateTaxMap[rate],
    shareOfTax: totalTax > 0 ? rateTaxMap[rate] / totalTax : 0,
  }));

  return {
    income,
    mode,
    totalTax,
    netIncome,
    effectiveRate,
    marginalRate,
    activeCycle,
    activePair,
    nextThreshold,
    remainingToThreshold,
    excessIncome,
    excessTax,
    steps,
    rateBreakdown,
  };
}

/**
 * Finds the gross income required to achieve a target net income after tax deduction.
 */
export function solveGrossForTargetNet(
  targetNetRaw: number,
  mode: ProgressionMode,
): TaxComputationResult {
  const targetNet = Math.max(0, Number.isFinite(targetNetRaw) ? targetNetRaw : 0);
  if (targetNet === 0) {
    return computeProgressiveTax(0, mode);
  }

  let low = targetNet;
  let high = targetNet / (1 - 0.34) + 1;

  for (let iter = 0; iter < 80; iter++) {
    const mid = (low + high) / 2;
    const res = computeProgressiveTax(mid, mode);
    if (res.netIncome < targetNet) {
      low = mid;
    } else {
      high = mid;
    }
  }

  const rounded = Math.round(high * 100) / 100;
  return computeProgressiveTax(rounded, mode);
}

export function formatCurrency(value: number, decimals = 2): string {
  if (!Number.isFinite(value)) return '0';
  // For exact large integers (>= 1e15) avoid floating display noise
  if (Math.abs(value) >= 1e15 && Number.isInteger(value)) {
    const str = BigInt(value).toString();
    return str.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  }
  const hasFraction = Math.abs(value - Math.round(value)) > 1e-9;
  return value.toLocaleString('ru-RU', {
    minimumFractionDigits: hasFraction ? decimals : 0,
    maximumFractionDigits: decimals,
  });
}

export function formatIntegerBound(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (Math.abs(value) >= 1e15) {
    const str = BigInt(Math.round(value)).toString();
    return str.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  }
  return Math.round(value).toLocaleString('ru-RU');
}

export function formatPercent(rateDecimal: number, decimals = 2): string {
  return `${(rateDecimal * 100).toLocaleString('ru-RU', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}%`;
}
