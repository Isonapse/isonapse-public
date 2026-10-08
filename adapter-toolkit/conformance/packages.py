#!/usr/bin/env python3
"""Build/install the public ADK into disposable environments and test those bytes.

In the Isonapse source repository this installs the packages of the adapter
toolkit bundle that ships in every Agent Hook archive (built by
scripts/release/adapter-toolkit-bundle.py), with `npm install --offline` and
`pip install --no-index`. A standalone toolkit copy has no bundle builder: there
it packs the sources with `npm pack` and `pip wheel` (Python's pinned build
backend is fetched by pip when absent from its cache).

No daemon or live host state is touched. TypeScript has no runtime dependencies.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile


def run(argv, *, cwd, env=None):
    return subprocess.run(argv, cwd=cwd, env=env, check=True, timeout=180,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


def bundle_builder(root):
    """The shipped bundle's builder in the source repository, or None in a standalone copy."""
    release = root.parent
    builder = release / "adapter-toolkit-bundle.py"
    if builder.is_file():
        return builder
    if (release / "public-support-export-v1.json").exists():
        raise RuntimeError("this source checkout lacks scripts/release/adapter-toolkit-bundle.py")
    return None


def bundled_package(builder, work, language):
    """Build the toolkit bundle, then return its packed ADK for `language`."""
    bundle = work / "isonapse-adapter-toolkit.tar.gz"
    run([sys.executable, str(builder), "build", "--output", str(bundle), "--source-commit", "uncommitted"],
        cwd=work)
    extracted = work / "bundle"
    with tarfile.open(bundle) as archive:
        archive.extractall(extracted, **({"filter": "data"} if hasattr(tarfile, "data_filter") else {}))
    pattern = "python/*.whl" if language == "python" else "typescript/*.tgz"
    found = sorted((extracted / "isonapse-adapter-toolkit").glob(pattern))
    if len(found) != 1:
        raise RuntimeError(f"expected exactly one bundled {language} ADK package")
    return found[0]


def verify(language, root):
    builder = bundle_builder(root)
    with tempfile.TemporaryDirectory(prefix="isonapse-adk-install-") as temporary:
        work = Path(temporary).resolve()
        source = work / "source"
        shutil.copytree(root / language, source, ignore=shutil.ignore_patterns(
            "build", "dist", "*.egg-info", "__pycache__", "node_modules", "*.tgz"))
        environment = os.environ.copy()
        for key in ["PYTHONPATH", "PYTHONHOME", "NODE_OPTIONS", "ISONAPSE_ADK_TEST_PACKAGE"]:
            environment.pop(key, None)
        if language == "python":
            run([sys.executable, "-m", "venv", str(work / "env")], cwd=work, env=environment)
            executable = str(work / "env/bin/python")
            if builder is not None:
                artifact = bundled_package(builder, work, language)
            else:
                run([executable, "-m", "pip", "wheel", "--no-deps", "--wheel-dir", str(work), str(source)], cwd=work, env=environment)
                wheels = list(work.glob("*.whl"))
                if len(wheels) != 1:
                    raise RuntimeError("expected exactly one ADK wheel")
                artifact = wheels[0]
            run([executable, "-m", "pip", "install", "--no-index", "--no-deps", str(artifact)], cwd=work, env=environment)
            proof = run([executable, "-m", "unittest", "discover", "-s", str(source / "tests"), "-v"], cwd=work, env=environment)
            starter = work / "agent.py"
            initialize = [executable, "-m", "isonapse_hook_adk", "init", str(starter)]
        else:
            node, npm = shutil.which("node"), shutil.which("npm")
            if not node or not npm:
                raise RuntimeError("Node >=22 and npm are required")
            version = run([node, "--version"], cwd=work).stdout.strip()
            if int(version.lstrip("v").split(".")[0]) < 22:
                raise RuntimeError("Node >=22 is required")
            if builder is not None:
                artifact = bundled_package(builder, work, language)
            else:
                packed = run([npm, "pack", "--ignore-scripts", "--json", "--pack-destination", str(work)], cwd=source, env=environment)
                artifact = work / json.loads(packed.stdout)[0]["filename"]
            destination = work / "installed"
            run([npm, "install", "--prefix", str(destination), "--ignore-scripts", "--no-audit", "--no-fund", "--offline", str(artifact)], cwd=work, env=environment)
            package = destination / "node_modules/@isonapse/hook-adk"
            environment["ISONAPSE_ADK_TEST_PACKAGE"] = (package / "index.js").as_uri()
            proof = run([node, "--test", *map(str, sorted((source / "tests").glob("*.test.js")))], cwd=work, env=environment)
            starter = work / "agent.mjs"
            initialize = [node, str(package / "cli.js"), "init", str(starter)]
        print(proof.stdout, end="")
        print(proof.stderr, end="", file=sys.stderr)
        run(initialize, cwd=work, env=environment)
        original = starter.read_bytes()
        repeated = subprocess.run(initialize, cwd=work, env=environment, capture_output=True, timeout=30)
        if repeated.returncode == 0 or starter.read_bytes() != original:
            raise RuntimeError("initializer overwrote an existing host entrypoint")
        origin = "toolkit-bundle" if builder is not None else "packed"
        print(f"ADK {language}: installed {origin} package {artifact.name} and non-overwriting init PASS; "
              f"sha256={hashlib.sha256(artifact.read_bytes()).hexdigest()}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--language", choices=["python", "typescript", "all"], default="all")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    for language in (["python", "typescript"] if args.language == "all" else [args.language]):
        verify(language, root)


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        print(error.stdout or "", file=sys.stderr)
        print(error.stderr or "", file=sys.stderr)
        raise SystemExit(f"ADK package conformance failed (exit {error.returncode})") from error
