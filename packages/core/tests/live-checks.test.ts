import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_BREAKPOINT_WIDTHS,
  LIVE_CHECKS,
  probeLivePages,
  requestedWidths,
  isPreviewUrl,
  PROBE_VIEWPORT_HEIGHT,
  type FocusStop,
  type LiveFacts,
  type LiveProbe,
  type PageProber,
  type ViewportProbe,
} from '@usepolder/current-core';

const keyboard = LIVE_CHECKS['code.keyboard'];
const breakpoints = LIVE_CHECKS['code.breakpoints'];

function stop(overrides: Partial<FocusStop> = {}): FocusStop {
  return { tag: 'button', role: null, name: 'Save', focusVisible: true, native: true, ...overrides };
}

function viewport(width: number, overrides: Partial<ViewportProbe> = {}): ViewportProbe {
  return {
    width,
    height: PROBE_VIEWPORT_HEIGHT,
    horizontalScroll: false,
    scrollWidth: width,
    clientWidth: width,
    overflowing: [],
    ...overrides,
  };
}

function probe(overrides: Partial<LiveProbe> = {}): LiveProbe {
  return {
    url: 'http://localhost:6006/iframe.html?id=button--primary',
    interactiveCount: 1,
    focusStops: [stop()],
    unreachable: [],
    viewports: DEFAULT_BREAKPOINT_WIDTHS.map((w) => viewport(w)),
    ...overrides,
  };
}

function facts(overrides: Partial<LiveFacts> = {}): LiveFacts {
  return { componentName: 'Button', probe: probe(), absence: null, ...overrides };
}

describe('code.keyboard (CO3)', () => {
  it('answers Yes when every interactive element is reachable, focus-visible and native', () => {
    const r = keyboard(facts());
    expect(r.answer).toBe('Yes');
    expect(r.evidence).toContain('native controls');
  });

  it('answers No when an interactive element cannot be reached by Tab', () => {
    const r = keyboard(
      facts({
        probe: probe({
          interactiveCount: 2,
          focusStops: [stop()],
          unreachable: ['<div[role=button]> "Dismiss"'],
        }),
      }),
    );
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain('1 of 2');
    expect(r.evidence).toContain('Dismiss');
  });

  it('answers No when a Tab stop has no focus indicator', () => {
    const r = keyboard(
      facts({ probe: probe({ focusStops: [stop({ focusVisible: false, name: 'Search' })] }) }),
    );
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain('WCAG 2.4.7');
    expect(r.evidence).toContain('Search');
  });

  // Unreachable is the worse failure and must not be masked by a missing ring.
  it('reports unreachable elements before focus indicators', () => {
    const r = keyboard(
      facts({
        probe: probe({
          interactiveCount: 2,
          focusStops: [stop({ focusVisible: false })],
          unreachable: ['<button> "Later"'],
        }),
      }),
    );
    expect(r.evidence).toContain('cannot be reached');
  });

  it('answers N/A for a custom widget, because activation keys are unverifiable', () => {
    const r = keyboard(
      facts({
        probe: probe({
          focusStops: [stop({ tag: 'div', role: 'button', native: false, name: 'Toggle' })],
        }),
      }),
    );
    expect(r.answer).toBe('N/A');
    expect(r.evidence).toContain('Space/Enter/arrow');
  });

  it('answers N/A when the preview has nothing interactive in it', () => {
    const r = keyboard(facts({ probe: probe({ interactiveCount: 0, focusStops: [] }) }));
    expect(r.answer).toBe('N/A');
    expect(r.evidence).toContain('nothing to reach');
  });

  // The absence contract: never No. A missing or broken preview must not
  // read as a component that fails its keyboard norm.
  it('answers N/A with a hint when no preview is mapped', () => {
    const r = keyboard(facts({ probe: null, absence: 'unmapped' }));
    expect(r.answer).toBe('N/A');
    expect(r.evidence).toContain('preview:');
  });

  it('answers N/A with an install hint when no prober is available', () => {
    const r = keyboard(facts({ probe: null, absence: 'no-prober' }));
    expect(r.answer).toBe('N/A');
    expect(r.evidence).toContain('playwright');
  });

  it('answers N/A and surfaces the error when the preview would not load', () => {
    const r = keyboard(
      facts({ probe: null, absence: 'unreachable', absenceDetail: 'net::ERR_CONNECTION_REFUSED' }),
    );
    expect(r.answer).toBe('N/A');
    expect(r.evidence).toContain('ERR_CONNECTION_REFUSED');
  });
});

describe('code.breakpoints (CO6)', () => {
  it('answers Yes when nothing overflows at any probed width', () => {
    const r = breakpoints(facts());
    expect(r.answer).toBe('Yes');
    expect(r.evidence).toContain('320');
  });

  it('answers No and names the width and culprit when content overflows', () => {
    const r = breakpoints(
      facts({
        probe: probe({
          viewports: DEFAULT_BREAKPOINT_WIDTHS.map((w) =>
            w === 320
              ? viewport(w, {
                  horizontalScroll: true,
                  scrollWidth: 412,
                  overflowing: ['div.actions'],
                })
              : viewport(w),
          ),
        }),
      }),
    );
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain('320px: overflows by 92px');
    expect(r.evidence).toContain('div.actions');
  });

  it('fails on an element past the edge even without a document scrollbar', () => {
    const r = breakpoints(
      facts({
        probe: probe({
          viewports: [viewport(320, { overflowing: ['span.label'] }), ...[375, 768, 1024, 1280, 1920].map((w) => viewport(w))],
        }),
      }),
    );
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain('span.label');
  });

  it('only judges the widths its norm asked for', () => {
    const r = breakpoints(
      facts({ probe: probe({ viewports: [viewport(320), viewport(768, { horizontalScroll: true, scrollWidth: 900 })] }) }),
      { widths: [320] },
    );
    expect(r.answer).toBe('Yes');
  });

  it('answers N/A rather than Yes when a requested width was never probed', () => {
    const r = breakpoints(facts({ probe: probe({ viewports: [viewport(320)] }) }), {
      widths: [320, 768],
    });
    expect(r.answer).toBe('N/A');
    expect(r.evidence).toContain('768px');
  });

  it('answers N/A when there is no probe', () => {
    expect(breakpoints(facts({ probe: null, absence: 'unmapped' })).answer).toBe('N/A');
  });
});

describe('requestedWidths', () => {
  it('falls back to the default scale', () => {
    expect(requestedWidths()).toEqual([...DEFAULT_BREAKPOINT_WIDTHS]);
    expect(requestedWidths({})).toEqual([...DEFAULT_BREAKPOINT_WIDTHS]);
  });

  it('sorts and dedupes a configured scale', () => {
    expect(requestedWidths({ widths: [768, 320, 768] })).toEqual([320, 768]);
  });
});

describe('isPreviewUrl', () => {
  it('accepts http(s) URLs and rejects paths', () => {
    expect(isPreviewUrl('http://localhost:6006/iframe.html?id=button')).toBe(true);
    expect(isPreviewUrl('https://storybook.example.com/?path=/story/button')).toBe(true);
    expect(isPreviewUrl('src/Button/Button.stories.tsx')).toBe(false);
  });
});

describe('probeLivePages', () => {
  it('probes each unique URL once', async () => {
    const prober = vi.fn(async (url: string) => probe({ url })) as unknown as PageProber;
    const out = await probeLivePages(['http://a/1', 'http://a/1', 'http://a/2'], prober, [320]);
    expect(out.size).toBe(2);
    expect(prober).toHaveBeenCalledTimes(2);
  });

  // One broken preview must not cost every other component its score.
  it('keeps going when one preview fails, attaching the error to its URL', async () => {
    const prober: PageProber = async (url) => {
      if (url.endsWith('/bad')) throw new Error('net::ERR_ABORTED');
      return probe({ url });
    };
    const out = await probeLivePages(['http://a/bad', 'http://a/good'], prober, [320]);
    expect(out.get('http://a/bad')).toEqual({ error: 'net::ERR_ABORTED' });
    expect(out.get('http://a/good')).toHaveProperty('probe');
  });

  it('passes the configured widths through to the prober', async () => {
    const seen: number[][] = [];
    const prober: PageProber = async (url, widths) => {
      seen.push([...widths]);
      return probe({ url });
    };
    await probeLivePages(['http://a/1'], prober, [320, 1280]);
    expect(seen).toEqual([[320, 1280]]);
  });
});
