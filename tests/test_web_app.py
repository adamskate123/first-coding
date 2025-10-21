"""Tests for the Flask genetics report web application."""

from __future__ import annotations

import io
from typing import Dict, Optional

import pytest

pytest.importorskip("flask")

from genetics_report_parser import ExtractionResult
import genetics_report_web as web_app


@pytest.fixture
def client():
    web_app.app.config.update({"TESTING": True, "SECRET_KEY": "test"})
    return web_app.app.test_client()


def test_get_index_returns_form(client):
    response = client.get("/")
    assert response.status_code == 200
    assert b"Genetics Report Extractor" in response.data
    assert b"Report image" in response.data


def test_post_index_runs_extraction(monkeypatch, client):
    class DummyResult(ExtractionResult):
        def to_dict(self) -> Dict[str, Optional[str]]:  # type: ignore[override]
            return {"gene": "BRCA1", "variant": "c.68_69delAG"}

    monkeypatch.setattr(web_app, "extract_from_image", lambda path: DummyResult())

    data = {"report": (io.BytesIO(b"fake image"), "report.png")}
    response = client.post("/", data=data, content_type="multipart/form-data")

    assert response.status_code == 200
    assert b"BRCA1" in response.data
    assert b"c.68_69delAG" in response.data


def test_post_without_file_shows_error(client):
    response = client.post("/", data={}, content_type="multipart/form-data", follow_redirects=True)

    assert response.status_code == 200
    assert b"Please choose an image" in response.data
