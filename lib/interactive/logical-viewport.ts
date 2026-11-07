import type { ClientBox } from '@/lib/edit/visible-client-rect';

/** The stable CSS viewport every generated interactive page is authored against. */
export const GENUI_LOGICAL_WIDTH = 1280;
export const GENUI_LOGICAL_HEIGHT = 720;

export interface FittedGenUiViewport {
  readonly box: ClientBox;
  readonly scale: number;
}

/**
 * Center one fixed logical GenUI viewport inside an arbitrary screen slot.
 *
 * The generated page is authored against a 1280×720 canvas and carries no
 * viewport meta, so scaling is the only way to fit it.
 *
 * On a desktop pane that ratio can be 0.5 and everything is still fine: the
 * pane is large in real pixels and the page is read with a mouse. On a phone
 * the slot is roughly 360 CSS pixels wide, where a plain fit gives about 0.28 —
 * a 16px label rendered at 4.5px. That is not small print, it is unreadable,
 * and it is what every interactive scene looked like on the device.
 *
 * The floor therefore applies only to slots narrow enough to be a phone. A
 * wider slot keeps the pure fit, because scaling a desktop pane up would push
 * the canvas past its own boundaries for no benefit.
 */
const NARROW_SLOT_WIDTH = 600;
const MIN_LEGIBLE_SCALE = 0.7;

export function fitGenUiViewport(slot: ClientBox): FittedGenUiViewport {
  const fit = Math.max(
    0,
    Math.min(slot.width / GENUI_LOGICAL_WIDTH, slot.height / GENUI_LOGICAL_HEIGHT),
  );
  // Only a narrow slot gets the floor. It overflows, which is visible and
  // recoverable by scrolling; illegible is neither.
  const scale =
    slot.width > 0 && slot.height > 0 && slot.width < NARROW_SLOT_WIDTH
      ? Math.max(fit, MIN_LEGIBLE_SCALE)
      : fit;
  const width = GENUI_LOGICAL_WIDTH * scale;
  const height = GENUI_LOGICAL_HEIGHT * scale;
  return {
    scale,
    box: {
      left: slot.left + (slot.width - width) / 2,
      top: slot.top + (slot.height - height) / 2,
      width,
      height,
    },
  };
}
