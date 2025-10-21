"""Simple macOS GUI wrapper for the genetics report extractor."""

from __future__ import annotations

import sys
from pathlib import Path
from tkinter import Tk, filedialog, messagebox

from genetics_report_parser import ExtractionResult, extract_from_image


def _format_result(result: ExtractionResult) -> str:
    """Format extraction results for display in the GUI."""

    lines = []
    for field, value in result.to_dict().items():
        label = field.replace("_", " ").title()
        lines.append(f"{label}: {value or 'Not found'}")
    return "\n".join(lines)


def _select_image_from_dialog(root: Tk) -> Path | None:
    """Open a file chooser dialog and return the selected path."""

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


def main(argv: list[str] | None = None) -> int:
    """Entry point for the GUI app."""

    root = Tk()
    root.withdraw()  # Hide the root window as we only need dialogs.

    args = list(argv or sys.argv[1:])
    if args:
        image_path = Path(args[0])
    else:
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
