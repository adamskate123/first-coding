"""Simple macOS GUI wrapper for the genetics report extractor."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import TYPE_CHECKING

from genetics_report_parser import ExtractionResult, extract_from_image

if TYPE_CHECKING:  # pragma: no cover - used only for typing support
    from tkinter import Tk


def _format_result(result: ExtractionResult) -> str:
    """Format extraction results for display in the GUI."""

    lines = []
    for field, value in result.to_dict().items():
        label = field.replace("_", " ").title()
        if isinstance(value, bool):
            display_value = "Yes" if value else "No"
        elif value is None:
            display_value = "Not found"
        else:
            display_value = str(value)
        lines.append(f"{label}: {display_value}")
    return "\n".join(lines)


def _select_image_from_dialog(root: "Tk") -> Path | None:
    """Open a file chooser dialog and return the selected path."""

    from tkinter import filedialog

    file_path = filedialog.askopenfilename(
        title="Select a genetics report screenshot",
        filetypes=(
            ("Images", "*.png *.jpg *.jpeg *.tif *.tiff *.bmp"),
            ("All files", "*.*"),
        ),
        parent=root,
    )
    if not file_path:
        return None
    return Path(file_path)


def _parse_cli_args(argv: list[str]) -> argparse.Namespace:
    """Return CLI arguments shared with the standalone parser script."""

    parser = argparse.ArgumentParser(
        prog="python -m genetics_report_app",
        description="Extract key genetic information from a screenshot without launching the GUI.",
    )
    parser.add_argument(
        "image",
        type=Path,
        help="Path to the screenshot image (PNG, JPG, PDF supported by Pillow).",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Output the extracted data as JSON instead of human readable text.",
    )
    parser.add_argument(
        "--validate-variants",
        action="store_true",
        help=(
            "Consult Mutalyzer to confirm ambiguous variant candidates. "
            "Requires internet access and is disabled by default."
        ),
    )
    return parser.parse_args(argv)


def _run_cli(argv: list[str]) -> int:
    """Execute the extraction logic without launching the GUI."""

    try:
        args = _parse_cli_args(argv)
    except SystemExit as exc:
        # Allow argparse to handle --help/--version while keeping exit codes predictable in tests.
        return int(exc.code) if isinstance(exc.code, int) else 1

    image_path = args.image.expanduser()

    if not image_path.exists():
        print(f"Could not find: {image_path}", file=sys.stderr)
        return 1

    try:
        enable_validation = True if args.validate_variants else None
        result = extract_from_image(
            image_path, enable_variant_validation=enable_validation
        )
    except SystemExit as exc:
        print(str(exc), file=sys.stderr)
        return int(exc.code) if isinstance(exc.code, int) else 1
    except Exception as exc:  # pragma: no cover - CLI specific failure path
        print(f"Failed to extract report data: {exc}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(result.to_dict(), indent=2))
    else:
        print(_format_result(result))
    return 0


def main(argv: list[str] | None = None) -> int:
    """Entry point for the GUI app."""

    args = list(argv or sys.argv[1:])
    if args:
        return _run_cli(args)

    try:
        from tkinter import Tk, messagebox
    except Exception as exc:  # pragma: no cover - platform specific failure path
        print(
            "The graphical interface is unavailable (tkinter could not be initialized). "
            "Run `python genetics_report_parser.py <image_path>` instead. "
            f"Details: {exc}",
            file=sys.stderr,
        )
        return 1

    try:
        root = Tk()
    except Exception as exc:  # pragma: no cover - platform specific failure path
        print(
            "The graphical interface is unavailable on this system. "
            "Run `python genetics_report_parser.py <image_path>` instead. "
            f"Details: {exc}",
            file=sys.stderr,
        )
        return 1

    root.withdraw()  # Hide the root window as we only need dialogs.

    image_path = _select_image_from_dialog(root)
    if image_path is None:
        root.destroy()
        return 0

    if not image_path.exists():
        messagebox.showerror("File not found", f"Could not find: {image_path}", parent=root)
        root.destroy()
        return 1

    try:
        result = extract_from_image(image_path)
    except SystemExit as exc:
        messagebox.showerror("Missing dependency", str(exc), parent=root)
        root.destroy()
        return int(exc.code) if isinstance(exc.code, int) else 1
    except Exception as exc:  # pragma: no cover - GUI specific failure path
        messagebox.showerror("Error", f"Failed to extract report data: {exc}", parent=root)
        root.destroy()
        return 1

    messagebox.showinfo("Genetics Report Extraction", _format_result(result), parent=root)
    root.destroy()
    return 0


if __name__ == "__main__":  # pragma: no cover - GUI entry point
    sys.exit(main())
