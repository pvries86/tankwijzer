FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY core.py app.py ./
RUN useradd --system --uid 10001 sidecar && mkdir -p /data && chown sidecar /data
USER sidecar
VOLUME /data
EXPOSE 8090
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD python -c "import urllib.request,sys; urllib.request.urlopen('http://127.0.0.1:8090/health', timeout=4)" || exit 1
CMD ["python", "app.py"]
