import { describe, it, expect } from 'vitest';
import {
  ORB_SHAPES,
  SPECIES_MAP,
  STAT_NAMES,
  ORB_PALETTES,
  IDLE_STYLES,
  PARTICLES,
  PARTICLE_EMOJI,
  STAT_LABELS,
  PERSONALITY_STAT_BIAS,
  roll,
  rollStatsBiased,
  getCompanion,
  getSpeciesConfig,
  getSpeciesLabel,
  analyzeGrowth,
  applyGrowth,
  mergeStats,
} from './buddy';

describe('roll', () => {
  it('is deterministic: same userId yields identical bones', () => {
    const a = roll('user-42');
    const b = roll('user-42');
    expect(a).toEqual(b);
  });

  it('produces different bones for different userIds (usually)', () => {
    const a = roll('alice-xyz');
    const b = roll('bob-xyz');
    expect(a).not.toEqual(b);
  });

  it('produces bones within defined ranges and enums', () => {
    const { bones, inspirationSeed } = roll('sample-user');
    expect(ORB_SHAPES).toContain(bones.species);
    expect(ORB_PALETTES).toContain(bones.palette);
    expect(PARTICLES).toContain(bones.particle);
    expect(IDLE_STYLES).toContain(bones.idleStyle);
    expect(bones.sizeScale).toBeGreaterThanOrEqual(0.85);
    expect(bones.sizeScale).toBeLessThan(1.15);
    expect(typeof bones.shiny).toBe('boolean');
    expect(inspirationSeed).toBeGreaterThanOrEqual(0);
    for (const s of STAT_NAMES) {
      expect(bones.stats[s]).toBeGreaterThanOrEqual(1);
      expect(bones.stats[s]).toBeLessThanOrEqual(100);
    }
  });
});

describe('rollStatsBiased', () => {
  it('biases a known personality toward its peak stat', () => {
    const personality = Object.keys(PERSONALITY_STAT_BIAS)[0];
    const bias = PERSONALITY_STAT_BIAS[personality];
    const stats = rollStatsBiased('user-1', personality);
    expect(stats[bias.peak]).toBeGreaterThanOrEqual(stats[bias.dump]);
    expect(stats[bias.peak]).toBeGreaterThan(40);
    expect(stats[bias.dump]).toBeLessThan(40);
  });

  it('is deterministic for the same userId + personality', () => {
    const personality = Object.keys(PERSONALITY_STAT_BIAS)[0];
    const a = rollStatsBiased('user-det', personality);
    const b = rollStatsBiased('user-det', personality);
    expect(a).toEqual(b);
  });

  it('handles unknown personality by falling back to RNG pick', () => {
    const stats = rollStatsBiased('user-2', 'some-unknown-personality');
    for (const s of STAT_NAMES) {
      expect(stats[s]).toBeGreaterThanOrEqual(1);
      expect(stats[s]).toBeLessThanOrEqual(100);
    }
  });
});

describe('getCompanion', () => {
  it('merges bones + soul and uses biased stats when personality matches preset', () => {
    const personality = Object.keys(PERSONALITY_STAT_BIAS)[0];
    const comp = getCompanion('user-x', {
      name: 'Nova',
      personality,
      hatchedAt: 1234,
    });
    expect(comp.name).toBe('Nova');
    expect(comp.personality).toBe(personality);
    expect(comp.hatchedAt).toBe(1234);
    // Bones present
    expect(ORB_SHAPES).toContain(comp.species);
    // Stats biased
    const bias = PERSONALITY_STAT_BIAS[personality];
    expect(comp.stats[bias.peak]).toBeGreaterThanOrEqual(comp.stats[bias.dump]);
  });

  it('uses bones.stats when personality is empty', () => {
    const r = roll('user-empty');
    const comp = getCompanion('user-empty', {
      name: 'X',
      personality: '',
      hatchedAt: 0,
    });
    expect(comp.stats).toEqual(r.bones.stats);
  });
});

describe('species helpers', () => {
  it('getSpeciesConfig returns the matching config', () => {
    expect(getSpeciesConfig('circle')).toEqual(SPECIES_MAP.circle);
    expect(getSpeciesConfig('star')).toEqual(SPECIES_MAP.star);
  });

  it('getSpeciesLabel returns the species label', () => {
    expect(getSpeciesLabel('circle')).toBe('圆灵');
    expect(getSpeciesLabel('heart')).toBe('心灵');
  });
});

describe('analyzeGrowth', () => {
  it('detects ENERGY signals from 太棒了 / awesome', () => {
    const deltas = analyzeGrowth(['太棒了 awesome'], 0);
    expect(deltas.ENERGY).toBeGreaterThanOrEqual(1);
  });

  it('detects WARMTH signals from 谢谢', () => {
    const deltas = analyzeGrowth(['谢谢你这么温暖'], 0);
    expect(deltas.WARMTH).toBeGreaterThanOrEqual(1);
  });

  it('returns empty deltas when no keyword matches', () => {
    const deltas = analyzeGrowth(['zzzzz qqqqq wwwww'], 0);
    expect(Object.keys(deltas)).toHaveLength(0);
  });

  it('caps growth per call at MAX_GROWTH_PER_CALL (3)', () => {
    const deltas = analyzeGrowth(['谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢'], 0);
    expect(deltas.WARMTH ?? 0).toBeLessThanOrEqual(3);
  });

  it('diminishes growth after DIMINISH_THRESHOLD interactions', () => {
    const low = analyzeGrowth(['太棒了 太棒了 太棒了'], 10);
    const high = analyzeGrowth(['太棒了 太棒了 太棒了'], 10_000);
    expect(high.ENERGY ?? 0).toBeLessThanOrEqual(low.ENERGY ?? 0);
    expect(high.ENERGY ?? 0).toBeGreaterThanOrEqual(1);
  });
});

describe('applyGrowth', () => {
  it('adds new growth deltas onto current totals', () => {
    const result = applyGrowth({ ENERGY: 5 }, { ENERGY: 3, WARMTH: 2 });
    expect(result.ENERGY).toBe(8);
    expect(result.WARMTH).toBe(2);
  });

  it('caps total accumulated growth at 50', () => {
    const result = applyGrowth({ WIT: 49 }, { WIT: 10 });
    expect(result.WIT).toBe(50);
  });

  it('preserves unrelated keys', () => {
    const result = applyGrowth({ SASS: 7 }, { WIT: 2 });
    expect(result.SASS).toBe(7);
    expect(result.WIT).toBe(2);
  });
});

describe('mergeStats', () => {
  const base = { ENERGY: 50, WARMTH: 50, MISCHIEF: 50, WIT: 50, SASS: 50 } as const;

  it('adds deltas to base stats', () => {
    const result = mergeStats(base, { ENERGY: 5, WIT: -3 });
    expect(result.ENERGY).toBe(55);
    expect(result.WIT).toBe(47);
    expect(result.WARMTH).toBe(50);
  });

  it('clamps to [1, 100]', () => {
    expect(mergeStats(base, { ENERGY: 999 }).ENERGY).toBe(100);
    expect(mergeStats(base, { SASS: -999 }).SASS).toBe(1);
  });

  it('ignores deltas for unknown keys', () => {
    const result = mergeStats(base, { UNKNOWN: 20 } as any);
    expect(result).toEqual(base);
  });
});

describe('constants', () => {
  it('PARTICLE_EMOJI covers every particle', () => {
    for (const p of PARTICLES) {
      expect(PARTICLE_EMOJI[p]).toBeDefined();
    }
  });

  it('STAT_LABELS covers every stat', () => {
    for (const s of STAT_NAMES) {
      expect(STAT_LABELS[s]).toBeTruthy();
    }
  });
});
