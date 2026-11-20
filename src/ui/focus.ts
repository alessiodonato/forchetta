import { useEffect, useLayoutEffect } from 'preact/hooks';

// Where the keyboard goes when a panel opens and closes: into the panel, and back to what opened it. Without this,
// a panel closed with Esc leaves the focus nowhere, and the keyboard starts again from the top of the page.

/** What can take the focus inside a panel, in the order of the page. */
const FOCUSABLE = 'input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/** The first element of a panel that can take the focus, or the panel itself. */
export function firstFocusable(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>(FOCUSABLE) ?? container;
}

/**
 * While `active`, the panel in `container` has the keyboard: when it opens, the focus goes into it (unless the panel
 * already put it on one of its fields): on its first field, or on the panel itself with `self` (a canvas with keys of
 * its own); when it closes, it goes back to the element that had it before (the button that opened it), if that is
 * still on the page and the focus was not taken elsewhere meanwhile.
 */
export function useReturnFocus(container: { readonly current: HTMLElement | null }, active = true, self = false): void {
  // Read before the effects of the panel run: they may move the focus to one of its fields.
  useLayoutEffect(() => {
    if (!active) return;
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : undefined;
    const node = container.current;
    return () => {
      const now = document.activeElement;
      const lost = !now || now === document.body || (node !== null && node.contains(now));
      if (opener && opener.isConnected && lost) opener.focus({ preventScroll: true });
    };
  }, [active]);
  useEffect(() => {
    if (!active) return;
    // After the effects of the panel: one that focuses its own field goes first.
    const timer = setTimeout(() => {
      const node = container.current;
      if (!node || node.contains(document.activeElement)) return;
      const target = self ? node : firstFocusable(node);
      if (target === node && !node.hasAttribute('tabindex')) node.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
    }, 0);
    return () => clearTimeout(timer);
  }, [active]);
}
