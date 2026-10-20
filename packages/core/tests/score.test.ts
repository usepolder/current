import { describe, expect, it } from 'vitest';
import {
  averageConfidentScore,
  averageScore,
  quadrantFor,
  scoreAnswers,
} from '@usepolder/current-core';
import type { Answer } from '@usepolder/current-core';

const yes: Answer = 'Yes';
const no: Answer = 'No';
const na: Answer = 'N/A';

describe('scoreAnswers', () => {
  it('scores Yes over (Yes + No), excluding N/A from the denominator', () => {
    const score = scoreAnswers([yes, yes, no, na], 3);
    expect(score.score).toBe(66.7);
    expect(score.yes).toBe(2);
    expect(score.no).toBe(1);
    expect(score.na).toBe(1);
    expect(score.answered).toBe(3);
  });

  it('returns null — not zero — when every metric is N/A', () => {
    const score = scoreAnswers([na, na, na], 3);
    expect(score.score).toBeNull();
    expect(score.answered).toBe(0);
    expect(score.lowConfidence).toBe(false);
  });

  it('returns null for an empty category rather than dividing by zero', () => {
    expect(scoreAnswers([], 3).score).toBeNull();
  });

  it('never produces NaN for any all-N/A input', () => {
    for (const count of [1, 5, 32]) {
      const score = scoreAnswers(Array<Answer>(count).fill(na), 3);
      expect(score.score).toBeNull();
      expect(Number.isNaN(score.score as unknown as number)).toBe(false);
    }
  });

  it('flags low confidence below the minimum but still scores', () => {
    const score = scoreAnswers([yes], 3);
    expect(score.score).toBe(100);
    expect(score.lowConfidence).toBe(true);
  });

  it('does not flag low confidence at exactly the minimum', () => {
    const score = scoreAnswers([yes, yes, no], 3);
    expect(score.answered).toBe(3);
    expect(score.lowConfidence).toBe(false);
  });

  it('scores 0 when everything answered is No', () => {
    const score = scoreAnswers([no, no], 3);
    expect(score.score).toBe(0);
    expect(score.lowConfidence).toBe(true);
  });

  it('withholds a score entirely when the axis is degraded', () => {
    const score = scoreAnswers([yes, yes, yes, yes], 3, true);
    expect(score.degraded).toBe(true);
    expect(score.score).toBeNull();
    // The answers are still counted so the report can show what a human said.
    expect(score.yes).toBe(4);
  });

  it('is not degraded by default', () => {
    expect(scoreAnswers([yes], 3).degraded).toBe(false);
  });
});

describe('quadrantFor', () => {
  it('puts strong code and strong design in healthy (top right)', () => {
    expect(quadrantFor(80, 90, 60)).toBe('healthy');
  });

  it('puts strong design over weak code in critical (top left)', () => {
    expect(quadrantFor(30, 90, 60)).toBe('critical');
  });

  it('puts weak both in monitor (bottom left)', () => {
    expect(quadrantFor(20, 30, 60)).toBe('monitor');
  });

  it('puts strong code over weak design in moderate (bottom right)', () => {
    expect(quadrantFor(90, 20, 60)).toBe('moderate');
  });

  it('treats exactly the threshold as strong on both axes', () => {
    expect(quadrantFor(60, 60, 60)).toBe('healthy');
    expect(quadrantFor(59.9, 60, 60)).toBe('critical');
    expect(quadrantFor(60, 59.9, 60)).toBe('moderate');
    expect(quadrantFor(59.9, 59.9, 60)).toBe('monitor');
  });

  it('does not plot a component with an undefined axis', () => {
    expect(quadrantFor(null, 80, 60)).toBeNull();
    expect(quadrantFor(80, null, 60)).toBeNull();
    expect(quadrantFor(null, null, 60)).toBeNull();
  });

  it('honours a custom threshold', () => {
    expect(quadrantFor(75, 75, 80)).toBe('monitor');
    expect(quadrantFor(75, 75, 70)).toBe('healthy');
  });
});

describe('averageConfidentScore', () => {
  const axis = (score: number | null, answered: number, lowConfidence = false) => ({
    score,
    yes: 0,
    no: 0,
    na: 0,
    answered,
    lowConfidence,
    degraded: false,
  });

  it('leaves thin scores out of the average', () => {
    // The failure case this exists for: a component whose docs page could not
    // be read falls back to one hand-answered Yes and scores 100%. Counting
    // that at full weight makes a network failure look like good health.
    const result = averageConfidentScore([
      axis(50, 9),
      axis(70, 9),
      axis(100, 1, true),
      axis(100, 1, true),
    ]);
    expect(result.score).toBe(60);
    expect(result.contributing).toBe(2);
    expect(result.excluded).toBe(2);
  });

  it('a failed fetch can no longer raise the total', () => {
    const measured = [axis(50, 9), axis(70, 9)];
    const before = averageConfidentScore(measured);
    const after = averageConfidentScore([...measured, axis(100, 1, true)]);
    expect(after.score).toBe(before.score);
  });

  it('ignores undefined axes entirely', () => {
    const result = averageConfidentScore([axis(80, 9), axis(null, 0)]);
    expect(result.score).toBe(80);
    expect(result.contributing).toBe(1);
    expect(result.excluded).toBe(0);
  });

  it('falls back to the thin scores when every axis is thin', () => {
    // Reporting nothing would be worse than reporting something flagged.
    const result = averageConfidentScore([axis(100, 1, true), axis(0, 1, true)]);
    expect(result.score).toBe(50);
    expect(result.contributing).toBe(2);
    expect(result.excluded).toBe(0);
  });

  it('returns null when nothing is scored at all', () => {
    expect(averageConfidentScore([axis(null, 0)]).score).toBeNull();
  });
});

describe('averageScore', () => {
  it('ignores undefined axes instead of averaging them in as zero', () => {
    expect(averageScore([100, null, 50])).toBe(75);
  });

  it('returns null when nothing is scored', () => {
    expect(averageScore([null, null])).toBeNull();
    expect(averageScore([])).toBeNull();
  });
});
