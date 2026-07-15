import os
from datetime import datetime, timezone

import pandas as pd
import requests
from dotenv import load_dotenv
from sqlalchemy import create_engine, inspect

load_dotenv()

QUANTAQ_API_KEY = os.getenv("QUANTAQ_API_KEY")
DB_URL = os.getenv("DB_URL") or os.getenv("DATABASE_URL")

SENSORS = [
    "MOD-00536",
    "MOD-00745",
    "MOD-00746",
    "MOD-00747",
    "MOD-00748",
    "MOD-00749",
]

BASE_URL = "https://api.quant-aq.com/v1"
TABLE_NAME = "quantaq_master"

if DB_URL and DB_URL.startswith("postgres://"):
    DB_URL = DB_URL.replace("postgres://", "postgresql+psycopg2://", 1)
elif DB_URL and DB_URL.startswith("postgresql://"):
    DB_URL = DB_URL.replace("postgresql://", "postgresql+psycopg2://", 1)


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


def parse_timestamp(value):
    if value is None:
        return datetime.now(timezone.utc)

    parsed = pd.to_datetime(value, utc=True, errors="coerce")
    if pd.isna(parsed):
        return datetime.now(timezone.utc)

    return parsed.to_pydatetime()


def fetch_device_data(sensor_sn):
    headers = {
        "Accept": "application/json",
        "Authorization": requests.auth._basic_auth_str(QUANTAQ_API_KEY, ""),
    }

    dates = pd.date_range(
        end=pd.Timestamp.now(tz="UTC").normalize(),
        periods=2,
        freq="D",
    )

    collected = []

    for date in dates:
        date_text = date.strftime("%Y-%m-%d")
        url = f"{BASE_URL}/devices/{sensor_sn}/data-by-date/{date_text}/"
        response = requests.get(url, headers=headers, timeout=30)

        if response.status_code == 404:
            print(f"No QuantAQ data for {sensor_sn} on {date_text}")
            continue

        response.raise_for_status()
        payload = response.json()
        rows = payload.get("data", payload)

        if isinstance(rows, list):
            collected.extend(row for row in rows if isinstance(row, dict))

    return collected


def normalize_record(sensor_sn, record):
    return {
        "time_stamp": parse_timestamp(
            first_value(
                record,
                "timestamp",
                "time",
                "datetime",
                "date_time",
                "observed_at",
            )
        ),
        "sensor_sn": sensor_sn,
        "pm25": to_float(first_value(record, "pm25", "pm2_5", "pm2.5")),
        "pm10": to_float(first_value(record, "pm10", "pm10_0", "pm10.0")),
        "o3": to_float(first_value(record, "o3", "ozone")),
        "co": to_float(first_value(record, "co", "carbon_monoxide")),
        "no2": to_float(first_value(record, "no2", "nitrogen_dioxide")),
        "lat": to_float(first_value(record, "lat", "latitude")),
        "lon": to_float(first_value(record, "lon", "lng", "longitude")),
    }


def write_records(engine, records):
    if not records:
        return 0

    inspector = inspect(engine)

    if not inspector.has_table(TABLE_NAME):
        raise RuntimeError(
            f"Table '{TABLE_NAME}' does not exist."
        )

    existing_columns = {
        column["name"] for column in inspector.get_columns(TABLE_NAME)
    }

    dataframe = pd.DataFrame(records)
    writable_columns = [
        column for column in dataframe.columns if column in existing_columns
    ]

    required_columns = {"time_stamp", "sensor_sn"}
    missing_required = required_columns - set(writable_columns)

    if missing_required:
        raise RuntimeError(
            "quantaq_master is missing required columns: "
            + ", ".join(sorted(missing_required))
        )

    dataframe = dataframe[writable_columns]

    measurement_columns = [
        column
        for column in ["pm25", "pm10", "o3", "co", "no2"]
        if column in dataframe.columns
    ]

    if measurement_columns:
        dataframe = dataframe.dropna(
            subset=measurement_columns,
            how="all",
        )

    if dataframe.empty:
        return 0

    dataframe = dataframe.drop_duplicates(
        subset=["sensor_sn", "time_stamp"],
        keep="last",
    )

    with engine.begin() as connection:
        dataframe.to_sql(
            TABLE_NAME,
            connection,
            if_exists="append",
            index=False,
            method="multi",
        )

    return len(dataframe)


def pull_and_push():
    if not QUANTAQ_API_KEY:
        raise RuntimeError("Missing QUANTAQ_API_KEY")

    if not DB_URL:
        raise RuntimeError("Missing DB_URL or DATABASE_URL")

    engine = create_engine(
        DB_URL,
        pool_pre_ping=True,
        connect_args={"sslmode": "require"},
    )

    all_records = []

    for sensor_sn in SENSORS:
        try:
            raw_rows = fetch_device_data(sensor_sn)

            if not raw_rows:
                print(f"No recent rows returned for {sensor_sn}")
                continue

            normalized = [
                normalize_record(sensor_sn, record)
                for record in raw_rows
            ]

            valid_count = sum(
                any(
                    row.get(key) is not None
                    for key in ("pm25", "pm10", "o3", "co", "no2")
                )
                for row in normalized
            )

            print(
                f"{sensor_sn}: fetched {len(raw_rows)} rows, "
                f"{valid_count} contain pollutant data"
            )

            all_records.extend(normalized)

        except requests.RequestException as error:
            print(f"QuantAQ request failed for {sensor_sn}: {error}")
        except Exception as error:
            print(f"Processing failed for {sensor_sn}: {error}")

    inserted = write_records(engine, all_records)
    print(f"Database updated: inserted {inserted} QuantAQ rows")


if __name__ == "__main__":
    pull_and_push()
