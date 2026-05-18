import { Card, SectionHeader } from "@/components/Card";

export default function AboutPage() {
  return (
    <div className="pageStack">
      <SectionHeader eyebrow="Viva support" title="What this dashboard proves" />

      <div className="hero">
        <div className="heroCopy">
          <div>
            <div className="eyebrow">Opening answer</div>
            <div className="heroHeadline">A complete cuffless BP prototype, not just a model score.</div>
            <p className="muted">
              The system demonstrates sensing, preprocessing, feature extraction, machine learning inference,
              persistence, and visualization in one reproducible pipeline.
            </p>
          </div>
        </div>
        <Card className="callout">
          <div className="cardTitle">One-sentence purpose</div>
          <p className="muted">
            Estimate systolic and diastolic blood pressure from ECG, PPG, and motion signals without an inflatable
            cuff, while making the end-to-end engineering visible.
          </p>
        </Card>
      </div>

      <div className="threeCol">
        <Card>
          <div className="cardTitle">What to show first</div>
          <p className="muted">Open Live, sign in, stream ESP32 data, and point out the latest SBP/DBP window.</p>
        </Card>
        <Card>
          <div className="cardTitle">What to show second</div>
          <p className="muted">Open History to show persistence, filtering, trend analytics, and export.</p>
        </Card>
        <Card>
          <div className="cardTitle">What to show third</div>
          <p className="muted">Open Model and Lab to explain methodology, limitations, API health, and predictions.</p>
        </Card>
      </div>

      <Card className="callout">
        <div className="cardTitle">Live assessment fallback language</div>
        <p className="muted">
          If hardware contact or Wi-Fi is unstable, say clearly that the live system is window-based: the API still
          needs a full buffered ECG/PPG segment before the dashboard can receive a BP prediction.
        </p>
      </Card>

      <Card>
        <div className="cardTitle">Runbook</div>
        <pre className="preBlock">
{`# API
uvicorn bp_api.main:app --host 0.0.0.0 --port 8000 --reload

# Dashboard
cd dashboard
npm install
npm run dev

# Browser
http://localhost:3000/overview`}
        </pre>
      </Card>
    </div>
  );
}
