"""Flask web application for the genetics report extractor."""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Dict, Optional

try:  # pragma: no cover - import availability depends on environment
    from flask import Flask, Response, flash, redirect, render_template_string, request, url_for
except ImportError as exc:  # pragma: no cover - handled gracefully for CLI usage
    raise SystemExit("Flask is required to run the web application. Install it with 'pip install flask'.") from exc

from genetics_report_parser import ExtractionResult, extract_from_image

app = Flask(__name__)
app.config["SECRET_KEY"] = "genetics-report-secret"
app.config["MAX_CONTENT_LENGTH"] = 10 * 1024 * 1024  # 10MB upload limit

PAGE_TEMPLATE = """
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Genetics Report Extractor</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 2rem; }
      h1 { font-size: 1.75rem; margin-bottom: 1rem; }
      form { margin-bottom: 1.5rem; }
      .messages { color: #b00020; margin-bottom: 1rem; }
      table { border-collapse: collapse; width: 100%; max-width: 40rem; }
      th, td { border: 1px solid #ccc; padding: 0.5rem; text-align: left; }
      th { background-color: #f5f5f5; width: 30%; }
    </style>
  </head>
  <body>
    <h1>Genetics Report Extractor</h1>
    <p>Upload a screenshot of a clinical genetics report to extract key fields.</p>
    <form method="post" enctype="multipart/form-data">
      <label for="report">Report image:</label>
      <input type="file" id="report" name="report" accept="image/*" required>
      <button type="submit">Extract</button>
    </form>

    {% with messages = get_flashed_messages() %}
      {% if messages %}
        <div class="messages">
          {% for message in messages %}
            <div>{{ message }}</div>
          {% endfor %}
        </div>
      {% endif %}
    {% endwith %}

    {% if result %}
      <h2>Extracted information</h2>
      <table>
        <tbody>
          {% for key, value in result.items() %}
            <tr>
              <th>{{ key.replace('_', ' ').title() }}</th>
              <td>
                {% if value is sameas true %}
                  Yes
                {% elif value is sameas false %}
                  No
                {% elif value %}
                  {{ value }}
                {% else %}
                  Not found
                {% endif %}
              </td>
            </tr>
          {% endfor %}
        </tbody>
      </table>
    {% endif %}
  </body>
</html>
"""


def _save_uploaded_file() -> Optional[Path]:
    """Persist the uploaded file to a temporary location and return the path."""

    file_storage = request.files.get("report")
    if not file_storage or not file_storage.filename:
        flash("Please choose an image before submitting.")
        return None

    suffix = Path(file_storage.filename).suffix or ".png"
    temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    file_storage.save(temp_file.name)
    temp_file.close()
    return Path(temp_file.name)


@app.route("/", methods=["GET", "POST"])
def index() -> Response | str:
    result: Optional[Dict[str, Optional[str]]] = None

    if request.method == "POST":
        uploaded_path = _save_uploaded_file()
        if uploaded_path is None:
            return redirect(url_for("index"))

        try:
            extraction: ExtractionResult = extract_from_image(uploaded_path)
        except SystemExit as exc:  # dependencies missing
            flash(str(exc))
        except Exception as exc:  # pragma: no cover - safety net for unexpected errors
            flash(f"Could not process the uploaded file: {exc}")
        else:
            result = extraction.to_dict()
        finally:
            uploaded_path.unlink(missing_ok=True)

    return render_template_string(PAGE_TEMPLATE, result=result)


if __name__ == "__main__":  # pragma: no cover - CLI entrypoint
    app.run(debug=True)
