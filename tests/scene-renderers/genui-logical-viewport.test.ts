import { describe, expect, it } from 'vitest';
import {
  GENUI_LOGICAL_HEIGHT,
  GENUI_LOGICAL_WIDTH,
  fitGenUiViewport,
} from '@/lib/interactive/logical-viewport';

describe('fixed GenUI logical viewport', () => {
  it('fills a matching 16:9 slot without changing the iframe viewport', () => {
    expect(fitGenUiViewport({ left: 20, top: 30, width: 1280, height: 720 })).toEqual({
      scale: 1,
      box: { left: 20, top: 30, width: 1280, height: 720 },
    });
    expect([GENUI_LOGICAL_WIDTH, GENUI_LOGICAL_HEIGHT]).toEqual([1280, 720]);
  });

  it('centers a scaled-down viewport in a narrow editor pane', () => {
    expect(fitGenUiViewport({ left: 10, top: 20, width: 640, height: 500 })).toEqual({
      scale: 0.5,
      box: { left: 10, top: 90, width: 640, height: 360 },
    });
  });

  it('centers horizontally in a tall slot and scales up consistently', () => {
    expect(fitGenUiViewport({ left: 0, top: 0, width: 1600, height: 1200 })).toEqual({
      scale: 1.25,
      box: { left: 0, top: 150, width: 1600, height: 900 },
    });
  });

  it('collapses safely before the slot has a measurable size', () => {
    expect(fitGenUiViewport({ left: 7, top: 9, width: 0, height: 400 })).toEqual({
      scale: 0,
      box: { left: 7, top: 209, width: 0, height: 0 },
    });
  });

  // A phone pane is about 360 CSS pixels wide. A pure fit there is ~0.28, which
  // renders a 16px label at 4.5px — every interactive scene was illegible. The
  // floor keeps text readable and lets the slot scroll instead.
  it('keeps phone-sized slots legible instead of fitting them exactly', () => {
    const fitted = fitGenUiViewport({ left: 0, top: 0, width: 360, height: 640 });
    expect(fitted.scale).toBeCloseTo(0.7, 5);
    // The canvas is wider than the slot now, and centred, so both edges
    // overflow equally and the wrap can scroll to either.
    expect(fitted.box.width).toBe(GENUI_LOGICAL_WIDTH * 0.7);
    expect(fitted.box.left).toBeLessThan(0);
  });

  // The floor must not reach a desktop pane: 640px fits at 0.5 and scaling it
  // up would push the canvas past its own slot for no benefit.
  it('leaves a desktop-width slot at the pure fit', () => {
    expect(fitGenUiViewport({ left: 10, top: 20, width: 640, height: 500 }).scale).toBe(0.5);
  });
});
