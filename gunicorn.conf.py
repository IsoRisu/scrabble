"""Gunicorn settings for Railway / Render (used by the Procfile).

Game state lives in this process's memory, so there must be exactly ONE worker
process. Concurrency comes from eventlet green threads, not from more workers.
"""
import os

bind = f"0.0.0.0:{os.environ.get('PORT', '8000')}"
worker_class = "eventlet"
workers = 1  # do not raise: a second process would have its own, separate rooms
timeout = 120
graceful_timeout = 30
keepalive = 5
accesslog = "-"
errorlog = "-"
loglevel = os.environ.get("LOG_LEVEL", "info")
