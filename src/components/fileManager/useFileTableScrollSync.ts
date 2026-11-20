import { useLayoutEffect, type RefObject } from "react";

/** Keep the fixed header aligned after Ant Design's scroll-source lock drops an update. */
export function useFileTableScrollSync(surfaceRef: RefObject<HTMLDivElement | null>, hasRows: boolean) {
  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    const header = surface?.querySelector<HTMLElement>(".ant-table-header");
    const virtualInner = surface?.querySelector<HTMLElement>(".ant-table-tbody-virtual-holder-inner");
    const body = surface?.querySelector<HTMLElement>(
      virtualInner ? ".ant-table-tbody-virtual-holder" : ".ant-table-body",
    );
    if (!surface || !header || !body) return;

    let frame = 0;
    const syncHeader = () => {
      frame = 0;
      if (!body.clientWidth) return;
      // Virtual rows move with margin-left, so their native scrollLeft stays zero.
      const left = virtualInner
        ? -(Number.parseFloat(virtualInner.style.marginLeft) || 0)
        : body.scrollLeft;
      if (Math.abs(header.scrollLeft - left) > 0.5) header.scrollLeft = left;
    };
    const scheduleSync = () => {
      if (!frame) frame = requestAnimationFrame(syncHeader);
    };

    header.addEventListener("scroll", scheduleSync, { passive: true });
    body.addEventListener("scroll", scheduleSync, { passive: true });
    const offsetObserver = new MutationObserver(scheduleSync);
    if (virtualInner) {
      offsetObserver.observe(virtualInner, { attributes: true, attributeFilter: ["style"] });
    }
    const resizeObserver = new ResizeObserver(scheduleSync);
    resizeObserver.observe(surface);
    syncHeader();

    return () => {
      cancelAnimationFrame(frame);
      offsetObserver.disconnect();
      resizeObserver.disconnect();
      header.removeEventListener("scroll", scheduleSync);
      body.removeEventListener("scroll", scheduleSync);
    };
    // Empty tables use a native body; reconnect when the virtual body is mounted again.
  }, [surfaceRef, hasRows]);
}
