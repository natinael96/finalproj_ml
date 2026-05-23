"""
Seed Supabase auth users (admins + demo accounts) via the Admin API.

Requires env vars:
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY

Usage:
  python scripts/seed_admins.py
  python scripts/seed_admins.py --config scripts/seed_admins.json
  python scripts/seed_admins.py --email admin@local.test --password Admin123! --role admin
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

import requests

DEFAULT_CONFIG = Path(__file__).resolve().parent / "seed_admins.json"


def _load_env_file(path: Path) -> None:
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


def supabase_config() -> dict[str, str]:
    root = Path(__file__).resolve().parents[1]
    _load_env_file(root / ".env")
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not url or not key:
        raise SystemExit(
            "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.\n"
            "Set them in the environment or in a root .env file."
        )
    return {"url": url, "key": key}


def admin_headers(cfg: dict[str, str]) -> dict[str, str]:
    return {
        "apikey": cfg["key"],
        "Authorization": f"Bearer {cfg['key']}",
        "Content-Type": "application/json",
    }


def list_users(cfg: dict[str, str]) -> list[dict[str, Any]]:
    users: list[dict[str, Any]] = []
    page = 1
    while True:
        r = requests.get(
            f"{cfg['url']}/auth/v1/admin/users",
            headers=admin_headers(cfg),
            params={"page": page, "per_page": 200},
            timeout=30,
        )
        if r.status_code >= 400:
            raise RuntimeError(f"List users failed {r.status_code}: {r.text}")
        batch = r.json().get("users") or []
        if not batch:
            break
        users.extend(batch)
        if len(batch) < 200:
            break
        page += 1
    return users


def users_by_email(cfg: dict[str, str]) -> dict[str, dict[str, Any]]:
    return {
        (u.get("email") or "").lower(): u
        for u in list_users(cfg)
        if u.get("email")
    }


def create_user(cfg: dict[str, str], entry: dict[str, str]) -> dict[str, Any]:
    role = entry.get("role", "user")
    body = {
        "email": entry["email"],
        "password": entry["password"],
        "email_confirm": True,
        "app_metadata": {"role": role},
        "user_metadata": {"display_name": entry.get("display_name") or entry["email"]},
    }
    r = requests.post(
        f"{cfg['url']}/auth/v1/admin/users",
        headers=admin_headers(cfg),
        json=body,
        timeout=30,
    )
    if r.status_code >= 400:
        raise RuntimeError(f"Create user failed {r.status_code}: {r.text}")
    return r.json()


def update_user_role(cfg: dict[str, str], user_id: str, entry: dict[str, str]) -> dict[str, Any]:
    role = entry.get("role", "user")
    body = {
        "app_metadata": {"role": role},
        "user_metadata": {"display_name": entry.get("display_name") or entry["email"]},
    }
    r = requests.put(
        f"{cfg['url']}/auth/v1/admin/users/{user_id}",
        headers=admin_headers(cfg),
        json=body,
        timeout=30,
    )
    if r.status_code >= 400:
        raise RuntimeError(f"Update user failed {r.status_code}: {r.text}")
    return r.json()


def load_entries(args: argparse.Namespace) -> list[dict[str, str]]:
    if args.email:
        return [
            {
                "email": args.email,
                "password": args.password or "ChangeMe123!",
                "role": args.role,
                "display_name": args.display_name or args.email,
            }
        ]
    config_path = Path(args.config)
    if not config_path.is_file():
        raise SystemExit(f"Config not found: {config_path}")
    data = json.loads(config_path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise SystemExit("Config must be a JSON array of user objects.")
    return data


def seed_user(cfg: dict[str, str], entry: dict[str, str], existing: dict[str, dict[str, Any]]) -> tuple[str, str, str]:
    email = entry["email"].strip().lower()
    password = entry.get("password", "")
    role = entry.get("role", "user")
    if not email:
        raise ValueError("email is required")
    if not password:
        raise ValueError(f"password is required for {email}")

    found = existing.get(email)
    if found:
        user_id = found["id"]
        current_role = (found.get("app_metadata") or {}).get("role")
        if current_role != role:
            update_user_role(cfg, user_id, entry)
            return email, user_id, "updated"
        return email, user_id, "exists"

    created = create_user(cfg, entry)
    return email, created["id"], "created"


def main() -> None:
    ap = argparse.ArgumentParser(description="Seed Supabase admin/demo users.")
    ap.add_argument("--config", default=str(DEFAULT_CONFIG), help="JSON file with users to seed")
    ap.add_argument("--email", help="Seed a single user instead of the config file")
    ap.add_argument("--password", help="Password when using --email")
    ap.add_argument("--role", default="admin", choices=("admin", "user"), help="Role for --email")
    ap.add_argument("--display-name", dest="display_name", help="Display name for --email")
    args = ap.parse_args()

    cfg = supabase_config()
    entries = load_entries(args)
    existing = users_by_email(cfg)

    print(f"Supabase: {cfg['url']}")
    print(f"Seeding {len(entries)} user(s)...\n")
    print(f"{'email':<28} {'role':<8} {'status':<8} user_id")
    print("-" * 80)

    for entry in entries:
        email, user_id, status = seed_user(cfg, entry, existing)
        role = entry.get("role", "user")
        print(f"{email:<28} {role:<8} {status:<8} {user_id}")

    print("\nSign in at the Next.js dashboard with these credentials.")
    print("Copy user_id from Live/History/Devices for ESP32 or replay --user-id.")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, ValueError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
