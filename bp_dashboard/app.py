from __future__ import annotations

import base64
import io
import json
import os
from typing import List, Optional, Tuple

import pandas as pd
import plotly.graph_objects as go
import requests
from dash import Dash, Input, Output, State, dcc, html


API_URL_DEFAULT = os.environ.get("BP_API_URL", "http://127.0.0.1:8000")


def _parse_uploaded_csv(contents: str) -> pd.DataFrame:
    header, b64 = contents.split(",", 1)
    raw = base64.b64decode(b64)
    return pd.read_csv(io.BytesIO(raw))


def _extract_feature_rows(df: pd.DataFrame) -> List[List[float]]:
    """
    Supported formats:
      - A column named 'features' containing JSON arrays
      - Columns named f0,f1,... (all numeric)
    """
    if "features" in df.columns:
        out = []
        for v in df["features"].tolist():
            if isinstance(v, str):
                out.append([float(x) for x in json.loads(v)])
            elif isinstance(v, list):
                out.append([float(x) for x in v])
            else:
                raise ValueError("Column 'features' must be JSON string arrays or lists")
        return out

    fcols = [c for c in df.columns if c.lower().startswith("f")]
    if not fcols:
        raise ValueError("No features found. Provide 'features' column or f0,f1,... columns.")
    fcols_sorted = sorted(fcols, key=lambda c: int("".join([ch for ch in c if ch.isdigit()]) or "0"))
    return df[fcols_sorted].astype(float).values.tolist()


def _predict_batch(features_rows: List[List[float]], api_url: str) -> Tuple[List[float], List[float]]:
    sbp = []
    dbp = []
    for row in features_rows:
        r = requests.post(f"{api_url.rstrip('/')}/predict", json={"features": row}, timeout=30)
        if r.status_code != 200:
            raise RuntimeError(f"API error {r.status_code}: {r.text}")
        j = r.json()
        sbp.append(float(j["sbp"]))
        dbp.append(float(j["dbp"]))
    return sbp, dbp


def _build_figure(df: pd.DataFrame, sbp_col: str, dbp_col: str, thr: float) -> go.Figure:
    x = df["t"] if "t" in df.columns else list(range(len(df)))
    fig = go.Figure()
    fig.add_trace(go.Scatter(x=x, y=df[sbp_col], mode="lines+markers", name="SBP"))
    fig.add_trace(go.Scatter(x=x, y=df[dbp_col], mode="lines+markers", name="DBP"))
    fig.add_hline(y=thr, line_dash="dash", line_color="crimson", annotation_text=f"SBP threshold {thr}")
    fig.update_layout(
        template="plotly_white",
        margin=dict(l=40, r=20, t=30, b=40),
        height=520,
        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="left", x=0),
        xaxis_title="time (t) or sample index",
        yaxis_title="mmHg",
    )
    return fig


app = Dash(__name__)
server = app.server

app.layout = html.Div(
    style={"maxWidth": "1100px", "margin": "24px auto", "fontFamily": "system-ui, -apple-system, Segoe UI, Roboto"},
    children=[
        html.H2("Blood Pressure Dashboard"),
        html.Div(
            style={"color": "#444", "marginBottom": "12px"},
            children=[
                html.Div("Upload a CSV containing either actual SBP/DBP columns, or features to be predicted via the API."),
                html.Div("CSV options:"),
                html.Ul(
                    [
                        html.Li("Actual values: columns 'sbp' and 'dbp' (optional 't')"),
                        html.Li("To predict: column 'features' with JSON arrays, or numeric columns f0,f1,..."),
                    ]
                ),
            ],
        ),
        html.Div(
            style={"display": "grid", "gridTemplateColumns": "1fr 1fr 1fr", "gap": "12px", "marginBottom": "12px"},
            children=[
                html.Div(
                    children=[
                        html.Label("API URL (used only for prediction mode)"),
                        dcc.Input(id="api-url", type="text", value=API_URL_DEFAULT, style={"width": "100%"}),
                    ]
                ),
                html.Div(
                    children=[
                        html.Label("SBP alert threshold (mmHg)"),
                        dcc.Input(id="sbp-thr", type="number", value=140, style={"width": "100%"}),
                    ]
                ),
                html.Div(
                    children=[
                        html.Label("Mode"),
                        dcc.Dropdown(
                            id="mode",
                            options=[
                                {"label": "Use CSV SBP/DBP columns", "value": "actual"},
                                {"label": "Predict via API from features", "value": "predict"},
                            ],
                            value="actual",
                            clearable=False,
                        ),
                    ]
                ),
            ],
        ),
        dcc.Upload(
            id="upload",
            children=html.Div(["Drag and drop or ", html.A("select a CSV file")]),
            style={
                "width": "100%",
                "height": "64px",
                "lineHeight": "64px",
                "borderWidth": "1px",
                "borderStyle": "dashed",
                "borderRadius": "10px",
                "textAlign": "center",
                "marginBottom": "12px",
                "background": "#fafafa",
            },
            multiple=False,
        ),
        html.Div(id="status", style={"marginBottom": "12px", "color": "#333"}),
        dcc.Graph(id="graph"),
        html.Div(id="alerts", style={"marginTop": "12px"}),
    ],
)


@app.callback(
    Output("graph", "figure"),
    Output("status", "children"),
    Output("alerts", "children"),
    Input("upload", "contents"),
    State("upload", "filename"),
    Input("mode", "value"),
    Input("api-url", "value"),
    Input("sbp-thr", "value"),
)
def update(contents: Optional[str], filename: Optional[str], mode: str, api_url: str, sbp_thr: float):
    if not contents:
        fig = go.Figure().update_layout(template="plotly_white", height=520)
        return fig, "Upload a CSV to begin.", ""

    try:
        df = _parse_uploaded_csv(contents)
        df = df.copy()

        if mode == "actual":
            if "sbp" not in df.columns or "dbp" not in df.columns:
                raise ValueError("CSV must contain 'sbp' and 'dbp' columns for actual mode.")
            sbp_col, dbp_col = "sbp", "dbp"
        else:
            rows = _extract_feature_rows(df)
            sbp, dbp = _predict_batch(rows, api_url=api_url)
            df["sbp_pred"] = sbp
            df["dbp_pred"] = dbp
            sbp_col, dbp_col = "sbp_pred", "dbp_pred"

        fig = _build_figure(df, sbp_col=sbp_col, dbp_col=dbp_col, thr=float(sbp_thr))

        high = df[df[sbp_col] > float(sbp_thr)]
        if len(high) > 0:
            msg = f"ALERT: {len(high)} points above SBP {sbp_thr} mmHg."
            alert = html.Div(
                msg,
                style={
                    "padding": "10px 12px",
                    "border": "1px solid #f3b7b7",
                    "background": "#fff5f5",
                    "borderRadius": "10px",
                    "color": "#7a1d1d",
                    "fontWeight": 600,
                },
            )
        else:
            alert = html.Div(
                "No SBP threshold breaches detected.",
                style={
                    "padding": "10px 12px",
                    "border": "1px solid #cfe8d5",
                    "background": "#f5fff7",
                    "borderRadius": "10px",
                    "color": "#1f5a2e",
                    "fontWeight": 600,
                },
            )

        return fig, f"Loaded `{filename}` with {len(df)} rows.", alert
    except Exception as e:
        fig = go.Figure().update_layout(template="plotly_white", height=520)
        return fig, f"Error: {e}", ""


if __name__ == "__main__":
    app.run(debug=True)

