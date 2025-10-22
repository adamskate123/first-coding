"""Tests for the genetics report parser utilities."""

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

try:  # pragma: no cover - Pillow is optional for the test environment
    from PIL import Image
except ImportError:  # pragma: no cover - handled via test skips when Pillow is absent
    Image = None  # type: ignore[assignment]

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
    assert result.variant_normalization_succeeded in {True, False}
    assert "variant_normalization_succeeded" in result.to_dict()
    assert result.zygosity == "Heterozygous"
    assert result.interpretation == "Pathogenic variant detected"


def test_extract_from_image_uses_ocr_result(monkeypatch, tmp_path: Path) -> None:
    image_path = tmp_path / "report.png"
    image_path.write_bytes(b"")

    def fake_perform_ocr(
        path: Path,
        *,
        include_layout: bool = False,
        config: str | None = None,
        lang: str | None = None,
    ) -> grp.OCRResult:
        assert include_layout is False
        assert config is None
        assert lang is None
        return grp.OCRResult(
            text="Patient Name: John Smith\nGene: BRCA1\nVariant: c.68_69delAG",
            layout=None,
        )

    monkeypatch.setattr(grp, "perform_ocr", fake_perform_ocr)

    result = grp.extract_from_image(image_path)

    assert result.patient == "John Smith"
    assert result.gene == "BRCA1"
    assert result.variant == "c.68_69delAG"
    assert result.variant_normalization_succeeded in {True, False}


def test_extract_from_image_threads_config_and_lang(monkeypatch, tmp_path: Path) -> None:
    image_path = tmp_path / "report.png"
    image_path.write_bytes(b"")

    captured: dict[str, str | None] = {}

    def fake_perform_ocr(
        path: Path,
        *,
        include_layout: bool = False,
        config: str | None = None,
        lang: str | None = None,
    ) -> grp.OCRResult:
        captured["path"] = str(path)
        captured["config"] = config
        captured["lang"] = lang
        return grp.OCRResult(text="Variant: c.68_69delAG", layout=None)

    monkeypatch.setattr(grp, "perform_ocr", fake_perform_ocr)

    result = grp.extract_from_image(
        image_path, ocr_config="--psm 6", ocr_lang="eng+spa"
    )

    assert result.variant == "c.68_69delAG"
    assert captured["path"] == str(image_path)
    assert captured["config"] == "--psm 6"
    assert captured["lang"] == "eng+spa"


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


def test_perform_ocr_forwards_config_and_lang(monkeypatch, tmp_path: Path) -> None:
    image_path = tmp_path / "report.png"
    image_path.write_bytes(b"")

    class DummyImage:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb) -> bool:
            return False

    monkeypatch.setattr(grp, "Image", SimpleNamespace(open=lambda path: DummyImage()))

    captured: dict[str, dict[str, object]] = {}

    def fake_image_to_string(image, **kwargs):
        captured["string"] = kwargs
        return "foo"

    def fake_image_to_data(image, **kwargs):
        captured["data"] = kwargs
        return {
            "text": ["foo"],
            "left": [1],
            "top": [2],
            "width": [3],
            "height": [4],
            "conf": [95],
            "page_num": [1],
            "block_num": [1],
            "par_num": [1],
            "line_num": [1],
            "word_num": [1],
        }

    pytesseract_stub = SimpleNamespace(
        Output=SimpleNamespace(DICT="DICT"),
        image_to_string=fake_image_to_string,
        image_to_data=fake_image_to_data,
    )

    monkeypatch.setattr(grp, "pytesseract", pytesseract_stub)

    result = grp.perform_ocr(
        image_path, include_layout=True, config="--psm 6", lang="eng+spa"
    )

    assert captured["string"] == {"config": "--psm 6", "lang": "eng+spa"}
    assert captured["data"]["output_type"] == pytesseract_stub.Output.DICT
    assert captured["data"]["config"] == "--psm 6"
    assert captured["data"]["lang"] == "eng+spa"
    assert result.text == "foo"
    assert result.layout is not None
    assert len(result.layout) == 1
    assert result.layout[0].text == "foo"


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
    assert result.variant_normalization_succeeded in {True, False}
    assert result.zygosity == "Heterozygous"
    assert result.interpretation == "Pathogenic"


def test_fallback_preserves_likely_pathogenic_interpretation() -> None:
    sample_text = (
        "Patient Jane Doe\n"
        "BRCA1 NM_007294.3 c.5266dupC Likely pathogenic Heterozygous\n"
    )

    result = grp.parse_report_text(sample_text)

    assert result.interpretation == "Likely pathogenic"


def test_fallback_preserves_single_letter_protein_variants() -> None:
    # Some reports list both cDNA and protein descriptions on the same line. When
    # the protein change uses single-letter HGVS notation we must retain it
    # during fallback parsing.
    sample_text = "FGF12 p.G112S c.334 G>A\n"

    fallback = grp._extract_table_like_fields(sample_text)

    assert fallback["gene"] == "FGF12"
    assert fallback["variant"] == "p.G112S"


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
    assert result.variant_normalization_succeeded in {True, False}


def test_parse_report_text_preserves_variant_with_internal_spaces() -> None:
    sample_text = "Variant: FGF12: c.334 G>A, p.G112S\n"

    result = grp.parse_report_text(sample_text)

    assert result.variant == "c.334G>A"
    assert result.variant_normalization_succeeded in {True, False}


def test_parse_report_text_handles_uppercase_variant_prefixes() -> None:
    sample_text = "Variant: C.1521_1523delCTT (P.Phe508del)\n"

    result = grp.parse_report_text(sample_text)

    assert result.variant == "c.1521_1523delCTT"
    assert result.variant_normalization_succeeded in {True, False, None}


def test_parse_report_text_uses_remote_validation_for_multiple_candidates(monkeypatch) -> None:
    sample_text = "Variant: c.123A>T p.Gly41Val\n"

    calls = []

    def _fake_validate(variant: str, transcript=None, timeout=10.0):
        calls.append(variant)
        if variant.startswith("p."):
            return {"valid": True, "normalized": "p.Gly41Val", "messages": [], "response": {}}
        return {"valid": False, "normalized": None, "messages": ["invalid"], "response": {}}

    monkeypatch.setattr(grp, "_validate_variant_with_mutalyzer", _fake_validate)

    result = grp.parse_report_text(sample_text, enable_variant_validation=True)

    assert calls == ["c.123A>T", "p.Gly41Val"]
    assert result.variant == "p.Gly41Val"
    assert result.variant_normalization_succeeded in {True, False}


def test_parse_report_text_logs_when_validation_fails(monkeypatch, caplog) -> None:
    sample_text = "Variant: uncertain deletion\n"

    def _fake_validate(variant: str, transcript=None, timeout=10.0):
        return {"valid": False, "normalized": None, "messages": ["not recognized"], "response": {}}

    monkeypatch.setattr(grp, "_validate_variant_with_mutalyzer", _fake_validate)

    with caplog.at_level("WARNING"):
        result = grp.parse_report_text(sample_text, enable_variant_validation=True)

    assert result.variant == "uncertain deletion"
    assert result.variant_normalization_succeeded in {True, False}
    assert "Unable to validate variant candidates" in caplog.text


def test_parse_report_text_env_flag_enables_validation(monkeypatch) -> None:
    sample_text = "Variant: c.123A>T p.Gly41Val\n"

    calls = []

    def _fake_validate(variant: str, transcript=None, timeout=10.0):
        calls.append((variant, transcript))
        if variant.startswith("p."):
            return {"valid": True, "normalized": "p.Gly41Val", "messages": [], "response": {}}
        return {"valid": False, "normalized": None, "messages": ["invalid"], "response": {}}

    monkeypatch.setattr(grp, "_validate_variant_with_mutalyzer", _fake_validate)
    monkeypatch.setenv("GENETICS_REPORT_VALIDATE_VARIANTS", "1")

    result = grp.parse_report_text(sample_text)

    assert calls == [("c.123A>T", None), ("p.Gly41Val", None)]
    assert result.variant == "p.Gly41Val"
    assert result.variant_normalization_succeeded in {True, False}


def test_cli_expands_user_path(monkeypatch, tmp_path, capsys) -> None:
    home_dir = tmp_path / "home"
    home_dir.mkdir()
    image_path = home_dir / "report.png"
    image_path.write_bytes(b"")

    monkeypatch.setenv("HOME", str(home_dir))

    expected_result = grp.ExtractionResult(patient="Linus")

    def _fake_extract(
        path: Path,
        *,
        enable_variant_validation=None,
        ocr_config: str | None = None,
        ocr_lang: str | None = None,
    ):
        assert path == image_path
        assert ocr_config is None
        assert ocr_lang is None
        return expected_result

    monkeypatch.setattr(grp, "extract_from_image", _fake_extract)
    monkeypatch.setattr(sys, "argv", ["genetics_report_parser.py", "~/report.png"])

    grp.main()

    captured = capsys.readouterr()
    assert "Patient: Linus" in captured.out
