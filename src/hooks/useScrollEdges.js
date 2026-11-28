import { useEffect } from "react";

const toggle = (element, name, on) => {
  if (on === element.hasAttribute(name)) return;
  if (on) element.setAttribute(name, "");
  else element.removeAttribute(name);
};

/**
 * Mirrors a scroller's edges onto a frame as data attributes, so the frame's
 * fixed header and footer can draw their dividers only when content actually
 * runs under them (and a photo-led sheet can raise its top bar once the title
 * has gone under it).
 *
 *   data-scrolled     – the body is scrolled away from its top.
 *   data-more-below   – there is content below the visible part of the body.
 *   data-past-title   – the element matching `titleSelector` (if any) has
 *                       scrolled under the top `titleOffset` px of the body.
 *                       Without a selector, the same as data-scrolled.
 *
 * Written straight to the DOM, never through React state: a scroll handler
 * that re-renders the panel on every frame is the thing to avoid in a sheet.
 * Each attribute is only touched when its value flips.
 *
 * @param {{current: HTMLElement|null}} scrollRef - the scrolling body.
 * @param {{current: HTMLElement|null}} frameRef  - where the attributes go.
 * @param {{titleSelector?: string, titleOffset?: number, enabled?: boolean}} [options]
 */
export function useScrollEdges(scrollRef, frameRef, { titleSelector, titleOffset = 76, enabled = true } = {}) {
  useEffect(() => {
    if (!enabled) return undefined;
    const scroller = scrollRef.current;
    const frame = frameRef.current;
    if (!scroller || !frame) return undefined;

    let pending = 0;
    const update = () => {
      pending = 0;
      const { scrollTop, scrollHeight, clientHeight } = scroller;
      toggle(frame, "data-scrolled", scrollTop > 1);
      toggle(frame, "data-more-below", scrollHeight - clientHeight - scrollTop > 1);
      let past = scrollTop > 1;
      if (titleSelector) {
        const anchor = scroller.querySelector(titleSelector);
        if (anchor) {
          past = anchor.getBoundingClientRect().bottom < scroller.getBoundingClientRect().top + titleOffset;
        }
      }
      toggle(frame, "data-past-title", past);
    };
    const schedule = () => {
      if (!pending) pending = requestAnimationFrame(update);
    };

    // Content grows and shrinks without scrolling (a tab switch, a step of
    // the wizard, an expanded row), so overflow is re-read on resize of the
    // scroller and of everything directly inside it.
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    const observeChildren = () => {
      if (!resize) return;
      resize.disconnect();
      resize.observe(scroller);
      for (const child of scroller.children) resize.observe(child);
    };
    observeChildren();
    const mutations = typeof MutationObserver === "undefined" ? null : new MutationObserver(() => {
      observeChildren();
      schedule();
    });
    mutations?.observe(scroller, { childList: true });

    update();
    scroller.addEventListener("scroll", schedule, { passive: true });
    return () => {
      cancelAnimationFrame(pending);
      scroller.removeEventListener("scroll", schedule);
      resize?.disconnect();
      mutations?.disconnect();
    };
  }, [scrollRef, frameRef, titleSelector, titleOffset, enabled]);
}
