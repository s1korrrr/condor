import ast
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
IMPORT_DISTRIBUTIONS = {"yaml": "pyyaml"}


def normalized(name):
    return re.sub(r"[-_.]+", "-", name).lower()


def test_v5_module_imports_are_covered_by_the_hashed_runtime_lock():
    lock = (ROOT / "requirements-v5.lock").read_text()
    locked = {normalized(name) for name in re.findall(r"^([\w.-]+)==", lock, re.MULTILINE)}
    inputs = {
        normalized(name)
        for name in re.findall(
            r"^([\w.-]+)[<>=!~]", (ROOT / "requirements-v5.in").read_text(), re.MULTILINE
        )
    }
    assert inputs <= locked, f"V5 runtime inputs missing from lock: {sorted(inputs - locked)}"
    missing = []
    for path in sorted((ROOT / "condor" / "v5").rglob("*.py")):
        for node in ast.walk(ast.parse(path.read_text(), filename=str(path))):
            if isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom) and node.level == 0:
                names = [node.module]
            else:
                continue
            for name in names:
                module = name.split(".")[0]
                if module in sys.stdlib_module_names or module == "condor":
                    continue
                distribution = IMPORT_DISTRIBUTIONS.get(module, normalized(module))
                if distribution not in locked:
                    missing.append(f"{module} <- {path.relative_to(ROOT)}:{node.lineno}")
    assert not missing, "V5 runtime imports missing from lock: " + "; ".join(missing)
