#!/usr/bin/env python3
"""Small native FreeCAD export/import smoke test for the CAD worker healthcheck."""

import json
import os
import tempfile

import FreeCAD  # type: ignore
import Part  # type: ignore


with tempfile.TemporaryDirectory(prefix="apebooklm-freecad-health-", dir="/tmp") as directory:
    step_path = os.path.join(directory, "health.step")
    source = Part.makeBox(10.0, 10.0, 10.0)
    source.exportStep(step_path)
    restored = Part.read(step_path)
    if restored is None or restored.isNull() or not restored.isValid():
        raise RuntimeError("FreeCAD health STEP round-trip is invalid")
    if len(restored.Solids) != 1 or abs(float(restored.Volume) - 1000.0) > 0.1:
        raise RuntimeError("FreeCAD health STEP geometry mismatch")
    print(json.dumps({
        "ok": True,
        "validator": "freecad-native",
        "version": ".".join(str(item) for item in FreeCAD.Version()[:3]),
        "solidCount": 1,
        "volumeMm3": round(float(restored.Volume), 6),
    }, separators=(",", ":")))
