import type { ReactNode } from "react";

export function PageHeader({
  breadcrumb,
  title,
  children,
}: {
  breadcrumb?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="space-y-1">
      {breadcrumb}
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {children}
    </div>
  );
}
