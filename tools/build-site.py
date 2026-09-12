#!/usr/bin/env python3
"""Assemble a deployable static site: jellyfin-web's build with the overlay on top.

A GitHub Pages project site is a subdirectory, not a host, so everything has to
work under a base path. It also cannot run code, so the three things serve.py
does at request time are done here instead:

  * /System/Info/Public is written as a file, because jellyfin-web probes for a
    server during boot and registers the service worker only afterwards — with
    nothing to answer that probe the app settles on "no servers" and never
    retries.
  * index.html is written with the bootstrap script tags already in it.
  * precache-manifest.json is written, listing everything to hold offline.

The logic is imported from serve.py rather than restated, so the dev host and
the deployed site cannot drift.
"""

import argparse
import json
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import serve  # noqa: E402  (path set above)


def copy_tree(src, dest):
    for root, _dirs, names in os.walk(src):
        rel = os.path.relpath(root, src)
        target = os.path.join(dest, rel) if rel != "." else dest
        os.makedirs(target, exist_ok=True)
        for name in names:
            if name.endswith(".map"):
                continue
            shutil.copy2(os.path.join(root, name), os.path.join(target, name))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--webroot", required=True, help="jellyfin-web build output")
    ap.add_argument("--out", required=True, help="directory to assemble into")
    ap.add_argument(
        "--base-path",
        default="",
        help="subdirectory the site will be served from, e.g. /jf-offline",
    )
    args = ap.parse_args()

    base = args.base_path.rstrip("/")
    webroot = os.path.abspath(os.path.expanduser(args.webroot))
    out = os.path.abspath(args.out)
    web = os.path.join(out, "web")

    if not os.path.isfile(os.path.join(webroot, "index.html")):
        sys.exit(f"no jellyfin-web build at {webroot}")

    if os.path.isdir(out):
        shutil.rmtree(out)
    os.makedirs(web, exist_ok=True)

    copy_tree(webroot, web)
    # The overlay goes on top, exactly as serve.py shadows the build.
    copy_tree(serve.OVERLAY, web)

    # 1. The server probe, as a file.
    info_dir = os.path.join(out, "System", "Info")
    os.makedirs(info_dir, exist_ok=True)
    with open(os.path.join(info_dir, "Public"), "w", encoding="utf-8") as fh:
        json.dump({
            "LocalAddress": "",
            "ServerName": "Offline Library",
            "Version": "12.0.0",
            "ProductName": "Phantom Jellyfin Server",
            "OperatingSystem": "",
            "Id": serve.phantom_server_id(),
            "StartupWizardCompleted": True,
        }, fh)

    # 2. index.html, pre-injected.
    index = os.path.join(web, "index.html")
    with open(index, encoding="utf-8") as fh:
        html = fh.read()
    tags = serve.bootstrap_tags(base)
    marker = html.find("<head>")
    html = tags + html if marker == -1 else html[: marker + 6] + tags + html[marker + 6:]
    with open(index, "w", encoding="utf-8") as fh:
        fh.write(html)

    # 3. The precache manifest, over what was actually assembled.
    manifest = serve.build_manifest(web, base, overlay=False)
    with open(os.path.join(web, "precache-manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh)

    # Pages runs Jekyll otherwise, which drops files it considers special.
    open(os.path.join(out, ".nojekyll"), "w").close()

    # A landing redirect, so the bare project URL reaches the app.
    with open(os.path.join(out, "index.html"), "w", encoding="utf-8") as fh:
        fh.write(
            '<!doctype html><meta charset="utf-8">'
            f'<meta http-equiv="refresh" content="0; url={base}/web/">'
            f'<title>Offline Jellyfin</title><a href="{base}/web/">Open the app</a>'
        )

    files = sum(len(names) for _root, _dirs, names in os.walk(out))
    size = sum(
        os.path.getsize(os.path.join(root, name))
        for root, _dirs, names in os.walk(out) for name in names
    )
    print(f"assembled {files} files ({size / 1048576:.1f} MB) into {out}")
    print(f"base path {base or '/'}  manifest {manifest['version']} ({len(manifest['files'])} entries)")


if __name__ == "__main__":
    main()
