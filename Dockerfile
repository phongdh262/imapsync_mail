FROM python:3.9-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# IMPORTANT: Workers must be 1 because we use in-memory global state (active_jobs).
# If you use multiple workers, status checks might fail (404 job not found).
# We use threads to handle concurrency.
CMD ["gunicorn", "app:app", "--workers", "1", "--threads", "100", "--timeout", "300", "--bind", "0.0.0.0:3000"]
