# first-coding

Simple projects for getting started.

## Genetics report extractor

This repository now includes:

* `genetics_report_parser.py`, a command line utility that performs OCR on a
  clinical genetics report screenshot and extracts common details such as the
  gene, variant, and interpretation.
* `genetics_report_web.py`, a lightweight Flask web application that lets you
  upload a genetics report screenshot from your browser and view the extracted
  information.

### Setup

Install the required dependencies. You will also need the `tesseract` binary
available on your machine.

```bash
pip install -r requirements.txt
```

### Testing

Run the parser's automated tests with `pytest`:

```bash
pytest
```

### Usage

```bash
python genetics_report_parser.py /path/to/report.png
```

Add `--json` to receive the parsed information in JSON form.

### Running the web application

Start the Flask server to use the browser-based interface:

```bash
python genetics_report_web.py
```

The server listens on `http://127.0.0.1:5000/` by default. Open that address in
your browser, upload a genetics report image, and the page will display the
extracted data directly below the upload form. The parser still requires the
`tesseract` binary to be installed and accessible from your system `PATH`.
