import { Card } from "@/components/Card";

export default function Loading() {
  return (
    <div className="pageStack">
      <Card>
        <div className="loadingRow">
          <span className="spinner" />
          <div>
            <div className="cardTitle">Preparing dashboard</div>
            <p className="muted">Loading the route and dashboard state...</p>
          </div>
        </div>
      </Card>
    </div>
  );
}
