#!/usr/bin/env python3
"""Check an assembled site before it is deployed.

Structural checks only — that the files a static host cannot generate are
present and internally consistent. Whether the app actually boots is a different
question, answered by tools/verify-site.js in a browser.

    python3 tools/check-assembly.py _site /jf-offline
"""

import json
import os
import sys


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: check-assembly.py <site-dir> [base-path]")
    site = sys.argv[1]
    base = (sys.argv[2] if len(sys.argv) > 2 else "").rstrip("/")

    problems = []

    def require(path, why):
        if not os.path.isfile(os.path.join(site, path)):
            problems.append(f"missing {path} ({why})")

    require("System/Info/Public", "nothing would answer the app's probe for a server")
    require("web/serviceworker.js", "there would be no phantom server")
    require("web/precache-manifest.json", "nothing would be held for offline use")
    require("web/plugin/manager.js", "the download manager is loaded from here directly")
    require("web/index.html", "there would be no app")

    index_path = os.path.join(site, "web", "index.html")
    if os.path.isfile(index_path):
        with open(index_path, encoding="utf-8") as fh:
            html = fh.read()
        for script in ("ps-bootstrap.js", "ps-ui.js", "ps/schema.js"):
            tag = f'src="{base}/web/{script}"'
            if tag not in html:
                problems.append(f"index.html does not load {script} at {base}/web/")

    worker = os.path.join(site, "web", "serviceworker.js")
    if os.path.isfile(worker):
        with open(worker, encoding="utf-8") as fh:
            if "phantom" not in fh.read().lower():
                problems.append("web/serviceworker.js is jellyfin-web's, not the phantom server")

    manifest_path = os.path.join(site, "web", "precache-manifest.json")
    if os.path.isfile(manifest_path):
        with open(manifest_path, encoding="utf-8") as fh:
            manifest = json.load(fh)
        # Every entry must exist: a wrong base path here makes the precache fetch
        # thousands of 404s and never report itself complete.
        missing = []
        for entry in manifest["files"]:
            if base and not entry.startswith(base + "/"):
                missing.append(f"{entry} (not under {base})")
                continue
            relative = entry[len(base):].lstrip("/")
            if not os.path.isfile(os.path.join(site, relative)):
                missing.append(entry)
            if len(missing) >= 10:
                break
        if missing:
            problems.append(f"manifest lists files that are not there: {missing}")
        else:
            print(f"manifest {manifest['version']}: {len(manifest['files'])} files, all present")

    if problems:
        for problem in problems:
            print(f"::error::{problem}", file=sys.stderr)
        sys.exit(1)
    print(f"assembly looks right at base {base or '/'}")


if __name__ == "__main__":
    main()
