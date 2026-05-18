"use client";

import { useState } from "react";
import { Card, SectionHeader } from "@/components/Card";
import { KpiTile } from "@/components/KpiTile";
import { BP_API_URL } from "@/lib/env";
import { parseFeatureRowsFromCsv } from "@/lib/csv";
import { formatNumber } from "@/lib/format";
import type { ApiHealth, PredictionResponse } from "@/lib/types";

type LabState = "idle" | "loading" | "success" | "error";

export default function LabPage() {
  const [apiUrl, setApiUrl] = useState(BP_API_URL);
  const [featuresText, setFeaturesText] = useState("[0.2, 70, 0.03, 0.1, 1.2, 0.4, 0.18, 0.08, 0.02, 0.07]");
  const [csvText, setCsvText] = useState("features\n\"[0.2,70,0.03,0.1,1.2,0.4,0.18,0.08,0.02,0.07]\"");
  const [health, setHealth] = useState<ApiHealth | null>(null);
  const [prediction, setPrediction] = useState<PredictionResponse | null>(null);
  const [batch, setBatch] = useState<{ sbp: number[]; dbp: number[] } | null>(null);
  const [status, setStatus] = useState("");
  const [labState, setLabState] = useState<LabState>("idle");

  function setLabStatus(state: LabState, message: string) {
    setLabState(state);
    setStatus(message);
  }

  async function checkHealth() {
    setLabStatus("loading", "Checking API health...");
    try {
      const response = await fetch(`${apiUrl.replace(/\/$/, "")}/health`);
      const data = (await response.json()) as ApiHealth;
      setHealth(data);
      setLabStatus(response.ok ? "success" : "error", response.ok ? "API health loaded." : `Health returned HTTP ${response.status}.`);
    } catch (error) {
      setLabStatus("error", `Health check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function predictOne() {
    setLabStatus("loading", "Running single prediction...");
    try {
      const features = JSON.parse(featuresText) as number[];
      const response = await fetch(`${apiUrl.replace(/\/$/, "")}/predict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ features })
      });
      const data = (await response.json()) as PredictionResponse;
      setPrediction(data);
      setLabStatus(response.ok ? "success" : "error", response.ok ? "Prediction complete." : `Prediction returned HTTP ${response.status}.`);
    } catch (error) {
      setLabStatus("error", `Prediction failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function predictBatch() {
    setLabStatus("loading", "Parsing CSV and running batch prediction...");
    try {
      const features = parseFeatureRowsFromCsv(csvText);
      const response = await fetch(`${apiUrl.replace(/\/$/, "")}/predict_batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ features })
      });
      const data = (await response.json()) as { sbp: number[]; dbp: number[] };
      setBatch(data);
      setLabStatus(
        response.ok ? "success" : "error",
        response.ok ? `Batch prediction complete for ${features.length} row(s).` : `Batch returned HTTP ${response.status}.`
      );
    } catch (error) {
      setLabStatus("error", `Batch failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return (
    <div className="pageStack">
      <SectionHeader eyebrow="Technical lab" title="API and CSV prediction workspace" />

      <div className="threeCol">
        <KpiTile label="API base URL" value="FastAPI" meta={apiUrl} />
        <KpiTile label="Health" value={health?.model_loaded ? "Loaded" : "Unknown"} meta="GET /health" tone={health?.model_loaded ? "good" : "neutral"} />
        <KpiTile
          label="Last status"
          value={labState}
          meta={status || "Run a lab action"}
          tone={labState === "success" ? "good" : labState === "error" ? "bad" : labState === "loading" ? "warn" : "neutral"}
        />
      </div>

      <Card>
        <div className="threeCol">
          <div className="fieldStack span2">
            <label htmlFor="apiUrl">FastAPI URL</label>
            <input id="apiUrl" className="input" value={apiUrl} onChange={(event) => setApiUrl(event.target.value)} />
          </div>
          <div className="fieldStack">
            <label>Health endpoint</label>
            <button type="button" className="btn btnPrimary" onClick={checkHealth} disabled={labState === "loading"}>Check /health</button>
          </div>
        </div>
        {health ? <pre className="preBlock">{JSON.stringify(health, null, 2)}</pre> : null}
      </Card>

      <div className="twoCol">
        <Card>
          <div className="cardTitle">Single feature-vector prediction</div>
          <p className="muted">Paste a feature vector aligned with the deployed model schema, then call POST /predict.</p>
          <textarea className="textarea" value={featuresText} onChange={(event) => setFeaturesText(event.target.value)} />
          <div className="rowActions">
            <button type="button" className="btn btnPrimary" onClick={predictOne} disabled={labState === "loading"}>Predict one</button>
            {prediction ? (
              <span className="badge">
                {formatNumber(prediction.sbp)} / {formatNumber(prediction.dbp)} mmHg
              </span>
            ) : null}
          </div>
          {prediction ? <pre className="preBlock">{JSON.stringify(prediction, null, 2)}</pre> : null}
        </Card>

        <Card>
          <div className="cardTitle">CSV batch prediction</div>
          <p className="muted">Supports the Dash app formats: a JSON features column or numeric f0,f1,... columns.</p>
          <textarea className="textarea" value={csvText} onChange={(event) => setCsvText(event.target.value)} />
          <div className="rowActions">
            <button type="button" className="btn btnPrimary" onClick={predictBatch} disabled={labState === "loading"}>Predict batch</button>
            {batch ? <span className="badge">{batch.sbp.length} row(s)</span> : null}
          </div>
          {batch ? <pre className="preBlock">{JSON.stringify(batch, null, 2)}</pre> : null}
        </Card>
      </div>
    </div>
  );
}
