"""py2app build script for packaging the genetics report extractor as a macOS app."""

from __future__ import annotations

from pathlib import Path
from typing import List, Tuple

from setuptools import setup

APP = ["genetics_report_app.py"]
DATA_FILES: List[Tuple[str, List[str]]] = []
OPTIONS = {
    "packages": ["PIL", "pytesseract"],
    "plist": {
        "CFBundleName": "Genetics Report Extractor",
        "CFBundleShortVersionString": "1.0.0",
        "CFBundleVersion": "1.0.0",
        "CFBundleIdentifier": "com.example.genetics-report-extractor",
        "NSHumanReadableCopyright": "© 2024 Genetics Report Extractor",
    },
}

# Ensure the README is bundled so users can reference usage instructions from the DMG.
README = Path("README.md")
if README.exists():
    DATA_FILES.append(("", [str(README)]))

setup(
    app=APP,
    data_files=DATA_FILES,
    options={"py2app": OPTIONS},
    setup_requires=["py2app"],
)
