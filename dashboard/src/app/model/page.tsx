import { Card, SectionHeader } from "@/components/Card";
import { KpiTile } from "@/components/KpiTile";

const features = [
  "PTT mean/std and inverse PTT proxy",
  "RR interval mean/std and HRV RMSSD",
  "PPG mean, standard deviation, skewness, kurtosis",
  "Accelerometer and gyroscope RMS / jerk RMS"
];

export default function ModelPage() {
  return (
    <div className="pageStack">
      <SectionHeader eyebrow="Model methodology" title="How the BP estimate is produced" />

      <div className="fourCol">
        <KpiTile label="SBP MAE" value="11.98" unit="mmHg" meta="PhysioNet artifact metrics" />
        <KpiTile label="DBP MAE" value="5.65" unit="mmHg" meta="PhysioNet artifact metrics" />
        <KpiTile label="Features" value="10" meta="Top selected deployment schema" />
        <KpiTile label="Test windows" value="450" meta="Held-out evaluation split" />
      </div>

      <div className="twoCol">
        <Card>
          <div className="cardTitle">Physiology argument</div>
          <p className="muted">
            ECG supplies the heart&apos;s electrical timing and PPG supplies the peripheral pulse arrival. The delay
            between them, pulse transit time, changes with pulse wave velocity and arterial stiffness. The model uses
            PTT together with heart-rate, PPG morphology, and motion features because BP is not determined by one
            signal alone.
          </p>
        </Card>
        <Card className="callout">
          <div className="cardTitle">Uncertainty proxy</div>
          <p className="muted">
            When available, <code>sbp_std</code> and <code>dbp_std</code> are tree-spread heuristics from the ensemble.
            They are useful for demo confidence cues, but they are not calibrated clinical intervals.
          </p>
        </Card>
      </div>

      <Card>
        <div className="cardTitle">Feature families</div>
        <div className="threeCol">
          {features.map((feature) => (
            <div className="stageCard" key={feature}>
              <span className="timelineDot" />
              <p className="muted">{feature}</p>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <div className="cardTitle">Examiner-ready limitations</div>
        <div className="timeline">
          {[
            "This is not a medical-grade device; it is a reproducible research prototype.",
            "Subject-specific calibration and cuff-labeled live ESP32 data would improve real deployment validity.",
            "Motion artifacts and poor PPG contact can distort timing and morphology features.",
            "PhysioNet labels are assigned per recording/window, which is a simplifying assumption."
          ].map((item) => (
            <div className="timelineItem" key={item}>
              <span className="timelineDot" />
              <p className="muted">{item}</p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
