FROM python:3.12-slim-trixie@sha256:2f17fc044b579bab302c2e8054d3a686e2cb9a83de48e70534b94cd8ebbe06a9

ARG SOURCE_SHA
LABEL org.opencontainers.image.source="https://github.com/mobius-os/app-social" \
      org.opencontainers.image.revision="${SOURCE_SHA}" \
      org.opencontainers.image.title="Möbius Social community service"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    SOCIAL_DATA_DIR=/data \
    SOCIAL_SOURCE_SHA=${SOURCE_SHA}

RUN python -c 'import os,re; value=os.environ["SOCIAL_SOURCE_SHA"]; assert re.fullmatch(r"[0-9a-f]{40}", value), "SOURCE_SHA must be a 40-character lowercase Git SHA"' \
    && groupadd --gid 1000 social \
    && useradd --uid 1000 --gid 1000 --no-create-home --shell /usr/sbin/nologin social \
    && mkdir -p /data \
    && chown 1000:1000 /data

COPY deploy/community/requirements.lock /tmp/requirements.lock
RUN pip install --no-cache-dir -r /tmp/requirements.lock \
    && rm /tmp/requirements.lock

WORKDIR /srv/app
COPY common_protocol.py common_public.py common_transport.py net_utils.py service_io.py community_host.py ./
RUN chown -R root:root /srv/app && chmod -R a-w /srv/app

USER 1000:1000
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=4 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=2).read()"
CMD ["uvicorn", "community_host:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
