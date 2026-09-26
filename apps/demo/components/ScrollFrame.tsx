"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

export type ScrollFrameProps = {
  /** names the region while it scrolls */
  label: string;
  className?: string;
  "data-layout"?: string;
  children: ReactNode;
};

/**
 * A frame whose content may be wider than it: the content slides sideways inside the frame and the page never scrolls
 * sideways. While the content does not fit, the frame is a named region in the Tab order, so a keyboard can scroll
 * it; while it fits, it is neither, and adds no Tab stop with nothing to do. Re-measured whenever the frame or its
 * content changes size (a narrower window, a face that loads late).
 */
export function ScrollFrame({ label, className, children, ...rest }: ScrollFrameProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrolls, setScrolls] = useState(false);
  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    const measure = () => setScrolls(frame.scrollWidth > frame.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    if (frame.firstElementChild) observer.observe(frame.firstElementChild);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      {...rest}
      ref={ref}
      className={className}
      role={scrolls ? "region" : undefined}
      aria-label={scrolls ? label : undefined}
      tabIndex={scrolls ? 0 : undefined}
    >
      {children}
    </div>
  );
}
