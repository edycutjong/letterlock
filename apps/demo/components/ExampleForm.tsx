"use client";

import type { FormHTMLAttributes } from "react";

export type ExampleFormProps = Omit<FormHTMLAttributes<HTMLFormElement>, "onSubmit" | "action" | "method">;

/**
 * A form on a page that shows example content. Enter in one of its fields runs the page's action, as a click would:
 * the browser presses the form's submit button (an ExampleAction with `submit`), which says nothing is connected
 * yet. The browser's own submission is stopped, since it would load the page again with the fields in its address
 * and throw away what was typed.
 */
export function ExampleForm({ children, ...rest }: ExampleFormProps) {
  return (
    <form {...rest} onSubmit={(e) => e.preventDefault()}>
      {children}
    </form>
  );
}
