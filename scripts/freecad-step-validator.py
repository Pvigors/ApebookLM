#!/usr/bin/env python3
"""Independent native FreeCAD STEP reader used as the production publish gate."""

import json
import os
import re
import sys

import FreeCAD  # type: ignore
import Part  # type: ignore


def fail(message: str) -> None:
    raise RuntimeError(message)


if len(sys.argv) != 2:
    fail("usage: freecad-step-validator.py <model.step>")

step_path = os.path.realpath(sys.argv[1])
temp_root = os.path.realpath(os.path.join(os.getcwd(), ".data", "cad-tmp"))
if not step_path.startswith(temp_root + os.sep) or os.path.basename(step_path) != "model.step":
    fail("STEP validator path escaped CAD temp root")
size = os.path.getsize(step_path)
if size < 128 or size > 256 * 1024 * 1024:
    fail("STEP file size is invalid")
with open(step_path, "rb") as handle:
    text = handle.read().decode("utf-8", errors="replace")
if not re.search(r"ISO-10303-21\s*;", text[:8192]):
    fail("STEP header is invalid")
if not re.search(r"LENGTH_UNIT\(\).*SI_UNIT\(\.MILLI\.,\.METRE\.\)", text, re.S):
    fail("STEP does not declare millimeter units")

try:
    shape = Part.read(step_path)
except Exception as error:
    fail(f"FreeCAD could not parse STEP: {error}")
if shape is None or shape.isNull():
    fail("FreeCAD returned an empty STEP shape")
solids = list(shape.Solids)
if not solids:
    fail("FreeCAD STEP contains no solids")
if not shape.isValid():
    fail("FreeCAD STEP B-Rep is invalid")


def bounds(item):
    box = item.BoundBox
    return [
        [round(float(box.XMin), 6), round(float(box.YMin), 6), round(float(box.ZMin), 6)],
        [round(float(box.XMax), 6), round(float(box.YMax), 6), round(float(box.ZMax), 6)],
    ]


parts = [
    {
        "bounds": bounds(solid),
        "volumeMm3": round(float(solid.Volume), 6),
        "faceCount": len(solid.Faces),
        "edgeCount": len(solid.Edges),
    }
    for solid in solids
]
volume = sum(part["volumeMm3"] for part in parts)
if not volume > 0:
    fail("FreeCAD STEP volume is invalid")

print(json.dumps({
    "ok": True,
    "validator": "freecad-native",
    "version": ".".join(str(item) for item in FreeCAD.Version()[:3]),
    "schema": "AP242" if re.search(r"FILE_SCHEMA\s*\(\s*\(\s*'AP242", text, re.I) else "STEP",
    "unit": "mm",
    "brepValid": True,
    "solidCount": len(solids),
    "faceCount": len(shape.Faces),
    "edgeCount": len(shape.Edges),
    "bounds": bounds(shape),
    "volumeMm3": round(volume, 6),
    "parts": parts,
}, ensure_ascii=False, separators=(",", ":")))
