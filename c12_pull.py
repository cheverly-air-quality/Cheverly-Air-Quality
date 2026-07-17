import os
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import pandas as pd
import requests
from dotenv import load_dotenv
from psycopg2.extras import execute_values
from sqlalchemy import create_engine

load_dotenv()

DEVICES = ["D14781", "D14645", "D17615", "E10588", "D14646", "B19939"]
BASE_URL = "https://cheverly-air-quality.vercel.app/api/aq"

DB_URL = os.getenv("DB_URL") or os.getenv("DATABASE_URL")
EASTERN = ZoneInfo("America/New_York")

if DB_URL and DB_URL.startswith("postgres://"):
    DB_URL = DB_URL.replace("postgres://", "postgresql+psycopg2://", 1)
elif DB_URL and DB_URL.startswith("postgresql://"):
    DB_URL = DB_URL.replace("postgresql://", "postgresql+psycopg2://", 1)


def to_float(value):
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def to_eastern_naive(timestamp_ms):
    """
    Convert GroveStreams UTC epoch milliseconds to Eastern local clock time.

    The existing c12_master table stores timestamps without timezone information,
    so the timezone is removed after conversion. ZoneInfo handles EST/EDT.
    """
    if timestamp_ms is None:
        return datetime.now(EASTERN).replace(tzinfo=None)

    try:
        utc_time = datetime.fromtimestamp(
            float(timestamp_ms) / 1000.0,
            tz=timezone.utc,
        )
        return utc_time.astimezone(EASTERN).replace(tzinfo=None)
    except (TypeError, ValueError, OSError):
        return datetime.now(EASTERN).replace(tzinfo=None)


def fetch_device(device_id):
    response = requests.get(
        BASE_URL,
        params={"action": "grove_last", "compId": device_id},
        timeout=30,
    )
    response.raise_for_status()

    streams = response.json()
    if not isinstance(streams, list):
        raise RuntimeError(f"Unexpected GroveStreams response for {device_id}")

    row = {
        "device_id": device_id,
        "bc_880nm": None,
        "latitude": None,
        "longitude": None,
        "time_stamp": datetime.now(EASTERN).replace(tzinfo=None),
    }

    for stream in streams:
        stream_id = str(stream.get("streamId", ""))
        value = to_float(stream.get("data"))

        if stream_id == "880nm":
            row["bc_880nm"] = value
            row["time_stamp"] = to_eastern_naive(stream.get("time"))
        elif stream_id == "lat":
            row["latitude"] = value
        elif stream_id == "long":
            row["longitude"] = value

    return row


def upsert_rows(engine, rows):
    if not rows:
        return 0

    values = [
        (
            row["device_id"],
            row["bc_880nm"],
            row["latitude"],
            row["longitude"],
            row["time_stamp"],
        )
        for row in rows
    ]

    sql = """
        INSERT INTO c12_master
            (device_id, bc_880nm, latitude, longitude, time_stamp)
        VALUES %s
        ON CONFLICT (device_id, time_stamp)
        DO UPDATE SET
            bc_880nm = EXCLUDED.bc_880nm,
            latitude = EXCLUDED.latitude,
            longitude = EXCLUDED.longitude
    """

    raw_connection = engine.raw_connection()

    try:
        with raw_connection.cursor() as cursor:
            execute_values(cursor, sql, values, page_size=100)
        raw_connection.commit()
    finally:
        raw_connection.close()

    return len(values)


def pull_c12_from_grove():
    if not DB_URL:
        raise RuntimeError("Missing DB_URL or DATABASE_URL")

    engine = create_engine(
        DB_URL,
        pool_pre_ping=True,
        connect_args={"sslmode": "require"},
    )

    rows = []

    for device_id in DEVICES:
        try:
            row = fetch_device(device_id)

            if row["bc_880nm"] is None:
                print(f"{device_id}: no Black Carbon value returned")
                continue

            rows.append(row)
            print(
                f"{device_id}: BC={row['bc_880nm']} "
                f"time={row['time_stamp']}"
            )

        except requests.RequestException as error:
            print(f"{device_id}: request failed: {error}")
        except Exception as error:
            print(f"{device_id}: processing failed: {error}")

    written = upsert_rows(engine, rows)
    print(f"C-12 update complete: inserted or updated {written} rows")


if __name__ == "__main__":
    pull_c12_from_grove()
