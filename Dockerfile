# Ka-Rae-oke — offline karaoke player.
#
# The image contains ONLY the app code (src/) + ops scripts (tools/). All mutable
# data — songs (kar_raw/), videos/, the soundfont, bgv clips, and the catalogs —
# lives in a mounted volume at /data (KARAEOKE_DATA_DIR). See docker-compose.yml.
#
#   docker build -t karaeoke .
#   docker run --rm -p 8080:8080 -v "$(pwd)/data:/data" karaeoke
#   open http://localhost:8080/
#
# On first boot, serve.py's setup() fills any missing pieces into /data (the ~31 MB
# soundfont download needs network once). Pre-populate ./data/soundfont.sf2 for a
# fully-offline image.
FROM python:3.12-slim

WORKDIR /app

# App code + ops scripts only (stdlib Python — no pip install needed).
COPY tools/ ./tools/
COPY src/ ./src/

# All user/mutable data is served from here; mount it as a volume.
ENV KARAEOKE_DATA_DIR=/data
VOLUME ["/data"]

EXPOSE 8080

# Bind to all interfaces (container), don't try to open a browser.
CMD ["python", "tools/serve.py", "--host", "0.0.0.0", "--no-open"]
