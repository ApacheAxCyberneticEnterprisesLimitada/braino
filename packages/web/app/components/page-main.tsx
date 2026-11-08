import type * as React from "react";

function classes(base: string, extra?: string) {
  return extra ? `${base} ${extra}` : base;
}

export function PageMain({ className, ...props }: React.ComponentPropsWithoutRef<"main">) {
  return <main className={classes("mx-auto w-full max-w-6xl px-6", className)} {...props} />;
}

export function NarrowPageMain({ className, ...props }: React.ComponentPropsWithoutRef<"main">) {
  return <main className={classes("mx-auto w-full max-w-md px-6", className)} {...props} />;
}
