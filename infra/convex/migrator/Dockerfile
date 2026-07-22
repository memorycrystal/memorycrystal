FROM node:22-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends jq unzip \
    && npm install --global convex@1.41.0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /work
CMD ["sleep", "infinity"]
