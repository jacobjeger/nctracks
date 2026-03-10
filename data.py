"""Data loading and result saving for NCTracks Eligibility Verifier."""

import os
from datetime import datetime

import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment

from config import OUTPUT_COLUMNS, INPUT_COLUMNS


def load_patients(file_path: str) -> list[dict]:
    """Load patient list from Excel (.xlsx) or CSV (.csv) file.

    Returns list of dicts with keys: medicaid_id, first_name, last_name, dob
    """
    ext = os.path.splitext(file_path)[1].lower()
    if ext == ".csv":
        return _load_csv(file_path)
    elif ext in (".xlsx", ".xls"):
        return _load_excel(file_path)
    else:
        raise ValueError(f"Unsupported file format: {ext}. Use .csv or .xlsx")


def _load_csv(file_path: str) -> list[dict]:
    import csv

    patients = []
    with open(file_path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        _validate_columns(reader.fieldnames, file_path)
        for row in reader:
            patients.append(_normalize_row(row))
    return patients


def _load_excel(file_path: str) -> list[dict]:
    wb = openpyxl.load_workbook(file_path, read_only=True)
    ws = wb.active
    rows = list(ws.iter_rows(values_only=True))
    if not rows:
        raise ValueError(f"Empty spreadsheet: {file_path}")

    headers = [str(h).strip() if h else "" for h in rows[0]]
    _validate_columns(headers, file_path)

    patients = []
    for row in rows[1:]:
        if all(cell is None for cell in row):
            continue
        row_dict = dict(zip(headers, row))
        patients.append(_normalize_row(row_dict))

    wb.close()
    return patients


def _validate_columns(headers: list[str] | None, file_path: str):
    if headers is None:
        raise ValueError(f"Could not read headers from {file_path}")
    headers_upper = [h.upper().strip() for h in headers]
    for col in INPUT_COLUMNS:
        if col.upper() not in headers_upper:
            raise ValueError(
                f"Missing required column '{col}' in {file_path}. "
                f"Expected columns: {INPUT_COLUMNS}"
            )


def _normalize_row(row: dict) -> dict:
    """Normalize a row dict to standard keys."""
    normalized = {}
    for key, value in row.items():
        if key is None:
            continue
        k = key.strip().upper()
        val = str(value).strip() if value is not None else ""
        if k == "MEDICAID ID":
            normalized["medicaid_id"] = val
        elif k == "FIRST NAME":
            normalized["first_name"] = val
        elif k == "LAST NAME":
            normalized["last_name"] = val
        elif k == "DOB":
            normalized["dob"] = val
    return normalized


def save_results(results: list[dict], output_path: str):
    """Save verification results to an Excel file."""
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Eligibility Results"

    # Header styling
    header_font = Font(bold=True, color="FFFFFF", size=11)
    header_fill = PatternFill(start_color="2F5496", end_color="2F5496", fill_type="solid")
    header_align = Alignment(horizontal="center", wrap_text=True)

    # Write headers
    for col_idx, header in enumerate(OUTPUT_COLUMNS, 1):
        cell = ws.cell(row=1, column=col_idx, value=header)
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = header_align

    # Write data
    status_colors = {
        "ELIGIBLE": PatternFill(start_color="C6EFCE", end_color="C6EFCE", fill_type="solid"),
        "NOT ELIGIBLE": PatternFill(start_color="FFC7CE", end_color="FFC7CE", fill_type="solid"),
    }

    for row_idx, result in enumerate(results, 2):
        ws.cell(row=row_idx, column=1, value=result.get("medicaid_id", ""))
        ws.cell(row=row_idx, column=2, value=result.get("name", ""))

        status = result.get("status", "UNKNOWN")
        status_cell = ws.cell(row=row_idx, column=3, value=status)
        if status in status_colors:
            status_cell.fill = status_colors[status]

        ws.cell(row=row_idx, column=4, value=result.get("coverage_start", ""))
        ws.cell(row=row_idx, column=5, value=result.get("coverage_end", ""))
        ws.cell(row=row_idx, column=6, value=result.get("plan_name", ""))
        ws.cell(row=row_idx, column=7, value=result.get("checked_at", ""))
        ws.cell(row=row_idx, column=8, value=result.get("notes", ""))

    # Auto-width columns
    for col in ws.columns:
        max_length = 0
        col_letter = col[0].column_letter
        for cell in col:
            if cell.value:
                max_length = max(max_length, len(str(cell.value)))
        ws.column_dimensions[col_letter].width = min(max_length + 4, 40)

    wb.save(output_path)
    return output_path


def generate_output_path(input_path: str) -> str:
    """Generate output file path based on input file name."""
    base = os.path.splitext(os.path.basename(input_path))[0]
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    directory = os.path.dirname(input_path) or "."
    return os.path.join(directory, f"{base}_results_{timestamp}.xlsx")
