# first-coding

Simple projects for getting started.

## Genetics report extractor

This repository includes `genetics_report_parser.py`, a command line utility
that performs OCR on a clinical genetics report screenshot and extracts common
fields such as the patient, gene, variant, and interpretation values.

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

### Testing

Execute the automated tests with `pytest`:

```bash
pytest
```
