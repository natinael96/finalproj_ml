"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import type { DateRange } from "@/lib/trends";

const VALID_RANGES: DateRange[] = ["24h", "7d", "30d", "all"];

function parseRange(value: string | null): DateRange {
  if (value && VALID_RANGES.includes(value as DateRange)) return value as DateRange;
  return "all";
}

export function useHistoryUrl() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const device = searchParams.get("device") ?? "";
  const range = parseRange(searchParams.get("range"));
  const threshold = useMemo(() => {
    const raw = Number(searchParams.get("threshold"));
    return Number.isFinite(raw) && raw >= 80 && raw <= 220 ? raw : 140;
  }, [searchParams]);

  const replaceParams = useCallback(
    (patch: { device?: string; range?: DateRange; threshold?: number }) => {
      const params = new URLSearchParams(searchParams.toString());
      if (patch.device !== undefined) {
        if (patch.device) params.set("device", patch.device);
        else params.delete("device");
      }
      if (patch.range !== undefined) {
        if (patch.range === "all") params.delete("range");
        else params.set("range", patch.range);
      }
      if (patch.threshold !== undefined) {
        if (patch.threshold === 140) params.delete("threshold");
        else params.set("threshold", String(patch.threshold));
      }
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams]
  );

  return { device, range, threshold, replaceParams };
}
