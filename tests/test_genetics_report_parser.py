"""Tests for the genetics report parser utilities."""

from pathlib import Path
import sys

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import genetics_report_parser as grp


def test_parse_report_text_extracts_expected_fields() -> None:
    sample_text = (
        "Patient: Jane Doe\n"
        "Date of Birth: 1990-05-17\n"
        "MRN: A12345\n"
        "Gene: CFTR\n"
        "Transcript: NM_000492.3\n"
        "Variant: c.1521_1523delCTT (p.Phe508del)\n"
        "Zygosity: Heterozygous\n"
        "Interpretation: Pathogenic variant detected."
    )

    result = grp.parse_report_text(sample_text)

    assert result.patient == "Jane Doe"
    assert result.date_of_birth == "1990-05-17"
    assert result.medical_record_number == "A12345"
    assert result.gene == "CFTR"
    assert result.transcript == "NM_000492.3"
    assert result.variant.startswith("c.1521_1523delCTT")
    assert result.zygosity == "Heterozygous"
    assert result.interpretation == "Pathogenic variant detected"


def test_extract_from_image_uses_ocr_result(monkeypatch, tmp_path: Path) -> None:
    image_path = tmp_path / "report.png"
    image_path.write_bytes(b"")

    monkeypatch.setattr(
        grp,
        "perform_ocr",
        lambda path: "Patient Name: John Smith\nGene: BRCA1\nVariant: c.68_69delAG",
    )

    result = grp.extract_from_image(image_path)

    assert result.patient == "John Smith"
    assert result.gene == "BRCA1"
    assert result.variant == "c.68_69delAG"


def test_perform_ocr_requires_dependencies(monkeypatch, tmp_path: Path) -> None:
    image_path = tmp_path / "report.png"
    image_path.write_bytes(b"")

    monkeypatch.setattr(grp, "Image", None)
    monkeypatch.setattr(grp, "pytesseract", None)

    try:
        grp.perform_ocr(image_path)
    except SystemExit as exc:
        assert "Missing dependencies" in str(exc)
    else:  # pragma: no cover - ensure the SystemExit is raised
        raise AssertionError("Expected SystemExit when OCR dependencies are missing")


def test_parse_report_text_handles_table_rows_without_headings() -> None:
    sample_text = (
        "Patient Jane Doe\n"
        "BRCA1 NM_007294.3 c.5266dupC Pathogenic Heterozygous\n"
        "Follow up recommended\n"
    )

    result = grp.parse_report_text(sample_text)

    assert result.gene == "BRCA1"
    assert result.transcript == "NM_007294.3"
    assert result.variant == "c.5266dupC"
    assert result.zygosity == "Heterozygous"
    assert result.interpretation == "Pathogenic"


def test_fallback_gene_detection_skips_generic_tokens() -> None:
    sample_text = (
        "LIKELY PATHOGENIC c.68_69delAG HETEROZYGOUS\n"
        "BRCA1 c.5266dupC Pathogenic Heterozygous\n"
    )

    result = grp.parse_report_text(sample_text)

    assert result.gene == "BRCA1"
    assert result.variant == "c.68_69delAG"


def test_parse_report_text_handles_parenthesized_protein_variant_only() -> None:
    sample_text = "p.(Gly12Asp)\n"

    result = grp.parse_report_text(sample_text)

    assert result.variant == "p.(Gly12Asp)"
