# ML-сервис распознавания лиц (sidecar)
# Использует dlib + face_recognition. Образ тяжёлый (~2 ГБ), но точный.
# Запуск: docker compose -f docker-compose.yml -f docker-compose.ml.yml up -d
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake libopenblas-dev liblapack-dev libx11-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /ml
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY worker.py .

CMD ["python", "worker.py"]