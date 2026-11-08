"""Forking Paths numerical engine.

This package is the only implementation of the numerical methods. The browser runs it in a
Pyodide worker; the command-line reproduction tool runs the same files under CPython.
"""

ENGINE_VERSION = "0.1.0"

SCHEMAS = {
    "source": "fp.source/1",
    "dataset": "fp.dataset/1",
    "plan": "fp.plan/1",
    "run": "fp.run/1",
    "result": "fp.result/1",
    "bundle": "fp.bundle/1",
}


def runtime_info() -> dict:
    import platform
    import sys

    import numpy
    import scipy

    return {
        "engine": ENGINE_VERSION,
        "python": platform.python_version(),
        "implementation": sys.platform,
        "numpy": numpy.__version__,
        "scipy": scipy.__version__,
    }
