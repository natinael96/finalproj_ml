"use client";

import { Card, SectionHeader } from "@/components/Card";

export default function ErrorPage({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="pageStack">
      <SectionHeader eyebrow="Dashboard error" title="This view could not load" />
      <Card className="callout">
        <div className="cardTitle">Recovery steps</div>
        <p className="muted">
          Keep the demo calm: refresh this route, confirm FastAPI/Supabase environment variables, then retry.
        </p>
        <div className="rowActions">
          <button type="button" className="btn btnPrimary" onClick={reset}>
            Try again
          </button>
          <span className="badge tone-bad">{error.message || "Unknown dashboard error"}</span>
        </div>
      </Card>
    </div>
  );
}
