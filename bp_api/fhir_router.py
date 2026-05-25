"""
FHIR R4 read-only endpoints — Cuffless BP Studio
=================================================

Endpoints
---------
  GET /fhir/metadata                   CapabilityStatement
  GET /fhir/Observation                Bundle of BP Observations (telemetry_windows)
  GET /fhir/Observation/{id}           Single Observation
  GET /fhir/Patient/{patient_id}       Synthetic Patient scoped to a Supabase user UUID
  GET /fhir/Device                     Bundle of Device resources (devices table)
  GET /fhir/Device/{device_id}         Single Device resource

All endpoints are read-only.  Authentication is delegated to the parent app
via the `dependencies=[Depends(_require_api_key)]` argument in app.include_router().

FHIR mappings
-------------
  telemetry_windows row  →  Observation (LOINC 55284-4, components 8480-6 / 8462-4)
  devices row            →  Device  (SNOMED 706689003 — software device)
  Supabase user UUID     →  Patient (synthetic; no PHI stored)
"""
from __future__ import annotations

import os
from datetime import datetime, timezone
from functools import lru_cache
from typing import Any, Dict, List, Optional

import requests
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse

# ── constants ────────────────────────────────────────────────────────────────

FHIR_CONTENT_TYPE = "application/fhir+json; charset=utf-8"
FHIR_VERSION      = "4.0.1"

router = APIRouter(prefix="/fhir", tags=["FHIR R4"])

# ── Supabase config (read directly from env — avoids circular import) ─────────

@lru_cache(maxsize=1)
def _fhir_supabase_cfg() -> Optional[Dict[str, str]]:
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not url or not key:
        return None
    return {"url": url, "key": key}


def _server_base() -> str:
    return os.environ.get("FHIR_SERVER_BASE", "http://localhost:8000/fhir")


def _require_supabase() -> Dict[str, str]:
    cfg = _fhir_supabase_cfg()
    if not cfg:
        raise HTTPException(
            status_code=503,
            detail="FHIR endpoints require SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to be set.",
        )
    return cfg


# ── low-level Supabase helper ─────────────────────────────────────────────────

def _sb_get(cfg: Dict[str, str], table: str, params: Dict[str, str]) -> List[Dict[str, Any]]:
    """Run a Supabase PostgREST SELECT and return the row list."""
    endpoint = f"{cfg['url']}/rest/v1/{table}"
    headers  = {
        "apikey":        cfg["key"],
        "Authorization": f"Bearer {cfg['key']}",
        "Accept":        "application/json",
    }
    try:
        r = requests.get(endpoint, headers=headers, params=params, timeout=15)
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"Upstream request failed: {exc}") from exc
    if r.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"Upstream query failed ({r.status_code})")
    return r.json()


# ── FHIR response helper ──────────────────────────────────────────────────────

def _fhir_resp(body: Dict[str, Any], status: int = 200) -> JSONResponse:
    return JSONResponse(content=body, status_code=status, media_type=FHIR_CONTENT_TYPE)


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ── resource mappers ──────────────────────────────────────────────────────────

def _row_to_observation(row: Dict[str, Any]) -> Dict[str, Any]:
    """Map one telemetry_windows row to a FHIR R4 Observation."""
    obs_id     = str(row.get("id", ""))
    user_id    = row.get("user_id", "")
    device_id  = row.get("device_id", "")
    created_at = row.get("created_at", _now_iso())
    sbp        = row.get("sbp_pred")
    dbp        = row.get("dbp_pred")
    sbp_std    = row.get("sbp_std")
    dbp_std    = row.get("dbp_std")

    obs: Dict[str, Any] = {
        "resourceType": "Observation",
        "id": obs_id,
        "meta": {
            "lastUpdated": created_at,
            "profile": ["http://hl7.org/fhir/StructureDefinition/bp"],
        },
        "status": "final",
        "category": [{
            "coding": [{
                "system":  "http://terminology.hl7.org/CodeSystem/observation-category",
                "code":    "vital-signs",
                "display": "Vital Signs",
            }]
        }],
        "code": {
            "coding": [{
                "system":  "http://loinc.org",
                "code":    "55284-4",
                "display": "Blood pressure systolic and diastolic",
            }],
            "text": "Blood pressure",
        },
        "effectiveDateTime": created_at,
        "component": [],
        "extension": [
            {
                "url":          "https://bp-studio.local/fhir/StructureDefinition/window-seconds",
                "valueDecimal": row.get("window_s", 8.0),
            },
            {
                "url":          "https://bp-studio.local/fhir/StructureDefinition/sampling-rate-hz",
                "valueDecimal": row.get("fs_hz", 250),
            },
            {
                "url":          "https://bp-studio.local/fhir/StructureDefinition/synthetic",
                "valueBoolean": bool(row.get("synthetic", False)),
            },
        ],
    }

    if user_id:
        obs["subject"] = {"reference": f"Patient/{user_id}"}
    if device_id:
        obs["device"] = {"reference": f"Device/{device_id}"}

    def _bp_component(loinc: str, display: str, value: float,
                      std: Optional[float]) -> Dict[str, Any]:
        comp: Dict[str, Any] = {
            "code": {
                "coding": [{
                    "system":  "http://loinc.org",
                    "code":    loinc,
                    "display": display,
                }]
            },
            "valueQuantity": {
                "value":  round(float(value), 1),
                "unit":   "mmHg",
                "system": "http://unitsofmeasure.org",
                "code":   "mm[Hg]",
            },
        }
        if std is not None:
            comp["extension"] = [{
                "url":          "https://bp-studio.local/fhir/StructureDefinition/prediction-std",
                "valueDecimal": round(float(std), 2),
            }]
        return comp

    if sbp is not None:
        obs["component"].append(
            _bp_component("8480-6", "Systolic blood pressure", sbp, sbp_std)
        )
    if dbp is not None:
        obs["component"].append(
            _bp_component("8462-4", "Diastolic blood pressure", dbp, dbp_std)
        )

    return obs


def _user_to_patient(user_id: str) -> Dict[str, Any]:
    """Synthetic FHIR Patient for a Supabase user UUID (no PHI stored)."""
    return {
        "resourceType": "Patient",
        "id": user_id,
        "meta": {"lastUpdated": _now_iso()},
        "identifier": [{
            "use":    "official",
            "system": "urn:ietf:rfc:4122",
            "value":  user_id,
        }],
        "active": True,
        "text": {
            "status": "generated",
            "div":    f'<div xmlns="http://www.w3.org/1999/xhtml">Patient {user_id}</div>',
        },
    }


def _device_to_fhir(device_id: str, label: Optional[str] = None) -> Dict[str, Any]:
    """Map a device_id + optional label to a FHIR R4 Device resource."""
    return {
        "resourceType": "Device",
        "id": device_id,
        "meta": {"lastUpdated": _now_iso()},
        "identifier": [{
            "system": "urn:ietf:rfc:3986",
            "value":  f"urn:device:{device_id}",
        }],
        "status": "active",
        "type": {
            "coding": [{
                "system":  "http://snomed.info/sct",
                "code":    "706689003",
                "display": "Application program software",
            }]
        },
        "deviceName": [{
            "name": label or device_id,
            "type": "user-friendly-name",
        }],
        "note": [{
            "text": "ESP32-based cuffless blood pressure monitor — ECG + PPG + IMU sensor fusion."
        }],
    }


def _bundle(resource_type: str, entries: List[Dict[str, Any]], total: int) -> Dict[str, Any]:
    base = _server_base()
    return {
        "resourceType": "Bundle",
        "type":         "searchset",
        "total":        total,
        "entry": [
            {
                "fullUrl":  f"{base}/{resource_type}/{e['id']}",
                "resource": e,
            }
            for e in entries
        ],
    }


# ── /fhir/metadata ────────────────────────────────────────────────────────────

@router.get(
    "/metadata",
    summary="FHIR R4 CapabilityStatement",
    response_class=JSONResponse,
)
def fhir_metadata() -> JSONResponse:
    """
    Returns the server's CapabilityStatement describing supported resource types,
    interactions, and search parameters.
    """
    base = _server_base()
    cap: Dict[str, Any] = {
        "resourceType": "CapabilityStatement",
        "id":           "bp-studio-fhir-capability",
        "status":       "active",
        "date":         _now_iso(),
        "publisher":    "Cuffless BP Studio",
        "kind":         "instance",
        "software": {
            "name":    "Cuffless BP Studio — FHIR Adapter",
            "version": "1.0.0",
        },
        "implementation": {
            "description": "Read-only FHIR R4 adapter exposing cuffless BP telemetry as standard Observations.",
            "url":         base,
        },
        "fhirVersion": FHIR_VERSION,
        "format":      ["application/fhir+json"],
        "rest": [{
            "mode": "server",
            "security": {
                "description": "API key via X-Api-Key request header (when BP_API_KEY is configured)."
            },
            "resource": [
                {
                    "type":    "Observation",
                    "profile": "http://hl7.org/fhir/StructureDefinition/bp",
                    "interaction": [
                        {"code": "read"},
                        {"code": "search-type"},
                    ],
                    "searchParam": [
                        {
                            "name":          "patient",
                            "type":          "reference",
                            "documentation": "Filter by patient (user) UUID, e.g. ?patient=<uuid>",
                        },
                        {
                            "name":          "device",
                            "type":          "reference",
                            "documentation": "Filter by device ID, e.g. ?device=esp32-001",
                        },
                        {
                            "name":          "date",
                            "type":          "date",
                            "documentation": "ISO date prefix, e.g. ?date=2026-05-24",
                        },
                        {
                            "name":          "_count",
                            "type":          "number",
                            "documentation": "Max results to return (1–200, default 50)",
                        },
                    ],
                },
                {
                    "type":        "Patient",
                    "interaction": [{"code": "read"}],
                },
                {
                    "type":    "Device",
                    "interaction": [
                        {"code": "read"},
                        {"code": "search-type"},
                    ],
                    "searchParam": [
                        {
                            "name":          "patient",
                            "type":          "reference",
                            "documentation": "Filter by owning user UUID",
                        },
                        {
                            "name":          "_count",
                            "type":          "number",
                            "documentation": "Max results (1–200, default 50)",
                        },
                    ],
                },
            ],
        }],
    }
    return _fhir_resp(cap)


# ── /fhir/Observation ────────────────────────────────────────────────────────

_OBS_SELECT = (
    "id,device_id,user_id,created_at,ts_ms_start,"
    "sbp_pred,dbp_pred,sbp_std,dbp_std,synthetic,window_s,fs_hz"
)


@router.get(
    "/Observation",
    summary="Search blood pressure Observations",
    response_class=JSONResponse,
)
def fhir_observation_search(
    patient: Optional[str] = Query(None, description="Patient (user) UUID"),
    device:  Optional[str] = Query(None, description="Device ID"),
    date:    Optional[str] = Query(None, description="ISO date prefix e.g. 2026-05-24"),
    count:   int            = Query(50, ge=1, le=200, alias="_count"),
    cfg:     Dict[str, str] = Depends(_require_supabase),
) -> JSONResponse:
    """
    Returns a FHIR Bundle (searchset) of Observation resources mapped from
    `telemetry_windows`.  Each Observation carries SBP + DBP as components
    with LOINC codes 8480-6 and 8462-4.

    Supports ?patient, ?device, ?date, ?_count search parameters.
    """
    params: Dict[str, str] = {
        "select": _OBS_SELECT,
        "order":  "created_at.desc",
        "limit":  str(count),
    }
    if patient:
        params["user_id"] = f"eq.{patient.removeprefix('Patient/')}"
    if device:
        params["device_id"] = f"eq.{device.removeprefix('Device/')}"
    if date:
        params["created_at"] = f"gte.{date}T00:00:00Z"

    rows = _sb_get(cfg, "telemetry_windows", params)
    observations = [_row_to_observation(r) for r in rows]
    return _fhir_resp(_bundle("Observation", observations, len(observations)))


@router.get(
    "/Observation/{obs_id}",
    summary="Read a single blood pressure Observation",
    response_class=JSONResponse,
)
def fhir_observation_read(
    obs_id: str,
    cfg:    Dict[str, str] = Depends(_require_supabase),
) -> JSONResponse:
    rows = _sb_get(cfg, "telemetry_windows", {
        "select": _OBS_SELECT,
        "id":     f"eq.{obs_id}",
        "limit":  "1",
    })
    if not rows:
        raise HTTPException(status_code=404, detail=f"Observation/{obs_id} not found.")
    return _fhir_resp(_row_to_observation(rows[0]))


# ── /fhir/Patient ─────────────────────────────────────────────────────────────

@router.get(
    "/Patient/{patient_id}",
    summary="Read a Patient resource (scoped to Supabase user UUID)",
    response_class=JSONResponse,
)
def fhir_patient_read(
    patient_id: str,
    cfg:        Dict[str, str] = Depends(_require_supabase),
) -> JSONResponse:
    """
    Returns a synthetic FHIR Patient for the given user UUID.  Existence is
    verified by checking for at least one telemetry row with that user_id.
    No personally identifiable information is stored or returned.
    """
    rows = _sb_get(cfg, "telemetry_windows", {
        "select": "user_id",
        "user_id": f"eq.{patient_id}",
        "limit":  "1",
    })
    if not rows:
        raise HTTPException(
            status_code=404,
            detail=f"Patient/{patient_id} not found (no telemetry associated with this user).",
        )
    return _fhir_resp(_user_to_patient(patient_id))


# ── /fhir/Device ──────────────────────────────────────────────────────────────

@router.get(
    "/Device",
    summary="Search Device resources",
    response_class=JSONResponse,
)
def fhir_device_search(
    patient: Optional[str] = Query(None, description="Owner user UUID"),
    count:   int            = Query(50, ge=1, le=200, alias="_count"),
    cfg:     Dict[str, str] = Depends(_require_supabase),
) -> JSONResponse:
    """
    Returns a FHIR Bundle (searchset) of Device resources from the `devices`
    table.  Each device corresponds to a registered ESP32 unit.
    """
    params: Dict[str, str] = {
        "select": "device_id,label,user_id,created_at",
        "order":  "created_at.desc",
        "limit":  str(count),
    }
    if patient:
        params["user_id"] = f"eq.{patient.removeprefix('Patient/')}"

    rows = _sb_get(cfg, "devices", params)
    devices = [_device_to_fhir(r["device_id"], r.get("label")) for r in rows]
    return _fhir_resp(_bundle("Device", devices, len(devices)))


@router.get(
    "/Device/{device_id}",
    summary="Read a single Device resource",
    response_class=JSONResponse,
)
def fhir_device_read(
    device_id: str,
    cfg:       Dict[str, str] = Depends(_require_supabase),
) -> JSONResponse:
    """
    Returns a FHIR Device resource for the given device_id.  If the device is
    not in the `devices` registry a minimal synthetic resource is returned
    (the device may exist in raw batches but not yet be labelled).
    """
    rows = _sb_get(cfg, "devices", {
        "select":    "device_id,label",
        "device_id": f"eq.{device_id}",
        "limit":     "1",
    })
    label = rows[0].get("label") if rows else None
    return _fhir_resp(_device_to_fhir(device_id, label))
