"""Utilities for extracting genetic report information from a screenshot.

This module provides a tiny command line interface that performs OCR on a
clinical genetics report screenshot and attempts to extract the most common
fields of interest.  The parser is intentionally heuristic driven: it scans the
OCR text for key labels (e.g. "Gene", "Variant", "Zygosity") and captures the
text that follows those labels.

Example
-------
    python genetics_report_parser.py path/to/report.png

Dependencies
------------
    * Pillow
    * pytesseract (and the `tesseract` binary installed on the system)
"""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, Optional

try:  # pragma: no cover - import availability depends on environment
    from PIL import Image  # type: ignore
except ImportError:  # pragma: no cover - handled lazily in _ensure_ocr_dependencies
    Image = None  # type: ignore[assignment]

try:  # pragma: no cover - import availability depends on environment
    import pytesseract  # type: ignore
except ImportError:  # pragma: no cover - handled lazily in _ensure_ocr_dependencies
    pytesseract = None  # type: ignore[assignment]


def _ensure_ocr_dependencies() -> None:
    """Ensure Pillow and pytesseract are available before performing OCR."""

    missing = []
    if Image is None:
        missing.append("Pillow")
    if pytesseract is None:
        missing.append("pytesseract")

    if missing:
        raise SystemExit(
            "Missing dependencies. Install " + " and ".join(missing) + " before running this script."
        )


@dataclass
class ExtractionResult:
    """Container for the parsed genetics report fields."""

    patient: Optional[str] = None
    date_of_birth: Optional[str] = None
    medical_record_number: Optional[str] = None
    gene: Optional[str] = None
    transcript: Optional[str] = None
    variant: Optional[str] = None
    zygosity: Optional[str] = None
    interpretation: Optional[str] = None

    def to_dict(self) -> Dict[str, Optional[str]]:
        return {
            "patient": self.patient,
            "date_of_birth": self.date_of_birth,
            "medical_record_number": self.medical_record_number,
            "gene": self.gene,
            "transcript": self.transcript,
            "variant": self.variant,
            "zygosity": self.zygosity,
            "interpretation": self.interpretation,
        }


def _extract_first_match(text: str, patterns: Iterable[str]) -> Optional[str]:
    for pattern in patterns:
        match = re.search(pattern, text, flags=re.IGNORECASE | re.MULTILINE)
        if match:
            # Strip trailing punctuation and whitespace to keep values tidy.
            value = match.group("value").strip().rstrip(",;.")
            return value or None
    return None


def parse_report_text(text: str) -> ExtractionResult:
    """Parse OCR text from a clinical genetics report.

    The function searches for common field labels and returns the extracted
    values. All regex patterns capture the text after the label up to the end of
    the line or a newline.
    """

    patient = _extract_first_match(
        text,
        (
            r"Patient(?: Name)?\s*[:\-]\s*(?P<value>.+)",
            r"Name\s*[:\-]\s*(?P<value>.+)",
        ),
    )
    dob = _extract_first_match(
        text,
        (
            r"Date\s*of\s*Birth\s*[:\-]\s*(?P<value>[0-9/\-]+)",
            r"DOB\s*[:\-]\s*(?P<value>[0-9/\-]+)",
        ),
    )
    mrn = _extract_first_match(
        text,
        (
            r"MRN\s*[:\-]\s*(?P<value>[A-Za-z0-9\-]+)",
            r"Medical\s*Record\s*Number\s*[:\-]\s*(?P<value>[A-Za-z0-9\-]+)",
        ),
    )

    gene = _extract_first_match(
        text,
        (
            r"Gene\s*[:\-]\s*(?P<value>[A-Za-z0-9\-]+)",
            r"Analyzed\s*Gene\s*[:\-]\s*(?P<value>[A-Za-z0-9\-]+)",
        ),
    )
    transcript = _extract_first_match(
        text,
        (
            r"Transcript\s*[:\-]\s*(?P<value>[A-Z0-9_\.]+)",
            r"Ref(?:erence)?\s*Transcript\s*[:\-]\s*(?P<value>[A-Z0-9_\.]+)",
        ),
    )
    variant = _extract_first_match(
        text,
        (
            r"Variant\s*[:\-]\s*(?P<value>.+)",
            r"c\.(?P<value>[A-Za-z0-9_>\-+/]+)",
        ),
    )
    zygosity = _extract_first_match(
        text,
        (
            r"Zygosity\s*[:\-]\s*(?P<value>.+)",
            r"(?P<value>Homozygous|Heterozygous|Hemizygous)",
        ),
    )
    interpretation = _extract_first_match(
        text,
        (
            r"Interpretation\s*[:\-]\s*(?P<value>.+)",
            r"Assessment\s*[:\-]\s*(?P<value>.+)",
            r"Classification\s*[:\-]\s*(?P<value>.+)",
        ),
    )

    return ExtractionResult(
        patient=patient,
        date_of_birth=dob,
        medical_record_number=mrn,
        gene=gene,
        transcript=transcript,
        variant=variant,
        zygosity=zygosity,
        interpretation=interpretation,
    )


def perform_ocr(image_path: Path) -> str:
    """Run OCR on the supplied image path and return the recognised text."""

    _ensure_ocr_dependencies()

    with Image.open(image_path) as image:
        return pytesseract.image_to_string(image)


def extract_from_image(image_path: Path) -> ExtractionResult:
    """Extract key fields from a genetics report screenshot."""

    text = perform_ocr(image_path)
    return parse_report_text(text)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Extract key genetic information from a clinical genetics report screenshot.",
    )
    parser.add_argument(
        "image",
        type=Path,
        help="Path to the screenshot image (PNG, JPG, PDF supported by Pillow).",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Output the extracted data as JSON instead of human readable text.",
    )
    args = parser.parse_args()

    if not args.image.exists():
        raise SystemExit(f"File not found: {args.image}")

    result = extract_from_image(args.image)

    if args.json:
        print(json.dumps(result.to_dict(), indent=2))
    else:
        for field, value in result.to_dict().items():
            print(f"{field.replace('_', ' ').title()}: {value or 'Not found'}")


if __name__ == "__main__":  # pragma: no cover - CLI entrypoint
    main()
