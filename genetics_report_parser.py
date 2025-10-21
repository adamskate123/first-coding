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
from difflib import SequenceMatcher
from pathlib import Path
from typing import Dict, Iterable, Optional, Tuple, Union

try:  # pragma: no cover - import availability depends on environment
    from PIL import Image  # type: ignore
except ImportError:  # pragma: no cover - handled lazily in _ensure_ocr_dependencies
    Image = None  # type: ignore[assignment]

try:  # pragma: no cover - import availability depends on environment
    import pytesseract  # type: ignore
except ImportError:  # pragma: no cover - handled lazily in _ensure_ocr_dependencies
    pytesseract = None  # type: ignore[assignment]

try:  # pragma: no cover - optional dependency for fuzzy label matching
    from rapidfuzz import process as rapidfuzz_process
except ImportError:  # pragma: no cover - fuzzy matching remains optional
    rapidfuzz_process = None  # type: ignore[assignment]


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


PatternType = Union[str, Tuple[str, str]]


def _extract_first_match(text: str, patterns: Iterable[PatternType]) -> Optional[str]:
    """Search *text* for the first regex pattern, allowing fuzzy label matching."""

    lines = text.splitlines()
    line_headings = []
    line_prefixes: list[Optional[str]] = []
    for line in lines:
        delimiter_match = re.search(r"[:\-]", line)
        if delimiter_match:
            prefix = line[: delimiter_match.start()]
            line_headings.append(prefix.strip())
            line_prefixes.append(prefix)
        else:
            line_headings.append(line.strip())
            line_prefixes.append(None)
    for pattern in patterns:
        label: Optional[str]
        regex: str

        if isinstance(pattern, tuple):
            label, regex = pattern
        else:
            label = None
            regex = pattern

        search_targets = []
        fuzzy_result = None
        fuzzy_index: Optional[int] = None
        if label:
            if rapidfuzz_process is not None:
                fuzzy_result = rapidfuzz_process.extractOne(label, line_headings, score_cutoff=80)
                if fuzzy_result:
                    _, _, fuzzy_index = fuzzy_result
            else:
                best_score = 0.0
                best_index: Optional[int] = None
                for idx, heading in enumerate(line_headings):
                    if not heading:
                        continue
                    score = SequenceMatcher(None, label.lower(), heading.lower()).ratio()
                    if score >= 0.8 and score > best_score:
                        best_score = score
                        best_index = idx
                fuzzy_index = best_index

        if fuzzy_index is not None:
            line_idx = fuzzy_index
            segment_lines = []
            normalized_line = lines[line_idx]
            prefix = line_prefixes[line_idx]
            if prefix is not None and label:
                normalized_line = label + normalized_line[len(prefix) :]
            segment_lines.append(normalized_line)
            if line_idx + 1 < len(lines):
                segment_lines.append(lines[line_idx + 1])
            search_targets.append("\n".join(segment_lines))

        search_targets.append(text)

        seen_targets = set()
        for target in search_targets:
            if target in seen_targets:
                continue
            seen_targets.add(target)

            match = re.search(regex, target, flags=re.IGNORECASE | re.MULTILINE)
            if match:
                # Strip trailing punctuation and whitespace to keep values tidy.
                value = match.group("value").strip().rstrip(",;.")
                return value or None
    return None


def _extract_table_like_fields(text: str) -> Dict[str, Optional[str]]:
    """Fallback heuristics for low quality reports with missing headings."""

    gene_pattern = re.compile(r"\b([A-Z0-9]{2,})\b")
    transcript_pattern = re.compile(r"\b((?:NM|NC|LRG|ENST)[0-9._]+)\b", re.IGNORECASE)
    variant_pattern = re.compile(r"(c\.[A-Za-z0-9_>+\-/]+|p\.[A-Za-z0-9_>+\-/]+)")
    zygosity_pattern = re.compile(r"\b(Heterozygous|Homozygous|Hemizygous)\b", re.IGNORECASE)

    interpretation_keywords = {
        "pathogenic": "Pathogenic",
        "likely pathogenic": "Likely pathogenic",
        "variant of uncertain significance": "Variant of Uncertain Significance",
        "uncertain significance": "Variant of Uncertain Significance",
        "vus": "Variant of Uncertain Significance",
        "likely benign": "Likely benign",
        "benign": "Benign",
        "risk factor": "Risk factor",
    }

    fallback: Dict[str, Optional[str]] = {
        "gene": None,
        "transcript": None,
        "variant": None,
        "zygosity": None,
        "interpretation": None,
    }

    lines = [line.strip() for line in text.splitlines() if line.strip()]
    for idx, line in enumerate(lines):
        variant_match = variant_pattern.search(line)
        if not variant_match:
            continue

        fallback_variant = variant_match.group(1)
        fallback_gene: Optional[str] = None
        fallback_transcript: Optional[str] = None
        fallback_zygosity: Optional[str] = None
        fallback_interpretation: Optional[str] = None

        # Look backward in the same line for a gene symbol.
        prior_text = line[: variant_match.start()]
        for gene_match in gene_pattern.finditer(prior_text):
            fallback_gene = gene_match.group(1)

        # Transcript can appear either before or after the variant token.
        transcript_match = transcript_pattern.search(line)
        if transcript_match:
            fallback_transcript = transcript_match.group(1)

        zygosity_match = zygosity_pattern.search(line)
        if zygosity_match:
            fallback_zygosity = zygosity_match.group(1).title()

        lowered_line = line.lower()
        for keyword, canonical in interpretation_keywords.items():
            if keyword in lowered_line:
                fallback_interpretation = canonical
                break

        # Interpretation is sometimes wrapped to the following line.
        if fallback_interpretation is None and idx + 1 < len(lines):
            next_line_lower = lines[idx + 1].lower()
            for keyword, canonical in interpretation_keywords.items():
                if keyword in next_line_lower:
                    fallback_interpretation = canonical
                    break

        fallback.update(
            {
                "gene": fallback.get("gene") or fallback_gene,
                "transcript": fallback.get("transcript") or fallback_transcript,
                "variant": fallback.get("variant") or fallback_variant,
                "zygosity": fallback.get("zygosity") or fallback_zygosity,
                "interpretation": fallback.get("interpretation") or fallback_interpretation,
            }
        )

        # Stop early if we've collected everything.
        if all(fallback.values()):
            break

    return fallback


def parse_report_text(text: str) -> ExtractionResult:
    """Parse OCR text from a clinical genetics report.

    The function searches for common field labels and returns the extracted
    values. All regex patterns capture the text after the label up to the end of
    the line or a newline.
    """

    patient = _extract_first_match(
        text,
        (
            ("Patient", r"Patient(?: Name)?\s*[:\-]\s*(?P<value>.+)"),
            r"Name\s*[:\-]\s*(?P<value>.+)",
        ),
    )
    dob = _extract_first_match(
        text,
        (
            ("Date of Birth", r"Date\s*of\s*Birth\s*[:\-]\s*(?P<value>[0-9/\-]+)"),
            r"DOB\s*[:\-]\s*(?P<value>[0-9/\-]+)",
        ),
    )
    mrn = _extract_first_match(
        text,
        (
            ("MRN", r"MRN\s*[:\-]\s*(?P<value>[A-Za-z0-9\-]+)"),
            ("Medical Record Number", r"Medical\s*Record\s*Number\s*[:\-]\s*(?P<value>[A-Za-z0-9\-]+)"),
        ),
    )

    gene = _extract_first_match(
        text,
        (
            ("Gene", r"Gene\s*[:\-]\s*(?P<value>[A-Za-z0-9\-]+)"),
            ("Gene", r"Analyzed\s*Gene\s*[:\-]\s*(?P<value>[A-Za-z0-9\-]+)"),
        ),
    )
    transcript = _extract_first_match(
        text,
        (
            ("Transcript", r"Transcript\s*[:\-]\s*(?P<value>[A-Z0-9_\.]+)"),
            ("Transcript", r"Ref(?:erence)?\s*Transcript\s*[:\-]\s*(?P<value>[A-Z0-9_\.]+)"),
        ),
    )
    variant = _extract_first_match(
        text,
        (
            ("Variant", r"Variant\s*[:\-]\s*(?P<value>.+)"),
            r"c\.(?P<value>[A-Za-z0-9_>\-+/]+)",
        ),
    )
    zygosity = _extract_first_match(
        text,
        (
            ("Zygosity", r"Zygosity\s*[:\-]\s*(?P<value>.+)"),
            r"(?P<value>Homozygous|Heterozygous|Hemizygous)",
        ),
    )
    interpretation = _extract_first_match(
        text,
        (
            ("Interpretation", r"Interpretation\s*[:\-]\s*(?P<value>.+)"),
            ("Assessment", r"Assessment\s*[:\-]\s*(?P<value>.+)"),
            ("Classification", r"Classification\s*[:\-]\s*(?P<value>.+)"),
        ),
    )

    result = ExtractionResult(
        patient=patient,
        date_of_birth=dob,
        medical_record_number=mrn,
        gene=gene,
        transcript=transcript,
        variant=variant,
        zygosity=zygosity,
        interpretation=interpretation,
    )

    # Apply fallback heuristics for cases where column headers were not captured
    # cleanly in the OCR output (e.g., faxed or low contrast scans).
    table_like_fields = _extract_table_like_fields(text)
    if result.gene is None and table_like_fields["gene"]:
        result.gene = table_like_fields["gene"]
    if result.transcript is None and table_like_fields["transcript"]:
        result.transcript = table_like_fields["transcript"]
    if table_like_fields["variant"]:
        if result.variant is None:
            result.variant = table_like_fields["variant"]
        else:
            current = result.variant.lower()
            candidate = table_like_fields["variant"].lower()
            if candidate.startswith(("c.", "p.")) and not current.startswith(("c.", "p.")):
                result.variant = table_like_fields["variant"]
    if result.zygosity is None and table_like_fields["zygosity"]:
        result.zygosity = table_like_fields["zygosity"]
    if result.interpretation is None and table_like_fields["interpretation"]:
        result.interpretation = table_like_fields["interpretation"]

    return result


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
