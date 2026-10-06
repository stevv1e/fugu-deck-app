# Собирается из корня репозитория:  docker build -f control-plane/Dockerfile .
FROM node:22-alpine AS web
WORKDIR /src
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ .
RUN npm run build

FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
COPY control-plane/requirements.txt .
RUN pip install -r requirements.txt
COPY control-plane/cp ./cp
COPY --from=web /src/dist ./static
RUN useradd -r -u 10001 deck && mkdir -p /data && chown deck /data
USER deck
EXPOSE 8080
CMD ["uvicorn", "cp.main:app", "--host", "0.0.0.0", "--port", "8080", "--proxy-headers", "--forwarded-allow-ips", "*"]
