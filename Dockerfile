# Ka-Rae-oke — offline karaoke player.
#
# The runtime image contains ONLY the app code (src/, minified) + ops scripts
# (tools/). All mutable data — songs (kar_raw/), videos/, the soundfont, bgv
# clips, and the catalogs — lives in a mounted volume at /data. See compose file.
#
#   docker build -t karaeoke .
#   docker run --rm -p 8080:8080 -v "$(pwd)/data:/data" karaeoke
#   open http://localhost:8080/
#
# On first boot, serve.py's setup() fills any missing pieces into /data (the
# ~31 MB soundfont download needs network once). Pre-populate ./data/soundfont.sf2
# for a fully-offline image.

# ---------------------------------------------------------------------------
# Stage 1 — minify the app assets. Docker-only; local `serve.py` stays buildless.
# PER-FILE minify, NO bundling: the index.html import map, the worklet/worker
# string paths (addModule(...) / new Worker(new URL("./workers/...", ...))), and
# the inline data-URI favicon all survive untouched.
# ---------------------------------------------------------------------------
FROM node:20-slim AS build
WORKDIR /build
COPY src/ ./src/

# JS + CSS: esbuild --minify (whitespace + syntax + local-identifier renaming),
# rewritten in place. --outbase/--outdir=src + --allow-overwrite keep the tree
# shape identical; no --bundle, so imports and worklet/worker URLs are left as-is.
# Already-*.min.js vendor files re-minify harmlessly; the big non-min SpessaSynth
# libs (spessasynth_lib.js + spessasynth_core.js, ~678 KB) are the real win.
RUN npx --yes esbuild@0.24.2 \
      $(find src \( -name '*.js' -o -name '*.css' \)) \
      --minify --outbase=src --outdir=src --allow-overwrite

# HTML shell: collapse whitespace + drop comments, minify the inline CSS/JS.
# The type="importmap" block is JSON and is left alone by the JS minifier.
RUN npx --yes html-minifier-terser@7.2.0 \
      --input-dir src --output-dir src --file-ext html \
      --collapse-whitespace --remove-comments --minify-css --minify-js

# ---------------------------------------------------------------------------
# Stage 2 — runtime (unchanged: stdlib Python server, /data volume).
# ---------------------------------------------------------------------------
FROM python:3.12-slim
WORKDIR /app
COPY tools/ ./tools/
COPY --from=build /build/src ./src/

# All user/mutable data is served from here; mount it as a volume.
ENV KARAEOKE_DATA_DIR=/data
VOLUME ["/data"]

EXPOSE 8080

# Bind to all interfaces (container), don't try to open a browser.
CMD ["python", "tools/serve.py", "--host", "0.0.0.0", "--no-open"]
