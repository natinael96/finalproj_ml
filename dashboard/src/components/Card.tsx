import type { ReactNode } from "react";

export function Card({
  children,
  className = "",
  as = "section"
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "article";
}) {
  const Component = as;
  return <Component className={`card ${className}`.trim()}>{children}</Component>;
}

export function SectionHeader({
  eyebrow,
  title,
  children
}: {
  eyebrow?: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="sectionHeader">
      <div>
        {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
        <h1>{title}</h1>
      </div>
      {children ? <div className="sectionActions">{children}</div> : null}
    </div>
  );
}
