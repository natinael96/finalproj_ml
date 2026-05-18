"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

const navItems = [
  { href: "/overview", label: "Overview" },
  { href: "/live", label: "Live" },
  { href: "/history", label: "History" },
  { href: "/devices", label: "Devices" },
  { href: "/lab", label: "Lab" },
  { href: "/model", label: "Model" },
  { href: "/about", label: "About" }
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="appShell">
      <aside className="sidebar">
        <Link href="/overview" className="brandBlock" aria-label="BP dashboard overview">
          <span className="brandMark">BP</span>
          <span>
            <span className="brandTitle">Cuffless BP Studio</span>
            <span className="brandSub">Research prototype dashboard</span>
          </span>
        </Link>
        <nav className="sideNav" aria-label="Dashboard navigation">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={pathname === item.href || (pathname === "/" && item.href === "/overview") ? "active" : ""}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="sidebarNote">
          <span className="eyebrow">Demo posture</span>
          <p>Use live mode for streaming, history for trends, and lab/model pages for examiner questions.</p>
        </div>
      </aside>
      <main className="mainPanel">{children}</main>
    </div>
  );
}
