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
import logging
import os
import re
import time
import urllib.error
import urllib.request
import urllib.parse
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple, Union

try:  # pragma: no cover - import availability depends on environment
    from PIL import Image, ImageFilter, ImageOps  # type: ignore
except ImportError:  # pragma: no cover - handled lazily in _ensure_ocr_dependencies
    Image = None  # type: ignore[assignment]
    ImageFilter = None  # type: ignore[assignment]
    ImageOps = None  # type: ignore[assignment]

try:  # pragma: no cover - import availability depends on environment
    import pytesseract  # type: ignore
except ImportError:  # pragma: no cover - handled lazily in _ensure_ocr_dependencies
    pytesseract = None  # type: ignore[assignment]

try:  # pragma: no cover - optional dependency for fuzzy label matching
    from rapidfuzz import process as rapidfuzz_process
except ImportError:  # pragma: no cover - fuzzy matching remains optional
    rapidfuzz_process = None  # type: ignore[assignment]

try:  # pragma: no cover - optional dependency for HGVS parsing
    from hgvs.parser import Parser as HgvsParser  # type: ignore
except ImportError:  # pragma: no cover - normalization remains optional
    HgvsParser = None  # type: ignore[assignment]
    _HGVS_PARSER = None
else:  # pragma: no cover - simple instantiation
    _HGVS_PARSER = HgvsParser()


_logger = logging.getLogger(__name__)


_MUTALYZER_RATE_LIMIT_SECONDS = 1.0
_LAST_MUTALYZER_REQUEST: float = 0.0
_MUTALYZER_API_URL = "https://mutalyzer.nl/api/v2/normalize"
_VALIDATION_ENV_VAR = "GENETICS_REPORT_VALIDATE_VARIANTS"


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
    variant_normalization_succeeded: Optional[bool] = None
    zygosity: Optional[str] = None
    interpretation: Optional[str] = None

    def to_dict(self) -> Dict[str, Optional[Union[str, bool]]]:
        return {
            "patient": self.patient,
            "date_of_birth": self.date_of_birth,
            "medical_record_number": self.medical_record_number,
            "gene": self.gene,
            "transcript": self.transcript,
            "variant": self.variant,
            "variant_normalization_succeeded": self.variant_normalization_succeeded,
            "zygosity": self.zygosity,
            "interpretation": self.interpretation,
        }


@dataclass
class OCRWord:
    """Lightweight representation of a recognised OCR word and its bounds."""

    text: str
    left: int
    top: int
    width: int
    height: int
    conf: float
    page_num: int
    block_num: int
    par_num: int
    line_num: int
    word_num: int

    @property
    def right(self) -> int:
        return self.left + self.width

    @property
    def bottom(self) -> int:
        return self.top + self.height


@dataclass
class OCRResult:
    """Container for OCR output that includes optional layout metadata."""

    text: str
    layout: Optional[List[OCRWord]] = None


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


def _load_gene_symbols() -> Set[str]:
    """Load a lightweight list of approved gene symbols."""

    data_path = Path(__file__).resolve().parent / "data" / "hgnc_symbols.txt"
    try:
        lines = data_path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:  # pragma: no cover - defensive fallback
        return set()

    symbols = {line.strip() for line in lines if line.strip() and not line.startswith("#")}
    return symbols


def _load_vocabulary_file(filename: str, *, lowercase: bool = False) -> Set[str]:
    """Load a simple newline-delimited vocabulary from the data directory."""

    data_path = Path(__file__).resolve().parent / "data" / filename
    try:
        lines = data_path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:  # pragma: no cover - defensive fallback
        return set()

    cleaned: Set[str] = set()
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if lowercase:
            stripped = stripped.lower()
        cleaned.add(stripped)
    return cleaned


_GENE_SYMBOLS = _load_gene_symbols()
_AMINO_ACID_CODES = _load_vocabulary_file("amino_acids.txt")
_PROHIBITED_VARIANT_SUBSTRINGS = _load_vocabulary_file(
    "prohibited_variant_tokens.txt", lowercase=True
)


def _is_valid_variant_candidate(candidate: str) -> bool:
    """Validate heuristic variant candidates against curated vocabularies."""

    if not candidate:
        return False

    normalized = candidate.strip()
    lowered = normalized.lower()

    for forbidden in _PROHIBITED_VARIANT_SUBSTRINGS:
        if forbidden in lowered:
            return False

    if normalized.startswith(("c.", "C.")):
        return True

    if normalized.startswith(("p.", "P.")):
        amino_acid_tokens = re.findall(r"([A-Z][a-z]{2})", normalized)
        if amino_acid_tokens:
            return all(token in _AMINO_ACID_CODES for token in amino_acid_tokens)

        # Fall back to single-letter HGVS substitutions like ``p.G112S``. The
        # regex enforces the canonical structure (one amino-acid code, digits,
        # one amino-acid code or ``*`` for stop) so that free-form phrases are
        # still rejected.
        single_letter_match = re.match(r"^p\.([A-Z])([0-9]+)([A-Z*])$", normalized)
        if single_letter_match:
            reference, _, alternate = single_letter_match.groups()
            valid_single_letter_codes = {
                "A",
                "C",
                "D",
                "E",
                "F",
                "G",
                "H",
                "I",
                "K",
                "L",
                "M",
                "N",
                "P",
                "Q",
                "R",
                "S",
                "T",
                "V",
                "W",
                "Y",
                "X",
                "U",
                "O",
            }
            if alternate == "*":
                return reference in valid_single_letter_codes
            return reference in valid_single_letter_codes and alternate in valid_single_letter_codes
        return False

    return False


def _is_plausible_gene_symbol(candidate: str) -> bool:
    """Return True if the candidate looks like a genuine gene symbol."""

    if candidate in _GENE_SYMBOLS:
        return True

    # Fall back to a strict heuristic: allow short, all-uppercase tokens that
    # include at least one digit (e.g. PIK3CA) when the curated list is missing
    # an entry. This keeps obviously generic words such as LIKELY or PATHOGENIC
    # from being treated as genes.
    return (
        candidate.isalnum()
        and candidate.isupper()
        and 3 <= len(candidate) <= 6
        and any(ch.isdigit() for ch in candidate)
    )


def _extract_table_like_fields(text: str) -> Dict[str, Optional[str]]:
    """Fallback heuristics for low quality reports with missing headings."""

    gene_pattern = re.compile(r"\b([A-Z0-9]{2,})\b")
    transcript_pattern = re.compile(r"\b((?:NM|NC|LRG|ENST)[0-9._]+)\b", re.IGNORECASE)
    base_token = r"[A-Za-z0-9_>+\-/]+"
    spaced_tokens = rf"(?:\s+(?![cCpP]\.){base_token})*"
    variant_pattern = re.compile(
        rf"""
        (
            [cC]\.\s*{base_token}{spaced_tokens}
            |
            [pP]\.\s*
            (?:
                \(\s*{base_token}{spaced_tokens}\)
                |
                {base_token}{spaced_tokens}
            )
        )
        """,
        re.VERBOSE,
    )
    zygosity_pattern = re.compile(r"\b(Heterozygous|Homozygous|Hemizygous)\b", re.IGNORECASE)

    # Evaluate longer interpretation phrases before their substrings so that
    # specific values such as "likely pathogenic" are not accidentally
    # downgraded to "pathogenic".
    interpretation_keywords = [
        ("variant of uncertain significance", "Variant of Uncertain Significance"),
        ("likely pathogenic", "Likely pathogenic"),
        ("disease-causing mutation", "Pathogenic"),
        ("pathogenic", "Pathogenic"),
        ("uncertain significance", "Variant of Uncertain Significance"),
        ("vus", "Variant of Uncertain Significance"),
        ("likely benign", "Likely benign"),
        ("benign", "Benign"),
        ("risk factor", "Risk factor"),
    ]

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

        candidate_variant = _canonicalize_variant_prefix(
            re.sub(r"\s+", "", variant_match.group(1))
        )
        fallback_variant = (
            candidate_variant if _is_valid_variant_candidate(candidate_variant) else None
        )
        fallback_gene: Optional[str] = None
        fallback_transcript: Optional[str] = None
        fallback_zygosity: Optional[str] = None
        fallback_interpretation: Optional[str] = None

        # Look backward in the same line for a gene symbol.
        prior_text = line[: variant_match.start()]
        prior_gene_matches = list(gene_pattern.finditer(prior_text))
        for gene_match in reversed(prior_gene_matches):
            candidate = gene_match.group(1)
            if _is_plausible_gene_symbol(candidate):
                fallback_gene = candidate
                break

        # Gene symbols can also appear on the preceding lines when reports render
        # tables with column headers and values on separate rows (e.g. "Gene"
        # on one line followed by "BRCA1" on the next). Scan a small window of
        # lines above the variant entry for the nearest plausible symbol.
        if fallback_gene is None:
            for prev_idx in range(idx - 1, max(idx - 6, -1), -1):
                prev_line = lines[prev_idx]

                # Avoid accidentally pulling the gene from an earlier variant
                # entry when reports list multiple rows back-to-back.
                if variant_pattern.search(prev_line):
                    break

                for gene_match in reversed(list(gene_pattern.finditer(prev_line))):
                    candidate = gene_match.group(1)
                    if _is_plausible_gene_symbol(candidate):
                        fallback_gene = candidate
                        break

                if fallback_gene is not None:
                    break

        # Transcript can appear either before or after the variant token.
        transcript_match = transcript_pattern.search(line)
        if transcript_match:
            fallback_transcript = transcript_match.group(1)

        zygosity_match = zygosity_pattern.search(line)
        if zygosity_match:
            fallback_zygosity = zygosity_match.group(1).title()

        lowered_line = line.lower()
        for keyword, canonical in interpretation_keywords:
            if keyword in lowered_line:
                fallback_interpretation = canonical
                break

        # Interpretation is sometimes wrapped to the following line.
        if fallback_interpretation is None and idx + 1 < len(lines):
            next_line_lower = lines[idx + 1].lower()
            for keyword, canonical in interpretation_keywords:
                if keyword in next_line_lower:
                    fallback_interpretation = canonical
                    break
            if (
                fallback_interpretation is None
                and "classification" in next_line_lower
                and idx + 2 < len(lines)
            ):
                following_line_lower = lines[idx + 2].lower()
                for keyword, canonical in interpretation_keywords:
                    if keyword in following_line_lower:
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


def _canonicalize_variant_prefix(token: str) -> str:
    """Return *token* with HGVS prefix letters normalised to lowercase."""

    match = re.search(r"([cCpP])\.", token)
    if not match:
        return token

    prefix_index = match.start(1)
    return token[:prefix_index] + token[prefix_index].lower() + token[prefix_index + 1 :]


def _extract_variant_tokens(value: str) -> List[str]:
    """Return individual HGVS-like tokens from a combined variant string."""

    base_token = r"[A-Za-z0-9_>+\-/]+"
    spaced_tokens = rf"(?:\s+(?![cCpP]\.){base_token})*"
    variant_pattern = re.compile(
        rf"""
        (
            NM_[0-9.]+:\s*[cCpP]\.\s*{base_token}{spaced_tokens}
            |
            [cC]\.\s*{base_token}{spaced_tokens}
            |
            [pP]\.\s*
            (?:
                \(\s*{base_token}{spaced_tokens}\)
                |
                {base_token}{spaced_tokens}
            )
        )
        """,
        re.VERBOSE,
    )
    tokens = [
        _canonicalize_variant_prefix(re.sub(r"\s+", "", match.group(1)))
        for match in variant_pattern.finditer(value)
    ]
    if not tokens and value.strip():
        tokens.append(value.strip())
    return tokens


def _normalize_variant(value: str) -> Optional[Tuple[Optional[str], str]]:
    """Normalize an HGVS-like variant string using the optional HGVS parser."""

    if not value or _HGVS_PARSER is None:
        return None

    candidate = value.strip()
    if not candidate:
        return None

    try:
        parsed = _HGVS_PARSER.parse_hgvs_variant(candidate)
    except Exception:  # pragma: no cover - depends on third-party parser
        return None

    transcript = getattr(parsed, "ac", None)
    posedit = getattr(parsed, "posedit", None)
    if posedit is None:
        return None

    variant_text = str(posedit)
    if not variant_text:
        return None

    return transcript or None, variant_text


def _parse_bool_env_flag(value: Optional[str]) -> Optional[bool]:
    """Convert a string environment variable to a boolean flag."""

    if value is None:
        return None
    lowered = value.strip().lower()
    if lowered in {"1", "true", "yes", "on"}:
        return True
    if lowered in {"0", "false", "no", "off"}:
        return False
    return None


def _prepare_variant_for_mutalyzer(
    candidate: str, transcript: Optional[str]
) -> Optional[Tuple[str, Optional[str]]]:
    """Return a cleaned variant/transcript pair suitable for Mutalyzer."""

    if not candidate:
        return None

    normalized_candidate = candidate.strip()
    if not normalized_candidate:
        return None

    normalized_candidate = _canonicalize_variant_prefix(normalized_candidate)
    if not _is_valid_variant_candidate(normalized_candidate):
        return None

    cleaned_transcript: Optional[str] = None
    if transcript:
        cleaned_transcript = re.sub(r"\s+", "", transcript.strip())
        if not cleaned_transcript:
            cleaned_transcript = None

    if cleaned_transcript and ":" not in normalized_candidate and not normalized_candidate.startswith(
        cleaned_transcript
    ):
        normalized_candidate = f"{cleaned_transcript}:{normalized_candidate}"

    return normalized_candidate, cleaned_transcript


def _validate_variant_with_mutalyzer(
    variant: str, transcript: Optional[str] = None, timeout: float = 10.0
) -> Dict[str, Any]:
    """Validate a candidate variant using the Mutalyzer API.

    The function respects a minimal interval between requests to avoid exceeding
    rate limits. Network or API failures are returned as structured responses
    rather than raising exceptions so callers can decide how to proceed.
    """

    global _LAST_MUTALYZER_REQUEST

    query_params = {"variant": variant}
    if transcript:
        query_params["transcript"] = transcript

    request_url = _MUTALYZER_API_URL
    if query_params:
        request_url = f"{_MUTALYZER_API_URL}?{urllib.parse.urlencode(query_params)}"
    wait_time = _MUTALYZER_RATE_LIMIT_SECONDS - (time.time() - _LAST_MUTALYZER_REQUEST)
    if wait_time > 0:
        time.sleep(wait_time)

    request = urllib.request.Request(
        request_url,
        headers={"Accept": "application/json"},
    )

    def _error_response(message: str) -> Dict[str, Any]:
        return {"valid": False, "normalized": None, "messages": [message], "response": {}}

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            _LAST_MUTALYZER_REQUEST = time.time()
            content = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        _LAST_MUTALYZER_REQUEST = time.time()
        try:
            detail = exc.read().decode("utf-8")
        except Exception:  # pragma: no cover - defensive fallback
            detail = ""
        message = f"HTTP {exc.code} from Mutalyzer: {detail or exc.reason}"
        return _error_response(message)
    except urllib.error.URLError as exc:
        _LAST_MUTALYZER_REQUEST = time.time()
        message = f"Network error contacting Mutalyzer: {exc.reason}"
        return _error_response(message)

    try:
        response_data = json.loads(content)
    except json.JSONDecodeError:
        return _error_response("Mutalyzer returned invalid JSON")

    normalized: Optional[str] = None
    if isinstance(response_data, dict):
        candidates: List[str] = []
        for key in (
            "normalized_description",
            "normalized_variant",
            "normalized",
            "description",
        ):
            value = response_data.get(key)
            if isinstance(value, str):
                candidates.append(value)
            elif isinstance(value, list):
                for item in value:
                    if isinstance(item, str):
                        candidates.append(item)
                    elif isinstance(item, dict):
                        description = item.get("description")
                        if isinstance(description, str):
                            candidates.append(description)
        if candidates:
            normalized = candidates[0]

    valid = bool(normalized or (isinstance(response_data, dict) and response_data.get("valid")))
    messages: List[str] = []
    for key in ("warnings", "errors", "messages"):
        value = response_data.get(key) if isinstance(response_data, dict) else None
        if isinstance(value, list):
            messages.extend(str(item) for item in value)
        elif isinstance(value, str):
            messages.append(value)

    return {
        "valid": valid,
        "normalized": normalized,
        "messages": messages,
        "response": response_data,
    }


def parse_report_text(
    text: str, *, enable_variant_validation: Optional[bool] = None
) -> ExtractionResult:
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
            r"(?P<value>[cC]\.[A-Za-z0-9_>+\-/]+|[pP]\.(?:\([A-Za-z0-9_>+\-/]+\)|[A-Za-z0-9_>+\-/]+))",
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

    variant_candidates: List[str] = []

    def _register_candidates(raw_value: Optional[str]) -> None:
        if not raw_value:
            return
        for token in _extract_variant_tokens(raw_value):
            if token not in variant_candidates:
                variant_candidates.append(token)

    _register_candidates(variant)

    table_variant = table_like_fields["variant"]
    if table_variant:
        if result.variant is None:
            result.variant = table_variant
        else:
            current_tokens = _extract_variant_tokens(result.variant)
            candidate_tokens = _extract_variant_tokens(table_variant)
            if current_tokens and candidate_tokens:
                current_primary = current_tokens[0].lower()
                candidate_primary = candidate_tokens[0].lower()
                if candidate_primary.startswith(("c.", "p.")) and not current_primary.startswith(("c.", "p.")):
                    result.variant = candidate_tokens[0]
        _register_candidates(table_variant)

    _register_candidates(result.variant)

    selected_variant: Optional[str] = None
    if result.variant:
        selected_tokens = _extract_variant_tokens(result.variant)
        if selected_tokens:
            selected_variant = selected_tokens[0]
        else:
            selected_variant = result.variant.strip()
    elif variant_candidates:
        selected_variant = variant_candidates[0]

    result.variant = selected_variant

    normalization_attempted = False
    normalization_succeeded = False

    def _normalize_from_value(raw_value: Optional[str]) -> Optional[Tuple[Optional[str], str]]:
        nonlocal normalization_attempted

        if not raw_value:
            return None

        tokens = _extract_variant_tokens(raw_value)
        if not tokens:
            stripped = raw_value.strip()
            if not stripped:
                return None
            tokens = [stripped]

        if _HGVS_PARSER is None:
            normalization_attempted = True
            return None

        normalization_attempted = True
        for token in tokens:
            normalized_value = _normalize_variant(token)
            if normalized_value:
                return normalized_value
        return None

    normalized_result = _normalize_from_value(variant)
    if normalized_result is None and table_variant and table_variant != variant:
        normalized_result = _normalize_from_value(table_variant)
    if normalized_result is None and selected_variant:
        normalized_result = _normalize_from_value(selected_variant)

    if normalized_result:
        normalization_succeeded = True
        normalized_transcript, normalized_variant = normalized_result
        if normalized_transcript:
            result.transcript = normalized_transcript
        result.variant = normalized_variant

    env_setting = _parse_bool_env_flag(os.getenv(_VALIDATION_ENV_VAR))
    if enable_variant_validation is None:
        enable_variant_validation = env_setting if env_setting is not None else False

    should_validate = (
        bool(enable_variant_validation)
        and variant_candidates
        and (len(variant_candidates) > 1 or (normalization_attempted and not normalization_succeeded))
    )

    if should_validate:
        validation_messages: List[str] = []
        skipped_candidates: List[str] = []
        for candidate in variant_candidates:
            prepared = _prepare_variant_for_mutalyzer(candidate, result.transcript)
            if prepared is None:
                skipped_candidates.append(candidate)
                continue

            prepared_candidate, prepared_transcript = prepared
            validation = _validate_variant_with_mutalyzer(
                prepared_candidate, transcript=prepared_transcript
            )
            messages = validation.get("messages")
            if isinstance(messages, list):
                validation_messages.extend(str(msg) for msg in messages)
            if validation.get("valid"):
                normalized_candidate = validation.get("normalized")
                candidate_value = prepared_candidate
                if isinstance(normalized_candidate, str) and normalized_candidate:
                    candidate_value = normalized_candidate

                parsed_candidate: Optional[Tuple[Optional[str], str]] = None
                if _HGVS_PARSER is not None:
                    normalization_attempted = True
                    parsed_candidate = _normalize_variant(candidate_value)
                    if not parsed_candidate and candidate_value != candidate:
                        parsed_candidate = _normalize_variant(candidate)

                if parsed_candidate:
                    normalization_succeeded = True
                    normalized_transcript, normalized_variant = parsed_candidate
                    if normalized_transcript:
                        result.transcript = normalized_transcript
                    result.variant = normalized_variant
                else:
                    result.variant = candidate_value
                break
        else:
            if validation_messages:
                detail_message = "; ".join(validation_messages)
                if skipped_candidates:
                    detail_message = (
                        f"{detail_message} | Skipped non-HGVS candidates: {skipped_candidates}"
                    )
                _logger.warning(
                    "Unable to validate variant candidates %s: %s",
                    variant_candidates,
                    detail_message,
                )
            else:
                details = []
                if skipped_candidates:
                    details.append(
                        f"Skipped non-HGVS candidates: {skipped_candidates}"
                    )
                if details:
                    _logger.warning(
                        "Unable to validate variant candidates %s: %s",
                        variant_candidates,
                        " | ".join(details),
                    )
                else:
                    _logger.warning(
                        "Unable to validate variant candidates %s", variant_candidates
                    )

    if normalization_succeeded:
        result.variant_normalization_succeeded = True
    elif normalization_attempted or selected_variant:
        result.variant_normalization_succeeded = False
    else:
        result.variant_normalization_succeeded = None
    if result.zygosity is None and table_like_fields["zygosity"]:
        result.zygosity = table_like_fields["zygosity"]
    if result.interpretation is None and table_like_fields["interpretation"]:
        result.interpretation = table_like_fields["interpretation"]

    return result


def perform_ocr(
    image_path: Path,
    *,
    include_layout: bool = False,
    config: Optional[str] = None,
    lang: Optional[str] = None,
) -> OCRResult:
    """Run OCR on *image_path* and optionally capture layout metadata."""

    _ensure_ocr_dependencies()

    layout_words: Optional[List[OCRWord]] = None

    with Image.open(image_path) as image:
        ocr_kwargs: dict[str, Any] = {}
        if config is not None:
            ocr_kwargs["config"] = config
        if lang is not None:
            ocr_kwargs["lang"] = lang

        text = pytesseract.image_to_string(image, **ocr_kwargs)

        if include_layout:
            try:
                data_kwargs = {"output_type": pytesseract.Output.DICT, **ocr_kwargs}
                output_dict = pytesseract.image_to_data(image, **data_kwargs)
            except AttributeError:  # pragma: no cover - safety net for unexpected pytesseract builds
                layout_words = None
            else:
                layout_words = []
                entries = len(output_dict.get("text", []))

                def _int_from(values: Sequence[Any], index: int, default: int = 0) -> int:
                    try:
                        return int(values[index])
                    except (IndexError, TypeError, ValueError):
                        return default

                def _float_from(values: Sequence[Any], index: int, default: float = 0.0) -> float:
                    try:
                        return float(values[index])
                    except (IndexError, TypeError, ValueError):
                        return default

                texts = output_dict.get("text", [])
                lefts = output_dict.get("left", [])
                tops = output_dict.get("top", [])
                widths = output_dict.get("width", [])
                heights = output_dict.get("height", [])
                confs = output_dict.get("conf", [])
                page_numbers = output_dict.get("page_num", [])
                block_numbers = output_dict.get("block_num", [])
                paragraph_numbers = output_dict.get("par_num", [])
                line_numbers = output_dict.get("line_num", [])
                word_numbers = output_dict.get("word_num", [])

                for idx in range(entries):
                    raw_text = texts[idx]
                    if not raw_text or not raw_text.strip():
                        continue

                    layout_words.append(
                        OCRWord(
                            text=str(raw_text).strip(),
                            left=_int_from(lefts, idx),
                            top=_int_from(tops, idx),
                            width=_int_from(widths, idx),
                            height=_int_from(heights, idx),
                            conf=_float_from(confs, idx),
                            page_num=_int_from(page_numbers, idx, default=1),
                            block_num=_int_from(block_numbers, idx),
                            par_num=_int_from(paragraph_numbers, idx),
                            line_num=_int_from(line_numbers, idx),
                            word_num=_int_from(word_numbers, idx),
                        )
                    )

    return OCRResult(text=text, layout=layout_words)

def extract_from_image(
    image_path: Path,
    *,
    enable_variant_validation: Optional[bool] = None,
    ocr_config: Optional[str] = None,
    ocr_lang: Optional[str] = None,
) -> ExtractionResult:
    """Extract key fields from a genetics report screenshot."""

    ocr_result = perform_ocr(image_path, config=ocr_config, lang=ocr_lang)
    return parse_report_text(ocr_result.text, enable_variant_validation=enable_variant_validation)


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
    parser.add_argument(
        "--validate-variants",
        action="store_true",
        help=(
            "Consult Mutalyzer to confirm ambiguous variant candidates. "
            "Requires internet access and is disabled by default."
        ),
    )
    parser.add_argument(
        "--tesseract-config",
        nargs="+",
        help=(
            "Additional configuration passed to pytesseract, for example "
            "`--tesseract-config --psm 6`."
        ),
    )
    parser.add_argument(
        "--tesseract-lang",
        help=(
            "Language(s) passed to pytesseract (e.g. `eng+spa` for English and Spanish)."
        ),
    )
    args = parser.parse_args()

    image_path = args.image.expanduser()

    if not image_path.exists():
        raise SystemExit(f"File not found: {image_path}")

    enable_validation = True if args.validate_variants else None
    tesseract_config = " ".join(args.tesseract_config) if args.tesseract_config else None
    result = extract_from_image(
        image_path,
        enable_variant_validation=enable_validation,
        ocr_config=tesseract_config,
        ocr_lang=args.tesseract_lang,
    )

    if args.json:
        print(json.dumps(result.to_dict(), indent=2))
    else:
        for field, value in result.to_dict().items():
            print(f"{field.replace('_', ' ').title()}: {value or 'Not found'}")


if __name__ == "__main__":  # pragma: no cover - CLI entrypoint
    main()
