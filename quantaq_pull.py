import os
import pandas as pd
import requests
from dotenv import load_dotenv
from psycopg2.extras import execute_values
from sqlalchemy import create_engine

load_dotenv()

QUANTAQ_API_KEY = os.getenv("QUANTAQ_API_KEY")
DB_URL = os.getenv("DB_URL") or os.getenv("DATABASE_URL")
SENSORS = ["MOD-00536", "MOD-00745", "MOD-00746", "MOD-00747", "MOD-00748", "MOD-00749"]
BASE_URL = "https://api.quant-aq.com/v1"

if DB_URL and DB_URL.startswith("postgres://"):
    DB_URL = DB_URL.replace("postgres://", "postgresql+psycopg2://", 1)
elif DB_URL and DB_URL.startswith("postgresql://"):
    DB_URL = DB_URL.replace("postgresql://", "postgresql+psycopg2://", 1)


def to_float(value):
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def fetch_recent(sensor_sn):
    today = pd.Timestamp.now(tz="UTC").strftime("%Y-%m-%d")
    url = f"{BASE_URL}/devices/{sensor_sn}/data-by-date/{today}/"
    response = requests.get(url, auth=(QUANTAQ_API_KEY, ""), headers={"Accept": "application/json"}, timeout=45)
    if response.status_code == 404:
        return []
    response.raise_for_status()
    payload = response.json()
    rows = payload.get("data", payload)
    return rows if isinstance(rows, list) else []


def normalize(sensor_sn, rows):
    output = []
    for row in rows:
        timestamp = pd.to_datetime(row.get("timestamp"), utc=True, errors="coerce")
        if pd.isna(timestamp):
            continue
        values = {
            "time_stamp": timestamp.to_pydatetime(),
            "sensor_sn": sensor_sn,
            "pm25": to_float(row.get("pm25")),
            "pm10": to_float(row.get("pm10")),
            "o3": to_float(row.get("o3")),
            "co": to_float(row.get("co")),
            "no2": to_float(row.get("no2")),
        }
        if all(values[k] is None for k in ("pm25", "pm10", "o3", "co", "no2")):
            continue
        output.append(values)
    return output


def upsert_rows(engine, rows):
    if not rows:
        return 0
    values = [(r["time_stamp"], r["sensor_sn"], r["pm25"], r["pm10"], r["o3"], r["co"], r["no2"]) for r in rows]
    sql = """
        INSERT INTO quantaq_master
            (time_stamp, sensor_sn, pm25, pm10, o3, co, no2)
        VALUES %s
        ON CONFLICT (sensor_sn, time_stamp)
        DO UPDATE SET
            pm25 = EXCLUDED.pm25,
            pm10 = EXCLUDED.pm10,
            o3 = EXCLUDED.o3,
            co = EXCLUDED.co,
            no2 = EXCLUDED.no2
    """
    raw_connection = engine.raw_connection()
    try:
        with raw_connection.cursor() as cursor:
            execute_values(cursor, sql, values, page_size=1000)
        raw_connection.commit()
    finally:
        raw_connection.close()
    return len(values)


def main():
    if not QUANTAQ_API_KEY:
        raise RuntimeError("Missing QUANTAQ_API_KEY")
    if not DB_URL:
        raise RuntimeError("Missing DB_URL or DATABASE_URL")

    engine = create_engine(DB_URL, pool_pre_ping=True, connect_args={"sslmode": "require"})
    total = 0
    for sensor_sn in SENSORS:
        try:
            raw_rows = fetch_recent(sensor_sn)
            normalized_rows = normalize(sensor_sn, raw_rows)
            written = upsert_rows(engine, normalized_rows)
            total += written
            print(f"{sensor_sn}: fetched {len(raw_rows)} rows, inserted or updated {written}")
        except Exception as error:
            print(f"{sensor_sn}: failed: {error}")
    print(f"QuantAQ hourly update complete: {total} rows inserted or updated")


if __name__ == "__main__":
    main()
