import pg from "pg";

const { Pool } = pg;

const pool =
  globalThis.cheverlyDbPool ||
  new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    },

    // Keep the free Aiven database from running out of connections.
    max: 1,
    min: 0,
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 10000,
    allowExitOnIdle: true
  });

globalThis.cheverlyDbPool = pool;

export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  try {
    const action = req.query.action;

    const PURPLEAIR_KEY = process.env.PURPLEAIR_API_KEY;
    const QUANTAQ_KEY = process.env.QUANTAQ_API_KEY;
    const GROVE_KEY = process.env.GROVESTREAMS_API_KEY;

    if (!action) {
      return res.status(400).json({
        error: "missing_action"
      });
    }

    const fetchJson = async (url, options = {}) => {
      const response = await fetch(url, options);
      const text = await response.text();

      let data = text;

      try {
        data = JSON.parse(text);
      } catch {
        // Keep plain text when the response is not JSON.
      }

      return {
        ok: response.ok,
        status: response.status,
        data
      };
    };

    // --------------------------------------------------
    // PurpleAir helper
    // --------------------------------------------------

    const purpleairFetch = async (baseUrl) => {
      let output = await fetchJson(baseUrl, {
        headers: {
          "X-API-Key": PURPLEAIR_KEY
        }
      });

      if (output.ok) {
        return output;
      }

      const joinCharacter = baseUrl.includes("?") ? "&" : "?";

      const fallbackUrl =
        `${baseUrl}${joinCharacter}` +
        `api_key=${encodeURIComponent(PURPLEAIR_KEY)}`;

      return await fetchJson(fallbackUrl);
    };

    // --------------------------------------------------
    // PurpleAir: current map readings
    // --------------------------------------------------

    if (action === "purpleair_box") {
      if (!PURPLEAIR_KEY) {
        return res.status(500).json({
          error: "missing_PURPLEAIR_API_KEY"
        });
      }

      const url =
        "https://api.purpleair.com/v1/sensors" +
        "?nwlng=-77.15&nwlat=39.05&selng=-76.75&selat=38.75" +
        "&fields=sensor_index,latitude,longitude,pm2.5_atm";

      const output = await purpleairFetch(url);

      if (!output.ok) {
        return res.status(output.status).json({
          error: "purpleair_box_failed",
          status: output.status,
          details: output.data
        });
      }

      return res.status(200).json(output.data);
    }

    // --------------------------------------------------
    // PurpleAir: station history
    // --------------------------------------------------

    if (action === "purpleair_history") {
      if (!PURPLEAIR_KEY) {
        return res.status(500).json({
          error: "missing_PURPLEAIR_API_KEY"
        });
      }

      const id = req.query.id;
      const start = req.query.start;

      if (!id || !start) {
        return res.status(400).json({
          error: "missing_id_or_start"
        });
      }

      const url =
        `https://api.purpleair.com/v1/sensors/` +
        `${encodeURIComponent(id)}/history` +
        `?fields=pm2.5_atm` +
        `&average=60` +
        `&start_timestamp=${encodeURIComponent(start)}`;

      const output = await purpleairFetch(url);

      if (!output.ok) {
        return res.status(output.status).json({
          error: "purpleair_history_failed",
          status: output.status,
          details: output.data
        });
      }

      return res.status(200).json(output.data);
    }

    // --------------------------------------------------
    // QuantAQ helper functions
    // --------------------------------------------------

    const quantAuthHeaders = () => {
      const auth = Buffer.from(`${QUANTAQ_KEY}:`).toString("base64");

      return {
        Accept: "application/json",
        Authorization: `Basic ${auth}`
      };
    };

    const normalizeSerialNumber = (value) =>
      String(value || "")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "");

    const getQuantDevices = async () => {
      const url =
        "https://api.quant-aq.com/v1/devices" +
        "?per_page=200&page=1";

      return await fetchJson(url, {
        headers: quantAuthHeaders()
      });
    };

    const quantDataByDate = async (serialNumber, date) => {
      const url =
        `https://api.quant-aq.com/v1/devices/` +
        `${encodeURIComponent(serialNumber)}/data-by-date/` +
        `${encodeURIComponent(date)}/`;

      return await fetchJson(url, {
        headers: quantAuthHeaders()
      });
    };

    // --------------------------------------------------
    // QuantAQ: list devices visible to API key
    // --------------------------------------------------

    if (action === "quantaq_devices") {
      if (!QUANTAQ_KEY) {
        return res.status(500).json({
          error: "missing_QUANTAQ_API_KEY"
        });
      }

      const output = await getQuantDevices();

      return res.status(output.status).json(output.data);
    }

    // --------------------------------------------------
    // QuantAQ: live API data by date
    // Kept as a fallback while database routes are tested.
    // --------------------------------------------------

    if (action === "quantaq_by_date") {
      if (!QUANTAQ_KEY) {
        return res.status(500).json({
          error: "missing_QUANTAQ_API_KEY"
        });
      }

      const serialNumberInput = req.query.sn;
      const date = req.query.date;

      if (!serialNumberInput || !date) {
        return res.status(400).json({
          error: "missing_sn_or_date"
        });
      }

      let output = await quantDataByDate(
        serialNumberInput,
        date
      );

      if (output.ok) {
        return res.status(200).json(output.data);
      }

      if (output.status === 404) {
        const devicesOutput = await getQuantDevices();

        if (!devicesOutput.ok) {
          return res.status(devicesOutput.status).json({
            error: "quantaq_devices_list_failed",
            details: devicesOutput.data,
            original_try: {
              sn: serialNumberInput,
              date,
              status: output.status,
              details: output.data
            }
          });
        }

        const devices = Array.isArray(
          devicesOutput.data?.data
        )
          ? devicesOutput.data.data
          : [];

        const target =
          normalizeSerialNumber(serialNumberInput);

        let match = devices.find(
          (device) =>
            normalizeSerialNumber(device?.sn) === target
        );

        if (!match) {
          const looselyNormalize = (value) =>
            normalizeSerialNumber(value)
              .replace(/0+/g, "0")
              .replace(/0([1-9])/g, "$1");

          const looseTarget =
            looselyNormalize(serialNumberInput);

          match = devices.find(
            (device) =>
              looselyNormalize(device?.sn) ===
              looseTarget
          );
        }

        if (match?.sn) {
          const retry = await quantDataByDate(
            match.sn,
            date
          );

          if (retry.ok) {
            return res.status(200).json({
              resolved_sn: match.sn,
              data: retry.data
            });
          }

          return res.status(retry.status).json({
            error: "quantaq_retry_failed",
            resolved_sn: match.sn,
            details: retry.data
          });
        }

        const sampleSerialNumbers = devices
          .slice(0, 15)
          .map((device) => device?.sn)
          .filter(Boolean);

        return res.status(404).json({
          error: "quantaq_sn_not_found_for_key",
          provided_sn: serialNumberInput,
          sample_sns: sampleSerialNumbers,
          total_visible_devices: devices.length
        });
      }

      return res.status(output.status).json({
        error: "quantaq_failed",
        status: output.status,
        details: output.data
      });
    }

    // --------------------------------------------------
    // QuantAQ database: latest stored reading
    // --------------------------------------------------

    if (action === "quantaq_latest") {
      if (!process.env.DATABASE_URL) {
        return res.status(500).json({
          error: "missing_DATABASE_URL"
        });
      }

      const serialNumber = req.query.sn;

      if (!serialNumber) {
        return res.status(400).json({
          error: "missing_sn"
        });
      }

      try {
        const result = await pool.query(
          `
          SELECT
            time_stamp AS timestamp,
            sensor_sn AS sn,
            pm25,
            pm10,
            o3,
            co,
            no2
          FROM quantaq_master
          WHERE sensor_sn = $1
            AND (
              pm25 IS NOT NULL
              OR pm10 IS NOT NULL
              OR o3 IS NOT NULL
              OR co IS NOT NULL
              OR no2 IS NOT NULL
            )
          ORDER BY time_stamp DESC
          LIMIT 1
          `,
          [serialNumber]
        );

        return res.status(200).json({
          sn: serialNumber,
          data: result.rows
        });
      } catch (error) {
        return res.status(500).json({
          error: "quantaq_latest_failed",
          detail: String(error)
        });
      }
    }

    // --------------------------------------------------
    // QuantAQ database: stored history
    // --------------------------------------------------

    if (action === "quantaq_history") {
      if (!process.env.DATABASE_URL) {
        return res.status(500).json({
          error: "missing_DATABASE_URL"
        });
      }

      const serialNumber = req.query.sn;
      const requestedHours = Number(
        req.query.hours || 24
      );

      if (!serialNumber) {
        return res.status(400).json({
          error: "missing_sn"
        });
      }

      const safeHours =
        Number.isFinite(requestedHours) &&
        requestedHours > 0
          ? Math.min(requestedHours, 8760)
          : 24;

      try {
        const result = await pool.query(
          `
          SELECT
            time_stamp AS timestamp,
            sensor_sn AS sn,
            pm25,
            pm10,
            o3,
            co,
            no2
          FROM quantaq_master
          WHERE sensor_sn = $1
            AND time_stamp >=
              NOW() - ($2::text || ' hours')::interval
            AND (
              pm25 IS NOT NULL
              OR pm10 IS NOT NULL
              OR o3 IS NOT NULL
              OR co IS NOT NULL
              OR no2 IS NOT NULL
            )
          ORDER BY time_stamp ASC
          `,
          [serialNumber, safeHours]
        );

        return res.status(200).json({
          sn: serialNumber,
          hours: safeHours,
          data: result.rows
        });
      } catch (error) {
        return res.status(500).json({
          error: "quantaq_history_failed",
          detail: String(error)
        });
      }
    }

// --------------------------------------------------
// QuantAQ database: rolling CE-AQI inputs
// --------------------------------------------------

    if (action === "quantaq_averages") {
      if (!process.env.DATABASE_URL) {
        return res.status(500).json({
          error: "missing_DATABASE_URL"
        });
      }
    
      const serialNumber = req.query.sn;
    
      if (!serialNumber) {
        return res.status(400).json({
          error: "missing_sn"
        });
      }
    
      try {
        const result = await pool.query(
          `
          WITH latest AS (
            SELECT MAX(time_stamp) AS latest_time
            FROM quantaq_master
            WHERE sensor_sn = $1
          ),
    
          sensor_data AS (
            SELECT
              q.time_stamp,
              q.pm25,
              q.pm10,
              q.o3,
              q.co,
              q.no2,
              l.latest_time
            FROM quantaq_master q
            CROSS JOIN latest l
            WHERE q.sensor_sn = $1
              AND q.time_stamp >
                  l.latest_time - INTERVAL '1 year'
              AND q.time_stamp <= l.latest_time
          ),
    
          rolling AS (
            SELECT
              time_stamp,
              latest_time,
    
              AVG(o3) OVER (
                ORDER BY time_stamp
                RANGE BETWEEN INTERVAL '8 hours' PRECEDING
                AND CURRENT ROW
              ) AS o3_8h,
    
              AVG(co) OVER (
                ORDER BY time_stamp
                RANGE BETWEEN INTERVAL '1 hour' PRECEDING
                AND CURRENT ROW
              ) AS co_1h,
    
              AVG(co) OVER (
                ORDER BY time_stamp
                RANGE BETWEEN INTERVAL '8 hours' PRECEDING
                AND CURRENT ROW
              ) AS co_8h,
    
              AVG(no2) OVER (
                ORDER BY time_stamp
                RANGE BETWEEN INTERVAL '1 hour' PRECEDING
                AND CURRENT ROW
              ) AS no2_1h
    
            FROM sensor_data
          )
    
          SELECT
            $1::text AS sn,
    
            AVG(s.pm25) FILTER (
              WHERE s.time_stamp >
                    s.latest_time - INTERVAL '24 hours'
            ) AS pm25_24h,
    
            AVG(s.pm10) FILTER (
              WHERE s.time_stamp >
                    s.latest_time - INTERVAL '24 hours'
            ) AS pm10_24h,
    
            (
              SELECT MAX(r.o3_8h)
              FROM rolling r
              WHERE r.time_stamp >
                    r.latest_time - INTERVAL '24 hours'
            ) AS o3_highest_8h,
    
            (
              SELECT MAX(r.co_1h)
              FROM rolling r
              WHERE r.time_stamp >
                    r.latest_time - INTERVAL '24 hours'
            ) AS co_highest_1h,
    
            (
              SELECT MAX(r.co_8h)
              FROM rolling r
              WHERE r.time_stamp >
                    r.latest_time - INTERVAL '24 hours'
            ) AS co_highest_8h,
    
            (
              SELECT MAX(r.no2_1h)
              FROM rolling r
              WHERE r.time_stamp >
                    r.latest_time - INTERVAL '24 hours'
            ) AS no2_highest_1h,
    
            AVG(s.no2) AS no2_annual_available_average,
    
            MIN(s.time_stamp) AS earliest_record,
    
            MAX(s.time_stamp) AS latest_record,
    
            COUNT(*) AS stored_rows
    
          FROM sensor_data s
          GROUP BY s.latest_time
          `,
          [serialNumber]
        );
    
        return res.status(200).json({
          sn: serialNumber,
          data: result.rows[0] || null
        });
      } catch (error) {
        return res.status(500).json({
          error: "quantaq_averages_failed",
          detail: String(error)
        });
      }
    }

    // --------------------------------------------------
    // GroveStreams/C-12: test historical stream responses
    // --------------------------------------------------
    
    if (action === "grove_history_test") {
      if (!GROVE_KEY) {
        return res.status(500).json({
          error: "missing_GROVESTREAMS_API_KEY"
        });
      }
    
      const componentId = req.query.compId;
      const streamId = req.query.streamId || "880nm";
      const start = req.query.start;
      const end = req.query.end;
    
      if (!componentId || !start || !end) {
        return res.status(400).json({
          error: "missing_compId_start_or_end"
        });
      }
    
      const candidates = [
        {
          name: "stream_feed_sd_ed",
          url:
            `https://grovestreams.com/api/comp/${encodeURIComponent(componentId)}` +
            `/stream/${encodeURIComponent(streamId)}/feed` +
            `?sd=${encodeURIComponent(start)}` +
            `&ed=${encodeURIComponent(end)}` +
            `&api_key=${encodeURIComponent(GROVE_KEY)}`
        },
        {
          name: "stream_feed_start_end",
          url:
            `https://grovestreams.com/api/comp/${encodeURIComponent(componentId)}` +
            `/stream/${encodeURIComponent(streamId)}/feed` +
            `?start=${encodeURIComponent(start)}` +
            `&end=${encodeURIComponent(end)}` +
            `&api_key=${encodeURIComponent(GROVE_KEY)}`
        },
        {
          name: "stream_data",
          url:
            `https://grovestreams.com/api/comp/${encodeURIComponent(componentId)}` +
            `/stream/${encodeURIComponent(streamId)}/data` +
            `?start=${encodeURIComponent(start)}` +
            `&end=${encodeURIComponent(end)}` +
            `&api_key=${encodeURIComponent(GROVE_KEY)}`
        }
      ];
    
      const results = [];
    
      for (const candidate of candidates) {
        try {
          const output = await fetchJson(candidate.url);
    
          results.push({
            name: candidate.name,
            status: output.status,
            ok: output.ok,
            data: output.data
          });
        } catch (error) {
          results.push({
            name: candidate.name,
            error: String(error)
          });
        }
      }
    
      return res.status(200).json({
        componentId,
        streamId,
        start,
        end,
        results
      });
    }
    
    // --------------------------------------------------
    // GroveStreams / C-12: latest readings
    // --------------------------------------------------

    if (action === "grove_last") {
      if (!GROVE_KEY) {
        return res.status(500).json({
          error: "missing_GROVESTREAMS_API_KEY"
        });
      }

      const componentId = req.query.compId;

      if (!componentId) {
        return res.status(400).json({
          error: "missing_compId"
        });
      }

      const url =
        `https://grovestreams.com/api/comp/` +
        `${encodeURIComponent(componentId)}` +
        `/last_value` +
        `?retStreamId` +
        `&api_key=${encodeURIComponent(GROVE_KEY)}`;

      const output = await fetchJson(url);

      if (!output.ok) {
        return res.status(output.status).json({
          error: "grove_last_failed",
          status: output.status,
          details: output.data
        });
      }

      return res.status(200).json(output.data);
    }

    // --------------------------------------------------
    // C-12 database: Black Carbon history
    // --------------------------------------------------

    if (action === "c12_history") {
      if (!process.env.DATABASE_URL) {
        return res.status(500).json({
          error: "missing_DATABASE_URL"
        });
      }

      const componentId = req.query.compId;
      const requestedHours = Number(
        req.query.hours || 18
      );

      if (!componentId) {
        return res.status(400).json({
          error: "missing_compId"
        });
      }

      const safeHours =
        Number.isFinite(requestedHours) &&
        requestedHours > 0
          ? Math.min(requestedHours, 8760)
          : 18;

      try {
        const result = await pool.query(
          `
          SELECT
            time_stamp AS time,
            bc_880nm AS bc,
            latitude,
            longitude,
            device_id
          FROM c12_master
          WHERE device_id = $1
            AND time_stamp >=
              NOW() - ($2::text || ' hours')::interval
            AND bc_880nm IS NOT NULL
          ORDER BY time_stamp ASC
          `,
          [componentId, safeHours]
        );

        return res.status(200).json({
          device_id: componentId,
          hours: safeHours,
          data: result.rows
        });
      } catch (error) {
        return res.status(500).json({
          error: "c12_history_failed",
          detail: String(error)
        });
      }
    }

   // --------------------------------------------------
// C-12 database: available long-term average
// --------------------------------------------------

    if (action === "c12_average") {
      if (!process.env.DATABASE_URL) {
        return res.status(500).json({
          error: "missing_DATABASE_URL"
        });
      }
    
      const componentId = req.query.compId;
    
      if (!componentId) {
        return res.status(400).json({
          error: "missing_compId"
        });
      }
    
      try {
        const result = await pool.query(
          `
          WITH device_data AS (
            SELECT
              time_stamp,
              NULLIF(bc_880nm, '')::double precision AS bc,
              device_id
            FROM c12_master
            WHERE device_id = $1
              AND bc_880nm IS NOT NULL
              AND bc_880nm <> ''
          ),
    
          latest AS (
            SELECT MAX(time_stamp) AS latest_time
            FROM device_data
          )
    
          SELECT
            $1::text AS device_id,
    
            AVG(d.bc) AS bc_available_average,
    
            AVG(d.bc) * 1.25 AS dpm_available_average,
    
            MIN(d.time_stamp) AS earliest_record,
    
            MAX(d.time_stamp) AS latest_record,
    
            COUNT(*) AS stored_rows
    
          FROM device_data d
          CROSS JOIN latest l
          WHERE d.time_stamp >
                l.latest_time - INTERVAL '1 year'
            AND d.time_stamp <= l.latest_time
          `,
          [componentId]
        );
    
        return res.status(200).json({
          device_id: componentId,
          data: result.rows[0] || null
        });
      } catch (error) {
        return res.status(500).json({
          error: "c12_average_failed",
          detail: String(error)
        });
      }
    }

    return res.status(404).json({
      error: "unknown_action",
      action
    });
  } catch (error) {
    return res.status(500).json({
      error: "server_error",
      detail: String(error)
    });
  }
}
