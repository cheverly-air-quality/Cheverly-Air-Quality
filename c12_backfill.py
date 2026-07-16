import os
import time
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pandas as pd
import requests
from dotenv import load_dotenv
from psycopg2.extras import execute_values
from sqlalchemy import create_engine, text

load_dotenv()

GROVESTREAMS_API_KEY = os.getenv("GROVESTREAMS_API_KEY")
DB_URL = os.getenv("DB_URL") or os.getenv("DATABASE_URL")
START_DATE = os.getenv("BACKFILL_START_DATE")
END_DATE = os.getenv("BACKFILL_END_DATE")

DEVICES = ["D14781", "D14645", "D17615", "E10588", "D14646"]
BASE_URL = "https://grovestreams.com/api"
STREAM_ID = "880nm"
EASTERN = ZoneInfo("America/New_York")

if DB_URL and DB_URL.startswith("postgres://"):
    DB_URL = DB_URL.replace("postgres://", "postgresql+psycopg2://", 1)
elif DB_URL and DB_URL.startswith("postgresql://"):
    DB_URL = DB_URL.replace("postgresql://", "postgresql+psycopg2://", 1)


def parse_date(value, name):
    if not value:
        raise RuntimeError(f"Missing {name}. Use YYYY-MM-DD.")
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError as exc:
        raise RuntimeError(f"{name} must be YYYY-MM-DD.") from exc


def iter_dates(start_date, end_date):
    current = start_date
    while current <= end_date:
        yield current
        current += timedelta(days=1)


def to_float(value):
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def local_day_to_utc_ms(day):
    """
    Interpret the requested date as an Eastern calendar day and convert its
    boundaries to UTC epoch milliseconds for GroveStreams.
    This handles EST/EDT correctly, rather than always subtracting four hours.
    """
    local_start = datetime(day.year, day.month, day.day, tzinfo=EASTERN)
    local_end = local_start + timedelta(days=1)

    utc_start = local_start.astimezone(timezone.utc)
    utc_end = local_end.astimezone(timezone.utc)

    return (
        int(utc_start.timestamp() * 1000),
        int(utc_end.timestamp() * 1000),
    )


def fetch_day(device_id, day):
    start_ms, end_ms = local_day_to_utc_ms(day)

    url = f"{BASE_URL}/comp/{device_id}/stream/{STREAM_ID}/feed"
    params = {
        "sd": start_ms,
        "ed": end_ms,
        "api_key": GROVESTREAMS_API_KEY,
    }

    response = requests.get(url, params=params, timeout=60)

    if response.status_code == 404:
        return []

    response.raise_for_status()
    payload = response.json()

    return payload if isinstance(payload, list) else []


def normalize_hourly(device_id, rows):
    normalized = []

    for row in rows:
        value = to_float(row.get("data"))
        time_ms = row.get("time")

        if value is None or time_ms is None:
            continue

        try:
            utc_time = datetime.fromtimestamp(float(time_ms) / 1000.0, tz=timezone.utc)
        except (TypeError, ValueError, OSError):
            continue

        # Match the existing C-12 table, which stores Eastern local clock time.
        local_time = utc_time.astimezone(EASTERN).replace(tzinfo=None)

        normalized.append({
            "device_id": device_id,
            "time_stamp": local_time,
            "bc_880nm": value,
        })

    df = pd.DataFrame(normalized)

    if df.empty:
        return df

    df["time_stamp"] = pd.to_datetime(df["time_stamp"]).dt.floor("h")

    return (
        df.groupby(["device_id", "time_stamp"], as_index=False)
        ["bc_880nm"]
        .mean()
    )


def ensure_unique_index(engine):
    with engine.begin() as connection:
        connection.execute(text("""
            CREATE UNIQUE INDEX IF NOT EXISTS c12_device_time_unique
            ON c12_master (device_id, time_stamp)
        """))


def upsert_rows(engine, dataframe):
    if dataframe.empty:
        return 0

    values = [
        (
            row.device_id,
            row.time_stamp.to_pydatetime()
            if isinstance(row.time_stamp, pd.Timestamp)
            else row.time_stamp,
            float(row.bc_880nm),
        )
        for row in dataframe.itertuples(index=False)
    ]

    sql = """
        INSERT INTO c12_master
            (device_id, time_stamp, bc_880nm)
        VALUES %s
        ON CONFLICT (device_id, time_stamp)
        DO UPDATE SET
            bc_880nm = EXCLUDED.bc_880nm
    """

    raw_connection = engine.raw_connection()

    try:
        with raw_connection.cursor() as cursor:
            execute_values(cursor, sql, values, page_size=500)
        raw_connection.commit()
    finally:
        raw_connection.close()

    return len(values)


def main():
    if not GROVESTREAMS_API_KEY:
        raise RuntimeError("Missing GROVESTREAMS_API_KEY GitHub secret.")

    if not DB_URL:
        raise RuntimeError("Missing DB_URL GitHub secret.")

    start_date = parse_date(START_DATE, "BACKFILL_START_DATE")
    end_date = parse_date(END_DATE, "BACKFILL_END_DATE")

    day_count = (end_date - start_date).days + 1

    if day_count < 1 or day_count > 31:
        raise RuntimeError("Backfill must cover between 1 and 31 days per run.")

    engine = create_engine(
        DB_URL,
        pool_pre_ping=True,
        connect_args={"sslmode": "require"},
    )

    ensure_unique_index(engine)

    total = 0

    for device_id in DEVICES:
        for day in iter_dates(start_date, end_date):
            try:
                raw_rows = fetch_day(device_id, day)
                hourly_rows = normalize_hourly(device_id, raw_rows)
                written = upsert_rows(engine, hourly_rows)
                total += written

                print(
                    f"{device_id} {day.isoformat()}: "
                    f"{len(raw_rows)} raw rows -> {written} hourly rows"
                )
            except requests.RequestException as error:
                print(f"{device_id} {day.isoformat()}: request failed: {error}")
            except Exception as error:
                print(f"{device_id} {day.isoformat()}: failed: {error}")

            time.sleep(0.35)

    print(f"C-12 backfill complete. Inserted or updated {total} hourly rows.")


if __name__ == "__main__":
    main()
