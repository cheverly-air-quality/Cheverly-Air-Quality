import pkg from 'pg';
const { Pool } = pkg;

export const config = { runtime: "nodejs" };

const pool = new Pool({
  connectionString: process.env.DB_URL,
  ssl: { rejectUnauthorized: false }
});

export default async function handler(req, res) {
  try {
    const action = req.query.action;
    if (!action) return res.status(400).json({ error: "missing_action" });

    // ------------------------
    // PurpleAir: map markers (latest reading per station)
    // ------------------------
    if (action === "purpleair_box") {
      const { rows } = await pool.query(`
        SELECT DISTINCT ON (station_id)
          station_id,
          "pm2.5_atm",
          latitude,
          longitude
        FROM purple_air_master
        ORDER BY station_id, time_stamp DESC
      `);

      // Match original shape: { data: [[id, lat, lon, pm25], ...] }
      const data = rows.map(r => [
        r.station_id,
        parseFloat(r.latitude),
        parseFloat(r.longitude),
        parseFloat(r["pm2.5_atm"])
      ]);

      return res.status(200).json({ data });
    }

    // ------------------------
    // PurpleAir: 24h history for a station (or DC reference 156557)
    // ------------------------
    if (action === "purpleair_history") {
      const id = req.query.id;
      const start = req.query.start; // unix seconds
      if (!id || !start) return res.status(400).json({ error: "missing_id_or_start" });

      const startDate = new Date(parseInt(start) * 1000);

      const { rows } = await pool.query(`
        SELECT time_stamp, "pm2.5_atm"
        FROM purple_air_master
        WHERE station_id = $1 AND time_stamp >= $2
        ORDER BY time_stamp ASC
      `, [id, startDate]);

      // Match original shape: { data: [[unix_seconds, pm25], ...] }
      const data = rows.map(r => [
        Math.floor(new Date(r.time_stamp).getTime() / 1000),
        parseFloat(r["pm2.5_atm"])
      ]);

      return res.status(200).json({ data });
    }

    // ------------------------
    // QuantAQ: latest + today's history per device
    // ------------------------
    if (action === "quantaq_by_date") {
      const sn = req.query.sn;
      if (!sn) return res.status(400).json({ error: "missing_sn" });

      const { rows } = await pool.query(`
        SELECT time_stamp, sensor_sn, pm25, pm10, lat, lon
        FROM quantaq_master
        WHERE sensor_sn = $1
          AND time_stamp >= NOW() - INTERVAL '24 hours'
        ORDER BY time_stamp ASC
      `, [sn]);

      // Match original shape: { data: [{timestamp, pm25, pm2_5, ...}, ...] }
      const data = rows.map(r => ({
        timestamp: r.time_stamp,
        pm25: parseFloat(r.pm25),
        pm2_5: parseFloat(r.pm25),
        pm10: parseFloat(r.pm10)
      }));

      return res.status(200).json({ data });
    }

    // ------------------------
    // C12: latest reading per device
    // ------------------------
    if (action === "grove_last") {
      const compId = req.query.compId;
      if (!compId) return res.status(400).json({ error: "missing_compId" });

      const { rows } = await pool.query(`
        SELECT time_stamp, device_id, bc_880nm, latitude, longitude
        FROM c12_master
        WHERE device_id = $1
        ORDER BY time_stamp DESC
        LIMIT 1
      `, [compId]);

      if (!rows.length) return res.status(200).json([]);

      const r = rows[0];

      // Match original shape: [{streamId, data}, ...]
      return res.status(200).json([
        { streamId: "880nm", data: parseFloat(r.bc_880nm) },
        { streamId: "lat",   data: parseFloat(r.latitude) },
        { streamId: "long",  data: parseFloat(r.longitude) }
      ]);
    }

    return res.status(404).json({ error: "unknown_action", action });

  } catch (err) {
    return res.status(500).json({ error: "server_error", detail: String(err) });
  }
}
