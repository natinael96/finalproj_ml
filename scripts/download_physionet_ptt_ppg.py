from __future__ import annotations

import os
import re
from pathlib import Path
from urllib.parse import urljoin

import requests
import wfdb


BASE = "https://physionet.org/files/pulse-transit-time-ppg/1.1.0/"
CSV_URL_DIR = "csv/"  # PhysioNet URL uses lowercase.
CSV_OUT_DIR = "CSV"  # Training loader expects uppercase `<root>/CSV/`.


def _iter_index_links(index_html: str) -> list[str]:
    # Apache-like index: href="filename"
    return re.findall(r'href="([^"]+)"', index_html, flags=re.IGNORECASE)


def _download_file(
    url: str,
    out_path: Path,
    *,
    overwrite: bool = False,
    verbose: bool = False,
    chunk_size: int = 1 << 20,
) -> str:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if out_path.exists() and not overwrite and out_path.stat().st_size > 0:
        if verbose:
            print(f"[skip] {out_path} ({out_path.stat().st_size:,} bytes)")
        return "skipped"

    if verbose:
        action = "overwrite" if out_path.exists() else "download"
        print(f"[{action}] {url}")
        print(f"          -> {out_path}")

    bytes_written = 0
    with requests.get(url, stream=True, timeout=60) as r:
        r.raise_for_status()
        tmp = out_path.with_suffix(out_path.suffix + ".part")
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(chunk_size=chunk_size):
                if chunk:
                    f.write(chunk)
                    bytes_written += len(chunk)
        os.replace(tmp, out_path)

    if verbose:
        print(f"[done] {out_path.name} ({bytes_written:,} bytes)")
    return "downloaded"


def download_csv(out_root: Path, *, overwrite: bool = False, verbose: bool = False) -> None:
    """
    Download the PhysioNet CSV export folder:
      https://physionet.org/files/pulse-transit-time-ppg/1.1.0/csv/
    """
    csv_url = urljoin(BASE, CSV_URL_DIR)
    if verbose:
        print(f"[csv] fetching index: {csv_url}")
    html = requests.get(csv_url, timeout=60).text
    links = _iter_index_links(html)
    if verbose:
        print(f"[csv] found {len(links)} index links")

    downloaded = 0
    skipped = 0
    # Filter to actual CSV files (and subjects_info)
    for href in links:
        if href in ("../", "./"):
            continue
        if href.endswith("/"):
            continue
        # Files we care about are directly under csv/ (no recursion needed for this dataset)
        file_url = urljoin(csv_url, href)
        out_path = out_root / CSV_OUT_DIR / href
        status = _download_file(file_url, out_path, overwrite=overwrite, verbose=verbose)
        if status == "downloaded":
            downloaded += 1
        elif status == "skipped":
            skipped += 1

    print(
        f"[csv] complete: downloaded={downloaded}, skipped={skipped}, "
        f"out={out_root / CSV_OUT_DIR}"
    )


def download_wfdb_records(out_root: Path, *, overwrite: bool = False, verbose: bool = False) -> None:
    """
    Download WFDB records listed in RECORDS using wfdb.dl_database.
    """
    if verbose:
        print(f"[wfdb] downloading pulse-transit-time-ppg to {out_root}")
    wfdb.dl_database("pulse-transit-time-ppg", str(out_root), keep_subdirs=True, overwrite=overwrite)
    print(f"[wfdb] complete: out={out_root}")


def main() -> None:
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="Output dataset root directory")
    ap.add_argument("--overwrite", action="store_true")
    ap.add_argument("--csv-only", action="store_true", help="Only download csv/ exports")
    ap.add_argument("--wfdb-only", action="store_true", help="Only download wfdb records (.hea/.dat/.atr)")
    ap.add_argument("--verbose", action="store_true", help="Print progress for each downloaded/skipped file")
    args = ap.parse_args()

    out_root = Path(args.out)
    out_root.mkdir(parents=True, exist_ok=True)

    if args.csv_only and args.wfdb_only:
        raise SystemExit("Choose at most one of --csv-only/--wfdb-only")

    if args.wfdb_only:
        download_wfdb_records(out_root, overwrite=bool(args.overwrite), verbose=bool(args.verbose))
        return
    if args.csv_only:
        download_csv(out_root, overwrite=bool(args.overwrite), verbose=bool(args.verbose))
        return

    download_wfdb_records(out_root, overwrite=bool(args.overwrite), verbose=bool(args.verbose))
    download_csv(out_root, overwrite=bool(args.overwrite), verbose=bool(args.verbose))


if __name__ == "__main__":
    main()

