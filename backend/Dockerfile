FROM python:3.13-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Scene data downloads automatically on first boot; persist it via the volume
# in docker-compose so restarts don't re-hit the Overpass API.
EXPOSE 8000
CMD ["python", "main.py"]
