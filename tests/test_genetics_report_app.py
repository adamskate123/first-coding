from __future__ import annotations

import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import genetics_report_app as app
from genetics_report_parser import ExtractionResult


def test_cli_prints_results(tmp_path, monkeypatch, capsys):
    image_path = tmp_path / "report.png"
    image_path.write_bytes(b"")

    result = ExtractionResult(patient="Ada", gene="BRCA1")

    monkeypatch.setattr(app, "extract_from_image", lambda path, **kwargs: result)

    exit_code = app.main([str(image_path)])

    assert exit_code == 0
    captured = capsys.readouterr()
    assert "Patient: Ada" in captured.out
    assert "Gene: BRCA1" in captured.out
    assert captured.err == ""


def test_cli_json_output(tmp_path, monkeypatch, capsys):
    image_path = tmp_path / "report.png"
    image_path.write_bytes(b"")

    result = ExtractionResult(patient="Grace", gene="CFTR")

    monkeypatch.setattr(app, "extract_from_image", lambda path, **kwargs: result)

    exit_code = app.main(["--json", str(image_path)])

    assert exit_code == 0
    captured = capsys.readouterr()
    assert captured.err == ""
    assert "\n" in captured.out  # pretty-printed JSON contains newlines
    assert "Grace" in captured.out
    assert "CFTR" in captured.out


def test_cli_missing_file(tmp_path, capsys):
    missing_path = tmp_path / "missing.png"

    exit_code = app.main([str(missing_path)])

    assert exit_code == 1
    captured = capsys.readouterr()
    assert "Could not find" in captured.err
    assert captured.out == ""


def test_cli_system_exit(monkeypatch, tmp_path, capsys):
    image_path = tmp_path / "report.png"
    image_path.write_bytes(b"")

    def _raise(_: Path, **kwargs) -> ExtractionResult:
        raise SystemExit("Dependency missing")

    monkeypatch.setattr(app, "extract_from_image", _raise)

    exit_code = app.main([str(image_path)])

    assert exit_code == 1
    captured = capsys.readouterr()
    assert "Dependency missing" in captured.err
    assert captured.out == ""
