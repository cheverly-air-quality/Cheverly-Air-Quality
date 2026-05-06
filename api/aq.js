export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  try {
    const action = req.query.action;

    const PURPLEAIR_KEY = process.env.PURPLEAIR_API_KEY;
    const QUANTAQ_KEY = process.env.QUANTAQ_API_KEY;
    const GROVE_KEY = process.env.GROVESTREAMS_API_KEY;

    if (!action) return res.status(400).json({ error: "missing_action" });

    const fetchJson = async (url, options = {}) => {
      const r = await fetch(url, options);
      const text = await r.text();
      let data = text;
      try { data = JSON.parse(text); } catch {}
      return { ok: r.ok, status: r.status, data };
    };

    // PurpleAir can work either via header or query param depending on endpoint/account
    const purpleairFetch = async (baseUrl) => {
      let out = await fetchJson(baseUrl, { headers: { "X-API-Key": PURPLEAIR_KEY } });
      if (out.ok) return out;

      const join = baseUrl.includes("?") ? "&" : "?";
      const url2 = `${baseUrl}${join}api_key=${encodeURIComponent(PURPLEAIR_KEY)}`;
      return await fetchJson(url2);
    };

    // ------------------------
    // PurpleAir: map marker box query
    // ------------------------
    if (action === "purpleair_box") {
      if (!PURPLEAIR_KEY) return res.status(500).json({ error: "missing_PURPLEAIR_API_KEY" });

      const url =
        "https://api.purpleair.com/v1/sensors" +
        "?nwlng=-77.15&nwlat=39.05&selng=-76.75&selat=38.75" +
        "&fields=sensor_index,latitude,longitude,pm2.5_atm";

      const out = await purpleairFetch(url);

      if (!out.ok) {
        return res.status(out.status).json({
          error: "purpleair_box_failed",
          status: out.status,
          details: out.data
        });
      }

      return res.status(200).json(out.data);
    }

    // ------------------------
    // PurpleAir: history for a station
    // ------------------------
    if (action === "purpleair_history") {
      if (!PURPLEAIR_KEY) return res.status(500).json({ error: "missing_PURPLEAIR_API_KEY" });

      const id = req.query.id;
      const start = req.query.start;
      if (!id || !start) return res.status(400).json({ error: "missing_id_or_start" });

      const url =
        `https://api.purpleair.com/v1/sensors/${encodeURIComponent(id)}/history` +
        `?fields=pm2.5_atm&average=60&start_timestamp=${encodeURIComponent(start)}`;

      const out = await purpleairFetch(url);

      if (!out.ok) {
        return res.status(out.status).json({
          error: "purpleair_history_failed",
          status: out.status,
          details: out.data
        });
      }

      return res.status(200).json(out.data);
    }

    // ------------------------
    // QuantAQ helpers
    // ------------------------
    const quantAuthHeaders = () => {
      const auth = Buffer.from(`${QUANTAQ_KEY}:`).toString("base64");
      return {
        "Accept": "application/json",
        "Authorization": `Basic ${auth}`
      };
    };

    const normSn = (s) => String(s || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");

    const getQuantDevices = async () => {
      const headers = quantAuthHeaders();
      const url = "https://api.quant-aq.com/v1/devices?per_page=200&page=1";
      return await fetchJson(url, { headers });
    };

    if (action === "quantaq_devices") {
      if (!QUANTAQ_KEY) return res.status(500).json({ error: "missing_QUANTAQ_API_KEY" });
      const out = await getQuantDevices();
      return res.status(out.status).json(out.data);
    }

    const quantDataByDate = async (sn, date) => {
      const headers = quantAuthHeaders();
      const url = `https://api.quant-aq.com/v1/devices/${encodeURIComponent(sn)}/data-by-date/${encodeURIComponent(date)}/`;
      return await fetchJson(url, { headers });
    };

    if (action === "quantaq_by_date") {
      if (!QUANTAQ_KEY) return res.status(500).json({ error: "missing_QUANTAQ_API_KEY" });

      const snInput = req.query.sn;
      const date = req.query.date;
      if (!snInput || !date) return res.status(400).json({ error: "missing_sn_or_date" });

      // 1) Try exactly as provided
      let out = await quantDataByDate(snInput, date);
      if (out.ok) return res.status(200).json(out.data);

      // 2) If it's a 404, try resolve serial by listing devices
      if (out.status === 404) {
        const devs = await getQuantDevices();

        if (!devs.ok) {
          return res.status(devs.status).json({
            error: "quantaq_devices_list_failed",
            details: devs.data,
            original_try: { sn: snInput, date, status: out.status, details: out.data }
          });
        }

        const list = Array.isArray(devs.data?.data) ? devs.data.data : [];
        const target = normSn(snInput);

        let match = list.find(d => normSn(d?.sn) === target);

        if (!match) {
          const stripZeros = (x) => normSn(x).replace(/0+/g, "0").replace(/0([1-9])/g, "$1");
          const targetLoose = stripZeros(snInput);
          match = list.find(d => stripZeros(d?.sn) === targetLoose);
        }

        if (match?.sn) {
          const retry = await quantDataByDate(match.sn, date);
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

        const sample = list.slice(0, 15).map(d => d?.sn).filter(Boolean);

        return res.status(404).json({
          error: "quantaq_sn_not_found_for_key",
          provided_sn: snInput,
          hint: "Your QuantAQ key does not see a device with that serial. Use one of the returned sns in your SPODS list.",
          sample_sns: sample,
          total_visible_devices: list.length
        });
      }

      return res.status(out.status).json({
        error: "quantaq_failed",
        status: out.status,
        details: out.data
      });
    }

    // ------------------------
    // GroveStreams (C-12): last values
    // ------------------------
    if (action === "grove_last") {
      if (!GROVE_KEY) return res.status(500).json({ error: "missing_GROVESTREAMS_API_KEY" });

      const compId = req.query.compId;
      if (!compId) return res.status(400).json({ error: "missing_compId" });

      const url =
        `https://grovestreams.com/api/comp/${encodeURIComponent(compId)}/last_value` +
        `?retStreamId&api_key=${encodeURIComponent(GROVE_KEY)}`;

      const out = await fetchJson(url);

      if (!out.ok) {
        return res.status(out.status).json({
          error: "grove_last_failed",
          status: out.status,
          url,
          details: out.data
        });
      }

      // Grove returns an array like [{data, streamId, time}, ...]
      return res.status(200).json(out.data);
    }

    return res.status(404).json({ error: "unknown_action", action });
  } catch (err) {
    return res.status(500).json({ error: "server_error", detail: String(err) });
  }
}
