import os
import time
from datetime import date, datetime, timedelta

import pandas as pd
import requests
from dotenv import load_dotenv
from psycopg2.extras import execute_values
from sqlalchemy import create_engine, text

load_dotenv()

QUANTAQ_API_KEY = os.getenv("QUANTAQ_API_KEY")
DB_URL = os.getenv("DB_URL") or os.getenv("DATABASE_URL")
START_DATE = os.getenv("BACKFILL_START_DATE")
END_DATE = os.getenv("BACKFILL_END_DATE")

SENSORS = [
    "MOD-00536",
    "MOD-00745",
    "MOD-00746",
    "MOD-00747",
    "MOD-00748",
    "MOD-00749",
]

BASE_URL = "https://api.quant-aq.com/v1"
REQUEST_DELAY_SECONDS = 0.35

if DB_URL and DB_URL.startswith("postgres://"):
    DB_URL = DB_URL.replace("postgres://", "postgresql+psycopg2://", 1)
elif DB_URL and DB_URL.startswith("postgresql://"):
    DB_URL = DB_URL.replace("postgresql://", "postgresql+psycopg2://", 1)


def parse_iso_date(value, variable_name):
    if not value:
        raise RuntimeError(f"Missing {variable_name}. Use YYYY-MM-DD.")
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError as exc:
        raise RuntimeError(f"{variable_name} must be YYYY-MM-DD.") from exc


def iter_dates(start, end):
    current = start
    while current <= end:
        yield current
        current += timedelta(days=1)


def first_value(record, *keys):
    for key in keys:
        if key in record and record[key] is not None:
            return record[key]
    return None


def to_float(value):
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def fetch_day(sensor_sn, day):
    url = f"{BASE_URL}/devices/{sensor_sn}/data-by-date/{day.isoformat()}/"
    response = requests.get(
        url,
        auth=(QUANTAQ_API_KEY, ""),
        headers={"Accept": "application/json"},
        timeout=45,
    )

    if response.status_code == 404:
        return []

    response.raise_for_status()
    payload = response.json()
    rows = payload.get("data", payload)
    return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []


def normalize_rows(sensor_sn, rows):
    normalized = []

    for record in rows:
        timestamp = first_value(
            record,
            "timestamp",
            "time",
            "datetime",
            "date_time",
            "observed_at",
        )

        normalized.append(
            {
                "time_stamp": pd.to_datetime(timestamp, utc=True, errors="coerce"),
                "sensor_sn": sensor_sn,
                "pm25": to_float(first_value(record, "pm25", "pm2_5", "pm2.5")),
                "pm10": to_float(first_value(record, "pm10", "pm10_0", "pm10.0")),
                "o3": to_float(first_value(record, "o3", "ozone")),
                "co": to_float(first_value(record, "co", "carbon_monoxide")),
                "no2": to_float(first_value(record, "no2", "nitrogen_dioxide")),
            }
        )

    dataframe = pd.DataFrame(normalized)
    if dataframe.empty:
        return dataframe

    dataframe = dataframe.dropna(subset=["time_stamp"])
    dataframe = dataframe.dropna(
        subset=["pm25", "pm10", "o3", "co", "no2"],
        how="all",
    )
    return dataframe


def hourly_average(dataframe):
    if dataframe.empty:
        return dataframe

    dataframe = dataframe.copy()
    dataframe["time_stamp"] = dataframe["time_stamp"].dt.floor("h")

    return (
        dataframe.groupby(["sensor_sn", "time_stamp"], as_index=False)
        [["pm25", "pm10", "o3", "co", "no2"]]
        .mean(numeric_only=True)
    )


def ensure_unique_index(engine):
    with engine.begin() as connection:
        connection.execute(
            text(
                """
                CREATE UNIQUE INDEX IF NOT EXISTS quantaq_sensor_time_unique
                ON quantaq_master (sensor_sn, time_stamp)
                """
            )
        )


def insert_hourly_rows(engine, dataframe):
    if dataframe.empty:
        return 0

    columns = ["time_stamp", "sensor_sn", "pm25", "pm10", "o3", "co", "no2"]
    values = []

    for row in dataframe[columns].itertuples(index=False, name=None):
        cleaned = []
        for value in row:
            if pd.isna(value):
                cleaned.append(None)
            elif isinstance(value, pd.Timestamp):
                cleaned.append(value.to_pydatetime())
            else:
                cleaned.append(value)
        values.append(tuple(cleaned))

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
            execute_values(cursor, sql, values, page_size=500)
        raw_connection.commit()
    finally:
        raw_connection.close()

    return len(values)


def main():
    if not QUANTAQ_API_KEY:
        raise RuntimeError("Missing QUANTAQ_API_KEY GitHub secret.")
    if not DB_URL:
        raise RuntimeError("Missing DB_URL GitHub secret.")

    start_date = parse_iso_date(START_DATE, "BACKFILL_START_DATE")
    end_date = parse_iso_date(END_DATE, "BACKFILL_END_DATE")

    if end_date < start_date:
        raise RuntimeError("BACKFILL_END_DATE must be on or after BACKFILL_START_DATE.")

    day_count = (end_date - start_date).days + 1
    if day_count > 31:
        raise RuntimeError("Run no more than 31 days at a time.")

    engine = create_engine(
        DB_URL,
        pool_pre_ping=True,
        connect_args={"sslmode": "require"},
    )
    ensure_unique_index(engine)

    total_inserted = 0

    for sensor_sn in SENSORS:
        for day in iter_dates(start_date, end_date):
            try:
                raw_rows = fetch_day(sensor_sn, day)
                normalized = normalize_rows(sensor_sn, raw_rows)
                hourly = hourly_average(normalized)
                inserted = insert_hourly_rows(engine, hourly)
                total_inserted += inserted

                print(
                    f"{sensor_sn} {day.isoformat()}: "
                    f"{len(raw_rows)} raw rows -> {inserted} hourly rows"
                )
            except requests.RequestException as error:
                print(f"{sensor_sn} {day.isoformat()}: request failed: {error}")
            except Exception as error:
                print(f"{sensor_sn} {day.isoformat()}: failed: {error}")

            time.sleep(REQUEST_DELAY_SECONDS)

    print(
        f"Backfill complete for {start_date} through {end_date}. "
        f"Inserted or updated {total_inserted} hourly rows."
    )


if __name__ == "__main__":
    main()
