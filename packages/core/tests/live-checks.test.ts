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
  type StateProbe,
  type ViewportProbe,
} from '@usepolder/current-core';

const keyboard = LIVE_CHECKS['code.keyboard'];
const breakpoints = LIVE_CHECKS['code.breakpoints'];
const states = LIVE_CHECKS['code.states'];

function stop(overrides: Partial<FocusStop> = {}): FocusStop {
  return { tag: 'button', role: null, name: 'Save', focusVisible: true, native: true, ...overrides };
}

function state(overrides: Partial<StateProbe> = {}): StateProbe {
  return {
    tag: 'button',
    role: null,
    name: 'Save',
    hover: true,
    pressed: true,
    focus: true,
    formField: false,
    ...overrides,
  };
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
    states: [state()],
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

describe('code.states (CO1)', () => {
  /**
   * The headline decision: a clean probe is never a Yes. Three of the nine
   * states this metric lists can be forced on a rendered element; the other
   * six need the component driven through its props, so "nothing missing in
   * what we could force" must not read as "all necessary states present".
   */
  it('answers N/A, not Yes, when every measurable state is visible', () => {
    const r = states(facts());
    expect(r.answer).toBe('N/A');
    expect(r.evidence).toContain('hover and pressed are visible on all 1 control(s)');
    expect(r.evidence).toContain('loading, selected, active, error, disabled');
  });

  it('answers No when a control looks identical on hover', () => {
    const r = states(
      facts({
        probe: probe({
          interactiveCount: 2,
          states: [state(), state({ name: 'Cancel', hover: false })],
        }),
      }),
    );
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain('1 of 2 control(s) look identical on hover');
    expect(r.evidence).toContain('"Cancel"');
  });

  it('answers No when a control looks identical while pressed', () => {
    const r = states(facts({ probe: probe({ states: [state({ pressed: false })] }) }));
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain('identical while pressed');
  });

  /** Hover is the worse absence, so it is the one reported. */
  it('reports the missing hover state ahead of the missing pressed state', () => {
    const r = states(
      facts({ probe: probe({ states: [state({ hover: false, pressed: false })] }) }),
    );
    expect(r.evidence).toContain('identical on hover');
    expect(r.evidence).not.toContain('pressed');
  });

  it('answers No when a probed element shows no focus state', () => {
    const r = states(facts({ probe: probe({ states: [state({ focus: false })] }) }));
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain('no focus state (WCAG 2.4.7)');
  });

  /** Unreachable is CO3's finding. Charging CO1 for it too would double-bill. */
  it('does not fail an element the Tab walk never reached', () => {
    const r = states(facts({ probe: probe({ states: [state({ focus: null })] }) }));
    expect(r.answer).toBe('N/A');
    expect(r.evidence).not.toContain('focus');
  });

  /**
   * A native text box has no hover style and does not need one — the platform
   * styles it and it signals by focusing. Judging it on hover would report a
   * No on every form in the system.
   */
  it('judges native form fields on focus alone', () => {
    const r = states(
      facts({
        probe: probe({
          states: [state({ tag: 'input', name: '', hover: false, pressed: false, formField: true })],
        }),
      }),
    );
    expect(r.answer).toBe('N/A');
    expect(r.evidence).toContain('native form fields, judged on focus alone');
  });

  it('still fails a form field with no focus state', () => {
    const r = states(
      facts({
        probe: probe({
          states: [state({ tag: 'input', hover: false, pressed: false, formField: true, focus: false })],
        }),
      }),
    );
    expect(r.answer).toBe('No');
    expect(r.evidence).toContain('no focus state');
  });

  it('answers N/A when the renderer could not force pseudo-states', () => {
    const r = states(facts({ probe: probe({ states: null }) }));
    expect(r.answer).toBe('N/A');
    expect(r.evidence).toContain('could not force :hover / :active');
  });

  it('answers N/A when the preview renders nothing interactive', () => {
    const r = states(facts({ probe: probe({ interactiveCount: 0, states: [] }) }));
    expect(r.answer).toBe('N/A');
    expect(r.evidence).toContain('no interactive elements');
  });

  it('answers N/A when there are interactive elements but none could be measured', () => {
    const r = states(facts({ probe: probe({ interactiveCount: 3, states: [] }) }));
    expect(r.answer).toBe('N/A');
    expect(r.evidence).toContain('none of the 3 interactive element(s)');
  });

  it('answers N/A with the reason when there is no probe at all', () => {
    expect(states(facts({ probe: null, absence: 'unmapped' })).answer).toBe('N/A');
    expect(states(facts({ probe: null, absence: 'no-prober' })).evidence).toContain('playwright');
    expect(
      states(facts({ probe: null, absence: 'unreachable', absenceDetail: 'net::ERR' })).evidence,
    ).toContain('net::ERR');
  });

  /**
   * The flag that keeps CO1 in the to-answer list: every N/A this check can
   * return means "could not settle", except the one for a preview with
   * nothing interactive in it, which is settled.
   */
  it('marks its unsettled answers as still needing a human', () => {
    expect(states(facts()).needsHuman).toBe(true);
    expect(states(facts({ probe: probe({ states: null }) })).needsHuman).toBe(true);
    expect(states(facts({ probe: probe({ interactiveCount: 3, states: [] }) })).needsHuman).toBe(
      true,
    );
    expect(states(facts({ probe: null, absence: 'unmapped' })).needsHuman).toBe(true);
    // A settled N/A and a finding are both the machine's to keep.
    expect(
      states(facts({ probe: probe({ interactiveCount: 0, states: [] }) })).needsHuman,
    ).toBeUndefined();
    expect(
      states(facts({ probe: probe({ states: [state({ hover: false })] }) })).needsHuman,
    ).toBeUndefined();
  });

  it('caps the elements it names in the evidence', () => {
    const many = Array.from({ length: 9 }, (_, i) => state({ name: `B${i}`, hover: false }));
    const r = states(facts({ probe: probe({ interactiveCount: 9, states: many }) }));
    expect(r.evidence).toContain('9 of 9');
    expect(r.evidence).toContain('"B4"');
    expect(r.evidence).not.toContain('"B5"');
  });
});
