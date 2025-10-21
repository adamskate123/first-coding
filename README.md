# first-coding

Simple projects for getting started.

## Genetics report extractor

This repository now includes:

* `genetics_report_parser.py`, a command line utility that performs OCR on a
  clinical genetics report screenshot and extracts common details such as the
  gene, variant, and interpretation.
* `genetics_report_app.py`, a tiny Tkinter GUI that wraps the same
  functionality so it can be bundled as a double-clickable macOS application
  and distributed as a `.dmg` disk image.

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

### Building a macOS app bundle (.dmg)

The repository ships with a `setup.py` configured for
[py2app](https://py2app.readthedocs.io/) so the extractor can be packaged as a
macOS application:

1. Install the build dependency (only needed on macOS):

   ```bash
   python -m pip install -r requirements.txt
   ```

2. Run py2app to create both a `.app` bundle and a `.dmg` disk image:

   ```bash
   python setup.py py2app
   ```

   The generated artifacts live in `dist/` (`Genetics Report Extractor.app` and
   `Genetics Report Extractor.dmg`). The application launches the
   `genetics_report_app.py` GUI, prompting the user to pick an image and showing
   the parsed results.
