# first-coding

Simple projects for getting started.

## Genetics report extractor

This repository includes `genetics_report_parser.py`, a command line utility
that performs OCR on a clinical genetics report screenshot and extracts common
fields such as the patient, gene, variant, and interpretation values. The
parser combines label-based extraction with table-style fallbacks so it keeps
working even when column headers are faint, cropped, or lost in low quality
scans.

### Prerequisites

* Python 3.9+
* The `tesseract` OCR binary installed and available on your `PATH`

### Installation

Install the Python dependencies (consider using a virtual environment):

```bash
pip install -r requirements.txt
```

### Usage

Run the parser from your terminal, pointing it at a genetics report image:

```bash
python genetics_report_parser.py /path/to/report.png
```

Append `--json` to emit a machine-readable JSON representation of the extracted
fields.

Pass `--validate-variants` to confirm ambiguous HGVS candidates with the online
Mutalyzer service. This flag requires internet access and is disabled by
default so offline workflows remain unchanged. The same behaviour can be
enabled non-interactively by setting the `GENETICS_REPORT_VALIDATE_VARIANTS`
environment variable to `1`.

Use `--tesseract-config` to forward additional flags to Tesseract. The argument
accepts one or more values which are joined before being sent to pytesseract,
allowing commands such as:

```bash
python genetics_report_parser.py report.png --tesseract-config --psm 6
```

Specify custom OCR language packs with `--tesseract-lang`, for example
`--tesseract-lang eng+spa` to enable both English and Spanish dictionaries.

### Testing

Execute the automated tests with `pytest`:

```bash
pytest
```
