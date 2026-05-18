import Link from "next/link";
import { Card, SectionHeader } from "@/components/Card";
import { KpiTile } from "@/components/KpiTile";

const stages = [
  ["Acquire", "ESP32 or replay script streams ECG, PPG, accelerometer, and gyroscope samples."],
  ["Window", "FastAPI buffers samples into 8-second inference windows."],
  ["Extract", "The pipeline computes PTT, HRV, PPG statistics, and motion features."],
  ["Predict", "The trained multi-output model estimates SBP and DBP."],
  ["Visualize", "Supabase and WebSockets feed live, history, lab, and examiner pages."]
];

export default function OverviewPage() {
  return (
    <div className="pageStack">
      <SectionHeader eyebrow="Project objective" title="Cuffless BP monitoring, end to end" />
      <div className="hero">
        <div className="heroCopy">
          <div>
            <div className="eyebrow">Research prototype</div>
            <div className="heroHeadline">From wearable signals to demo-ready BP insight.</div>
            <p className="muted">
              This dashboard turns the final-year project into a guided product surface: live inference, stored
              history, device/session operations, model methodology, and a technical API lab.
            </p>
          </div>
          <div className="heroStrip">
            <Link href="/live" className="badge">Open live monitor</Link>
            <Link href="/lab" className="badge">Test API lab</Link>
            <Link href="/model" className="badge">Explain the model</Link>
          </div>
        </div>
        <div className="heroPanel">
          <KpiTile label="Prediction target" value="SBP / DBP" meta="Systolic and diastolic pressure in mmHg" />
          <KpiTile label="Window cadence" value="8" unit="sec" meta="Default tumbling window size" />
          <KpiTile label="Primary source" value="ECG + PPG" meta="IMU motion features support artifact handling" />
        </div>
      </div>

      <div className="twoCol">
        <Card>
          <div className="cardTitle">Demo checklist</div>
          <div className="timeline">
            {["Start FastAPI on port 8000", "Sign in to the dashboard", "Copy user_id into replay or ESP32 ingest", "Open Live while streaming", "Use History and Model pages for questions"].map((item) => (
              <div className="timelineItem" key={item}>
                <span className="timelineDot" />
                <p className="muted">{item}</p>
              </div>
            ))}
          </div>
        </Card>
        <Card className="callout">
          <div className="cardTitle">Presentation map</div>
          <p className="muted">
            Overview, Model, About, and Lab explain the project without telemetry sign-in. Live, History, and Devices
            require the Supabase user that matches the ESP32 or replay <code>user_id</code>.
          </p>
        </Card>
      </div>

      <Card className="callout">
        <div className="cardTitle">Important limitation</div>
        <p className="muted">
          The project is a proof-of-concept research prototype. It demonstrates signal acquisition, feature
          extraction, inference, persistence, and visualization, but it is not calibrated or certified for medical
          diagnosis.
        </p>
      </Card>

      <Card>
        <div className="cardTitle">Pipeline narrative</div>
        <div className="fiveStageGrid">
          {stages.map(([title, text]) => (
            <div className="stageCard" key={title}>
              <div className="eyebrow">{title}</div>
              <p className="muted">{text}</p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
