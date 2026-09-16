import { sendPushToAll, redis } from "./push-lib.js";

export default async function handler(req, res) {
  const API_KEY = process.env.TWELVE_DATA_API_KEY;

  if (!API_KEY) {
    return res.status(500).json({
      ok: false,
      error: "TWELVE_DATA_API_KEY belum diset"
    });
  }

  const CFG = {
    symbol: "XAU/USD",

    m5Size: 1500,
    m15Size: 500,
    h1Size: 300,

    cacheTTL: 60_000,
    priceTTL: 15_000,

    minM5: 250,
    minM15: 100,
    minH1: 210,

    srLookback: 80,
    srSwingStrength: 2,
    srMaxLevels: 12,
    srATRMultiplier: 0.50,
    srMinDistance: 2.0,

    reversalZoneMultiplier: 1.0,

    minTargetR: 1.0,

    requireValidSRTarget: true,

    tradeLockTTL: 21600,

    /*
     * ==========================================================
     * REDIS CACHE
     * ==========================================================
     *
     * Redis digunakan sebagai persistent fallback.
     *
     * globalThis cache masih digunakan untuk cache pantas
     * dalam Vercel instance yang sama.
     *
     * Redis digunakan apabila:
     *
     * - Twelve Data limit
     * - Twelve Data error
     * - Vercel instance restart
     * - globalThis cache kosong
     */

    redisCacheTTL: 86400 * 7,

    redisKeys: {
      m5: "xau_scalp_cache_m5",
      m15: "xau_scalp_cache_m15",
      h1: "xau_scalp_cache_h1",
      price: "xau_scalp_cache_price"
    }
  };

  /*
   * ============================================================
   * LOCAL MEMORY CACHE
   * ============================================================
   */

  globalThis.__XAU_SCALP_CACHE__ ??= {
    candles: {},
    price: null,
    priceAt: 0,

    dataSource: {
      m5: "NONE",
      m15: "NONE",
      h1: "NONE",
      price: "NONE"
    },

    cacheAt: {
      m5: 0,
      m15: 0,
      h1: 0,
      price: 0
    }
  };

  const C = globalThis.__XAU_SCALP_CACHE__;
  const now = Date.now();

  /*
   * ============================================================
   * HELPERS
   * ============================================================
   */

  const avg = a =>
    a.length
      ? a.reduce((x, y) => x + y, 0) / a.length
      : null;

  const clamp = (n, a, b) =>
    Math.max(a, Math.min(b, n));

  /*
   * Safe Redis GET
   */
  async function redisGet(key) {
    try {
      const value = await redis.get(key);
      return value;
    } catch (e) {
      console.error(
        `Redis GET error [${key}]:`,
        e?.message || e
      );

      return null;
    }
  }

  /*
   * Safe Redis SET
   */
  async function redisSet(key, value, ttl) {
    try {
      await redis.set(
        key,
        JSON.stringify(value),
        {
          ex: ttl
        }
      );

      return true;
    } catch (e) {
      console.error(
        `Redis SET error [${key}]:`,
        e?.message || e
      );

      return false;
    }
  }

  /*
   * Redis boleh return object atau string
   */
  function parseRedisValue(value) {
    if (value == null) {
      return null;
    }

    if (
      typeof value === "object"
    ) {
      return value;
    }

    if (
      typeof value === "string"
    ) {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    }

    return null;
  }

  /*
   * ============================================================
   * TECHNICAL INDICATORS
   * ============================================================
   */

  function ema(v, p) {
    if (v.length < p) return null;

    const k = 2 / (p + 1);

    let e = avg(
      v.slice(0, p)
    );

    for (
      let i = p;
      i < v.length;
      i++
    ) {
      e =
        v[i] * k +
        e * (1 - k);
    }

    return e;
  }

  function rsi(v, p = 14) {
    if (
      v.length <
      p + 1
    ) {
      return null;
    }

    let gains = 0;
    let losses = 0;

    for (
      let i = v.length - p;
      i < v.length;
      i++
    ) {
      const d =
        v[i] -
        v[i - 1];

      if (d > 0) {
        gains += d;
      } else {
        losses -= d;
      }
    }

    if (
      losses === 0
    ) {
      return 100;
    }

    const rs =
      (gains / p) /
      (losses / p);

    return (
      100 -
      100 / (1 + rs)
    );
  }

  function atr(d, p = 14) {
    if (
      d.length <
      p + 1
    ) {
      return null;
    }

    const tr = [];

    for (
      let i = 1;
      i < d.length;
      i++
    ) {
      const c = d[i];
      const pc =
        d[i - 1].close;

      tr.push(
        Math.max(
          c.high - c.low,
          Math.abs(
            c.high - pc
          ),
          Math.abs(
            c.low - pc
          )
        )
      );
    }

    return avg(
      tr.slice(-p)
    );
  }

  function macd(v) {
    if (
      v.length < 35
    ) {
      return null;
    }

    const e12 =
      ema(v, 12);

    const e26 =
      ema(v, 26);

    if (
      e12 == null ||
      e26 == null
    ) {
      return null;
    }

    const line =
      e12 - e26;

    const lines = [];

    for (
      let i = 26;
      i <= v.length;
      i++
    ) {
      const a =
        ema(
          v.slice(0, i),
          12
        );

      const b =
        ema(
          v.slice(0, i),
          26
        );

      if (
        a != null &&
        b != null
      ) {
        lines.push(
          a - b
        );
      }
    }

    const signal =
      ema(lines, 9);

    if (
      signal == null
    ) {
      return null;
    }

    return {
      line,
      signal,
      histogram:
        line - signal,

      bullish:
        line > signal,

      bearish:
        line < signal
    };
  }

  function structure(
    d,
    lookback = 20
  ) {
    if (
      d.length <
      lookback * 2
    ) {
      return {
        bullish: false,
        bearish: false,
        high: null,
        low: null,
        previousHigh: null,
        previousLow: null
      };
    }

    const r =
      d.slice(-lookback);

    const p =
      d.slice(
        -lookback * 2,
        -lookback
      );

    const last =
      d.at(-1);

    const high =
      Math.max(
        ...r.map(
          x => x.high
        )
      );

    const low =
      Math.min(
        ...r.map(
          x => x.low
        )
      );

    const previousHigh =
      Math.max(
        ...p.map(
          x => x.high
        )
      );

    const previousLow =
      Math.min(
        ...p.map(
          x => x.low
        )
      );

    return {
      bullish:
        last.close >
        previousHigh,

      bearish:
        last.close <
        previousLow,

      high,
      low,
      previousHigh,
      previousLow
    };
  }

  function bos(
    d,
    lookback = 10
  ) {
    if (
      d.length <
      lookback + 2
    ) {
      return {
        bullish: false,
        bearish: false
      };
    }

    const last =
      d.at(-1);

    const p =
      d.slice(
        -lookback - 1,
        -1
      );

    return {
      bullish:
        last.close >
        Math.max(
          ...p.map(
            x => x.high
          )
        ),

      bearish:
        last.close <
        Math.min(
          ...p.map(
            x => x.low
          )
        )
    };
  }

  function choch(
    d,
    lookback = 8
  ) {
    if (
      d.length <
      lookback * 2 + 2
    ) {
      return {
        bullish: false,
        bearish: false
      };
    }

    const r =
      d.slice(-lookback);

    const p =
      d.slice(
        -lookback * 2,
        -lookback
      );

    const last =
      d.at(-1);

    const rh =
      Math.max(
        ...r.map(
          x => x.high
        )
      );

    const rl =
      Math.min(
        ...r.map(
          x => x.low
        )
      );

    const ph =
      Math.max(
        ...p.map(
          x => x.high
        )
      );

    const pl =
      Math.min(
        ...p.map(
          x => x.low
        )
      );

    return {
      bullish:
        rh > ph &&
        last.close > ph,

      bearish:
        rl < pl &&
        last.close < pl
    };
  }

  function sweep(
    d,
    lookback = 10
  ) {
    if (
      d.length <
      lookback + 2
    ) {
      return {
        bullish: false,
        bearish: false
      };
    }

    const c =
      d.at(-1);

    const p =
      d.slice(
        -lookback - 1,
        -1
      );

    const h =
      Math.max(
        ...p.map(
          x => x.high
        )
      );

    const l =
      Math.min(
        ...p.map(
          x => x.low
        )
      );

    return {
      bullish:
        c.low < l &&
        c.close > l,

      bearish:
        c.high > h &&
        c.close < h
    };
  }

  function momentum(d) {
    const c =
      d.at(-1);

    if (!c) {
      return {
        bullish: false,
        bearish: false,
        strength: 0
      };
    }

    const range =
      c.high -
      c.low ||
      1e-9;

    const ratio =
      Math.abs(
        c.close -
        c.open
      ) / range;

    return {
      bullish:
        c.close >
          c.open &&
        ratio >= 0.45,

      bearish:
        c.close <
          c.open &&
        ratio >= 0.45,

      strength:
        Math.round(
          ratio * 100
        )
    };
  }

  /*
   * ============================================================
   * H1 SUPPORT / RESISTANCE
   * ============================================================
   */

  function findH1SupportResistance(
    data,
    price,
    h1ATR
  ) {
    const source =
      data.slice(
        -CFG.srLookback
      );

    if (
      source.length < 20
    ) {
      return {
        support: null,
        resistance: null,
        levels: [],
        supportDistance: null,
        resistanceDistance: null,
        threshold: null,
        reversalThreshold: null,
        position: "UNKNOWN",
        zone: "UNKNOWN",
        nearSupport: false,
        nearResistance: false,
        atSupport: false,
        atResistance: false,
        signalContext:
          "NO S/R DATA"
      };
    }

    const levels = [];

    /*
     * Swing highs
     */
    for (
      let i =
        CFG.srSwingStrength;
      i <
        source.length -
          CFG.srSwingStrength;
      i++
    ) {
      const c =
        source[i];

      let isHigh = true;

      for (
        let j = 1;
        j <=
          CFG.srSwingStrength;
        j++
      ) {
        if (
          c.high <=
            source[i - j]
              .high ||
          c.high <=
            source[i + j]
              .high
        ) {
          isHigh = false;
          break;
        }
      }

      if (isHigh) {
        levels.push({
          price: c.high,
          type:
            "RESISTANCE"
        });
      }
    }

    /*
     * Swing lows
     */
    for (
      let i =
        CFG.srSwingStrength;
      i <
        source.length -
          CFG.srSwingStrength;
      i++
    ) {
      const c =
        source[i];

      let isLow = true;

      for (
        let j = 1;
        j <=
          CFG.srSwingStrength;
        j++
      ) {
        if (
          c.low >=
            source[i - j]
              .low ||
          c.low >=
            source[i + j]
              .low
        ) {
          isLow = false;
          break;
        }
      }

      if (isLow) {
        levels.push({
          price: c.low,
          type: "SUPPORT"
        });
      }
    }

    /*
     * Extreme high
     */
    levels.push({
      price:
        Math.max(
          ...source.map(
            x => x.high
          )
        ),

      type:
        "RESISTANCE"
    });

    /*
     * Extreme low
     */
    levels.push({
      price:
        Math.min(
          ...source.map(
            x => x.low
          )
        ),

      type:
        "SUPPORT"
    });

    /*
     * Group nearby levels
     */
    const grouped = [];

    const groupingDistance =
      Math.max(
        (h1ATR || 10) *
          0.20,
        1.5
      );

    for (
      const level of levels
    ) {
      const existing =
        grouped.find(
          x =>
            x.type ===
              level.type &&
            Math.abs(
              x.price -
                level.price
            ) <=
              groupingDistance
        );

      if (existing) {
        existing.prices.push(
          level.price
        );

        existing.touches += 1;

        existing.price =
          existing.prices.reduce(
            (a, b) =>
              a + b,
            0
          ) /
          existing.prices
            .length;
      } else {
        grouped.push({
          type:
            level.type,

          price:
            level.price,

          prices: [
            level.price
          ],

          touches: 1
        });
      }
    }

    const supports =
      grouped
        .filter(
          x =>
            x.type ===
              "SUPPORT" &&
            x.price < price
        )
        .sort(
          (a, b) =>
            b.price -
            a.price
        );

    const resistances =
      grouped
        .filter(
          x =>
            x.type ===
              "RESISTANCE" &&
            x.price > price
        )
        .sort(
          (a, b) =>
            a.price -
            b.price
        );

    const support =
      supports[0] ||
      null;

    const resistance =
      resistances[0] ||
      null;

    const supportDistance =
      support
        ? price -
          support.price
        : null;

    const resistanceDistance =
      resistance
        ? resistance.price -
          price
        : null;

    const threshold =
      Math.max(
        (h1ATR || 10) *
          CFG.srATRMultiplier,
        CFG.srMinDistance
      );

    const reversalThreshold =
      threshold *
      CFG.reversalZoneMultiplier;

    const nearSupport =
      supportDistance !=
        null &&
      supportDistance <=
        threshold;

    const nearResistance =
      resistanceDistance !=
        null &&
      resistanceDistance <=
        threshold;

    const atSupport =
      supportDistance !=
        null &&
      supportDistance <=
        threshold * 0.35;

    const atResistance =
      resistanceDistance !=
        null &&
      resistanceDistance <=
        threshold * 0.35;

    const reversalAtSupport =
      supportDistance !=
        null &&
      supportDistance <=
        reversalThreshold;

    const reversalAtResistance =
      resistanceDistance !=
        null &&
      resistanceDistance <=
        reversalThreshold;

    let position =
      "BETWEEN S/R";

    let zone =
      "NEUTRAL";

    if (atSupport) {
      position =
        "AT SUPPORT";

      zone =
        "SUPPORT";
    } else if (
      atResistance
    ) {
      position =
        "AT RESISTANCE";

      zone =
        "RESISTANCE";
    } else if (
      nearSupport &&
      nearResistance
    ) {
      position =
        "BETWEEN S/R";

      zone =
        "TIGHT RANGE";
    } else if (
      nearSupport
    ) {
      position =
        "NEAR SUPPORT";

      zone =
        "SUPPORT";
    } else if (
      nearResistance
    ) {
      position =
        "NEAR RESISTANCE";

      zone =
        "RESISTANCE";
    }

    let signalContext =
      "NO S/R WARNING";

    if (
      nearResistance
    ) {
      signalContext =
        "RESISTANCE NEARBY";
    }

    if (
      nearSupport
    ) {
      signalContext =
        "SUPPORT NEARBY";
    }

    if (
      nearSupport &&
      nearResistance
    ) {
      signalContext =
        "TIGHT S/R RANGE";
    }

    return {
      support:
        support
          ? {
              price:
                Number(
                  support.price.toFixed(
                    2
                  )
                ),

              strength:
                support.touches
            }
          : null,

      resistance:
        resistance
          ? {
              price:
                Number(
                  resistance.price.toFixed(
                    2
                  )
                ),

              strength:
                resistance.touches
            }
          : null,

      levels:
        grouped
          .sort(
            (a, b) =>
              Math.abs(
                a.price -
                  price
              ) -
              Math.abs(
                b.price -
                  price
              )
          )
          .slice(
            0,
            CFG.srMaxLevels
          )
          .map(x => ({
            price:
              Number(
                x.price.toFixed(
                  2
                )
              ),

            type:
              x.type,

            strength:
              x.touches
          })),

      supportDistance:
        supportDistance !=
        null
          ? Number(
              supportDistance.toFixed(
                2
              )
            )
          : null,

      resistanceDistance:
        resistanceDistance !=
        null
          ? Number(
              resistanceDistance.toFixed(
                2
              )
            )
          : null,

      supportDistancePct:
        supportDistance !=
        null
          ? Number(
              (
                supportDistance /
                price *
                100
              ).toFixed(3)
            )
          : null,

      resistanceDistancePct:
        resistanceDistance !=
        null
          ? Number(
              (
                resistanceDistance /
                price *
                100
              ).toFixed(3)
            )
          : null,

      threshold:
        Number(
          threshold.toFixed(
            2
          )
        ),

      reversalThreshold:
        Number(
          reversalThreshold.toFixed(
            2
          )
        ),

      position,
      zone,

      nearSupport,
      nearResistance,

      atSupport,
      atResistance,

      reversalAtSupport,
      reversalAtResistance,

      signalContext
    };
  }

  /*
   * ============================================================
   * TWELVE DATA + PERSISTENT CACHE
   * ============================================================
   */

  async function series(
    interval,
    outputsize,
    key
  ) {
    /*
     * ----------------------------------------------------------
     * 1. LOCAL MEMORY CACHE
     * ----------------------------------------------------------
     */

    const localCache =
      C.candles[key];

    if (
      localCache &&
      now -
        localCache.at <
        CFG.cacheTTL
    ) {
      C.dataSource[key] =
        "LOCAL_CACHE";

      return localCache.data;
    }

    /*
     * ----------------------------------------------------------
     * 2. TRY TWELVE DATA
     * ----------------------------------------------------------
     */

    try {
      const controller =
        new AbortController();

      const timeout =
        setTimeout(
          () =>
            controller.abort(),
          10_000
        );

      const url =
        `https://api.twelvedata.com/time_series` +
        `?symbol=${encodeURIComponent(
          CFG.symbol
        )}` +
        `&interval=${interval}` +
        `&outputsize=${outputsize}` +
        `&apikey=${API_KEY}`;

      const r =
        await fetch(
          url,
          {
            signal:
              controller.signal
          }
        );

      clearTimeout(
        timeout
      );

      const j =
        await r.json();

      if (
        !r.ok ||
        j.status ===
          "error"
      ) {
        throw new Error(
          j.message ||
            `Twelve Data ${interval} error`
        );
      }

      const data =
        (j.values || [])
          .reverse()
          .map(x => ({
            time:
              x.datetime,

            open:
              +x.open,

            high:
              +x.high,

            low:
              +x.low,

            close:
              +x.close,

            volume:
              +x.volume || 0
          }))
          .filter(x =>
            [
              x.open,
              x.high,
              x.low,
              x.close
            ].every(
              Number.isFinite
            )
          );

      const minRequired =
        {
          "5min":
            CFG.minM5,

          "15min":
            CFG.minM15,

          "1h":
            CFG.minH1
        }[interval];

      if (
        data.length <
        minRequired
      ) {
        throw new Error(
          `Data ${interval} tak cukup: ${data.length}`
        );
      }

      /*
       * --------------------------------------------------------
       * LIVE DATA BERJAYA
       * --------------------------------------------------------
       */

      const savedAt =
        Date.now();

      C.candles[key] = {
        at: savedAt,
        data
      };

      C.dataSource[key] =
        "TWELVE_DATA";

      C.cacheAt[key] =
        savedAt;

      /*
       * --------------------------------------------------------
       * SIMPAN KE REDIS
       * --------------------------------------------------------
       */

      await redisSet(
        CFG.redisKeys[key],
        {
          savedAt,
          interval,
          outputsize,
          data
        },
        CFG.redisCacheTTL
      );

      return data;

    } catch (apiError) {
      console.error(
        `Twelve Data ${interval} failed:`,
        apiError?.message ||
          apiError
      );

      /*
       * --------------------------------------------------------
       * 3. FALLBACK REDIS
       * --------------------------------------------------------
       */

      const redisRaw =
        await redisGet(
          CFG.redisKeys[key]
        );

      const redisCache =
        parseRedisValue(
          redisRaw
        );

      if (
        redisCache?.data &&
        Array.isArray(
          redisCache.data
        ) &&
        redisCache.data.length
      ) {
        const minRequired =
          {
            "5min":
              CFG.minM5,

            "15min":
              CFG.minM15,

            "1h":
              CFG.minH1
          }[interval];

        if (
          redisCache.data.length >=
          minRequired
        ) {
          /*
           * Masukkan Redis cache
           * ke local memory juga.
           */

          C.candles[key] = {
            at:
              redisCache.savedAt ||
              Date.now(),

            data:
              redisCache.data
          };

          C.dataSource[key] =
            "REDIS_CACHE";

          C.cacheAt[key] =
            redisCache.savedAt ||
            Date.now();

          return redisCache.data;
        }
      }

      /*
       * --------------------------------------------------------
       * 4. LAST LOCAL CACHE
       * --------------------------------------------------------
       *
       * Walaupun TTL local sudah expired,
       * masih boleh digunakan sebagai emergency fallback.
       */

      if (
        localCache?.data &&
        Array.isArray(
          localCache.data
        ) &&
        localCache.data.length
      ) {
        C.dataSource[key] =
          "STALE_LOCAL_CACHE";

        return localCache.data;
      }

      /*
       * --------------------------------------------------------
       * 5. TIADA CACHE
       * --------------------------------------------------------
       */

      throw new Error(
        `${interval}: Twelve Data gagal dan cache terakhir tidak tersedia. ` +
        `${apiError?.message || ""}`
      );
    }
  }

  /*
   * ============================================================
   * LIVE PRICE + REDIS FALLBACK
   * ============================================================
   */

  async function getLivePrice() {
    /*
     * ----------------------------------------------------------
     * LOCAL PRICE CACHE
     * ----------------------------------------------------------
     */

    if (
      C.price != null &&
      now -
        C.priceAt <
        CFG.priceTTL
    ) {
      C.dataSource.price =
        "LOCAL_CACHE";

      return {
        price: C.price,
        savedAt: C.priceAt,
        source:
          "LOCAL_CACHE"
      };
    }

    /*
     * ----------------------------------------------------------
     * TWELVE DATA PRICE
     * ----------------------------------------------------------
     */

    try {
      const controller =
        new AbortController();

      const timeout =
        setTimeout(
          () =>
            controller.abort(),
          10_000
        );

      const pr =
        await fetch(
          `https://api.twelvedata.com/price` +
          `?symbol=${encodeURIComponent(
            CFG.symbol
          )}` +
          `&apikey=${API_KEY}`,
          {
            signal:
              controller.signal
          }
        );

      clearTimeout(
        timeout
      );

      const pj =
        await pr.json();

      const p =
        Number(
          pj?.price
        );

      if (
        !pr.ok ||
        pj.status ===
          "error" ||
        !Number.isFinite(p)
      ) {
        throw new Error(
          pj.message ||
            "Live price error"
        );
      }

      const savedAt =
        Date.now();

      C.price =
        p;

      C.priceAt =
        savedAt;

      C.dataSource.price =
        "TWELVE_DATA";

      C.cacheAt.price =
        savedAt;

      /*
       * Save price to Redis
       */

      await redisSet(
        CFG.redisKeys.price,
        {
          price: p,
          savedAt
        },
        CFG.redisCacheTTL
      );

      return {
        price: p,
        savedAt,
        source:
          "TWELVE_DATA"
      };

    } catch (priceError) {
      console.error(
        "Twelve Data price failed:",
        priceError?.message ||
          priceError
      );

      /*
       * --------------------------------------------------------
       * REDIS PRICE FALLBACK
       * --------------------------------------------------------
       */

      const redisRaw =
        await redisGet(
          CFG.redisKeys.price
        );

      const redisPrice =
        parseRedisValue(
          redisRaw
        );

      const cachedPrice =
        Number(
          redisPrice?.price
        );

      if (
        Number.isFinite(
          cachedPrice
        )
      ) {
        C.price =
          cachedPrice;

        C.priceAt =
          redisPrice.savedAt ||
          Date.now();

        C.dataSource.price =
          "REDIS_CACHE";

        C.cacheAt.price =
          redisPrice.savedAt ||
          Date.now();

        return {
          price:
            cachedPrice,

          savedAt:
            redisPrice.savedAt ||
            Date.now(),

          source:
            "REDIS_CACHE"
        };
      }

      /*
       * --------------------------------------------------------
       * LOCAL STALE PRICE
       * --------------------------------------------------------
       */

      if (
        Number.isFinite(
          C.price
        )
      ) {
        C.dataSource.price =
          "STALE_LOCAL_CACHE";

        return {
          price:
            C.price,

          savedAt:
            C.priceAt,

          source:
            "STALE_LOCAL_CACHE"
        };
      }

      throw new Error(
        `Live price gagal dan cache price tidak tersedia. ` +
        `${priceError?.message || ""}`
      );
    }
  }

  /*
   * ============================================================
   * FIXED TRADE PLAN
   * ============================================================
   */

  async function getLockedTradePlan(
    signalKey
  ) {
    if (!signalKey) {
      return null;
    }

    try {
      const key =
        `xau_trade_plan:${signalKey}`;

      const raw =
        await redis.get(
          key
        );

      if (!raw) {
        return null;
      }

      if (
        typeof raw ===
        "string"
      ) {
        return JSON.parse(
          raw
        );
      }

      return raw;

    } catch (e) {
      console.error(
        "Trade plan read error:",
        e
      );

      return null;
    }
  }

  async function saveLockedTradePlan(
    signalKey,
    plan
  ) {
    if (
      !signalKey ||
      !plan
    ) {
      return;
    }

    try {
      await redis.set(
        `xau_trade_plan:${signalKey}`,
        JSON.stringify(
          plan
        ),
        {
          ex:
            CFG.tradeLockTTL
        }
      );

    } catch (e) {
      console.error(
        "Trade plan save error:",
        e
      );
    }
  }

  /*
   * ============================================================
   * MAIN
   * ============================================================
   */

  let m5;
  let m15;
  let h1;

  let livePrice;
  let candlePrice;

  let priceSource =
    "NONE";

  try {
    /*
     * ----------------------------------------------------------
     * LOAD CANDLES
     * ----------------------------------------------------------
     */

    [
      m5,
      m15,
      h1
    ] = await Promise.all([
      series(
        "5min",
        CFG.m5Size,
        "m5"
      ),

      series(
        "15min",
        CFG.m15Size,
        "m15"
      ),

      series(
        "1h",
        CFG.h1Size,
        "h1"
      )
    ]);

    /*
     * ----------------------------------------------------------
     * PRICE
     * ----------------------------------------------------------
     */

    const priceResult =
      await getLivePrice();

    livePrice =
      priceResult.price;

    priceSource =
      priceResult.source;

    candlePrice =
      m5.at(-1).close;

    /*
     * ==========================================================
     * H1
     * ==========================================================
     */

    const c1 =
      h1.map(
        x => x.close
      );

    const h1EMA50 =
      ema(c1, 50);

    const h1EMA200 =
      ema(c1, 200);

    const h1ATR =
      atr(h1);

    const h1Struct =
      structure(
        h1,
        20
      );

    let h1Direction =
      "WAIT";

    if (
      h1EMA50 != null &&
      h1EMA200 != null
    ) {
      if (
        livePrice >
          h1EMA200 &&
        h1EMA50 >
          h1EMA200
      ) {
        h1Direction =
          "BUY";

      } else if (
        livePrice <
          h1EMA200 &&
        h1EMA50 <
          h1EMA200
      ) {
        h1Direction =
          "SELL";
      }
    }

    const h1SupportResistance =
      findH1SupportResistance(
        h1,
        livePrice,
        h1ATR
      );

    /*
     * ==========================================================
     * M15
     * ==========================================================
     */

    const c15 =
      m15.map(
        x => x.close
      );

    const m15EMA20 =
      ema(c15, 20);

    const m15EMA50 =
      ema(c15, 50);

    const m15RSI =
      rsi(c15);

    const m15MACD =
      macd(c15);

    const m15ATR =
      atr(m15);

    const m15Struct =
      structure(
        m15,
        20
      );

    const m15BOS =
      bos(
        m15,
        12
      );

    const m15CHOCH =
      choch(
        m15,
        10
      );

    const m15Sweep =
      sweep(
        m15,
        12
      );

    const m15Mom =
      momentum(m15);

    let m15Buy = 0;
    let m15Sell = 0;

    const rb = [];
    const rs = [];

    if (
      m15EMA20 != null &&
      m15EMA50 != null
    ) {
      if (
        m15EMA20 >
        m15EMA50
      ) {
        m15Buy += 20;

        rb.push(
          "EMA20 > EMA50"
        );
      }

      if (
        m15EMA20 <
        m15EMA50
      ) {
        m15Sell += 20;

        rs.push(
          "EMA20 < EMA50"
        );
      }
    }

    if (
      m15EMA20 != null
    ) {
      if (
        livePrice >
        m15EMA20
      ) {
        m15Buy += 10;

        rb.push(
          "Price > EMA20"
        );
      }

      if (
        livePrice <
        m15EMA20
      ) {
        m15Sell += 10;

        rs.push(
          "Price < EMA20"
        );
      }
    }

    if (
      m15RSI != null
    ) {
      if (
        m15RSI >= 50 &&
        m15RSI <= 72
      ) {
        m15Buy += 10;

        rb.push(
          "RSI bullish"
        );
      }

      if (
        m15RSI >= 28 &&
        m15RSI < 50
      ) {
        m15Sell += 10;

        rs.push(
          "RSI bearish"
        );
      }
    }

    if (
      m15MACD?.bullish
    ) {
      m15Buy += 15;

      rb.push(
        "MACD bullish"
      );
    }

    if (
      m15MACD?.bearish
    ) {
      m15Sell += 15;

      rs.push(
        "MACD bearish"
      );
    }

    if (
      m15Struct.bullish
    ) {
      m15Buy += 15;

      rb.push(
        "Structure bullish"
      );
    }

    if (
      m15Struct.bearish
    ) {
      m15Sell += 15;

      rs.push(
        "Structure bearish"
      );
    }

    if (
      m15BOS.bullish
    ) {
      m15Buy += 15;

      rb.push(
        "BOS bullish"
      );
    }

    if (
      m15BOS.bearish
    ) {
      m15Sell += 15;

      rs.push(
        "BOS bearish"
      );
    }

    if (
      m15CHOCH.bullish
    ) {
      m15Buy += 10;

      rb.push(
        "CHOCH bullish"
      );
    }

    if (
      m15CHOCH.bearish
    ) {
      m15Sell += 10;

      rs.push(
        "CHOCH bearish"
      );
    }

    if (
      m15Sweep.bullish
    ) {
      m15Buy += 10;

      rb.push(
        "Sell-side sweep"
      );
    }

    if (
      m15Sweep.bearish
    ) {
      m15Sell += 10;

      rs.push(
        "Buy-side sweep"
      );
    }

    if (
      m15Mom.bullish
    ) {
      m15Buy += 5;

      rb.push(
        "Momentum bullish"
      );
    }

    if (
      m15Mom.bearish
    ) {
      m15Sell += 5;

      rs.push(
        "Momentum bearish"
      );
    }

    m15Buy =
      clamp(
        m15Buy,
        0,
        100
      );

    m15Sell =
      clamp(
        m15Sell,
        0,
        100
      );

    const m15BuyConfirmed =
      m15Buy >= 55 &&
      m15Buy >=
        m15Sell + 15;

    const m15SellConfirmed =
      m15Sell >= 55 &&
      m15Sell >=
        m15Buy + 15;

    const m15Confirmation =
      m15BuyConfirmed
        ? "BUY"
        : m15SellConfirmed
          ? "SELL"
          : "WAIT";

    /*
     * ==========================================================
     * M5
     * ==========================================================
     */

    const c5 =
      m5.map(
        x => x.close
      );

    const m5EMA9 =
      ema(c5, 9);

    const m5EMA20 =
      ema(c5, 20);

    const m5EMA50 =
      ema(c5, 50);

    const m5RSI =
      rsi(c5);

    const m5MACD =
      macd(c5);

    const m5ATR =
      atr(m5);

    const m5Struct =
      structure(
        m5,
        24
      );

    const m5BOS =
      bos(
        m5,
        10
      );

    const m5CHOCH =
      choch(
        m5,
        8
      );

    const m5Sweep =
      sweep(
        m5,
        10
      );

    const m5Mom =
      momentum(m5);

    let m5Buy = 0;
    let m5Sell = 0;

    const r5b = [];
    const r5s = [];

    if (
      m5EMA20 != null &&
      m5EMA50 != null
    ) {
      if (
        m5EMA20 >
        m5EMA50
      ) {
        m5Buy += 20;

        r5b.push(
          "EMA20 > EMA50"
        );
      }

      if (
        m5EMA20 <
        m5EMA50
      ) {
        m5Sell += 20;

        r5s.push(
          "EMA20 < EMA50"
        );
      }
    }

    if (
      m5EMA9 != null
    ) {
      if (
        livePrice >
        m5EMA9
      ) {
        m5Buy += 8;

        r5b.push(
          "Price > EMA9"
        );
      }

      if (
        livePrice <
        m5EMA9
      ) {
        m5Sell += 8;

        r5s.push(
          "Price < EMA9"
        );
      }
    }

    if (
      m5RSI != null
    ) {
      if (
        m5RSI >= 50 &&
        m5RSI < 75
      ) {
        m5Buy += 10;

        r5b.push(
          "RSI bullish"
        );
      }

      if (
        m5RSI > 25 &&
        m5RSI < 50
      ) {
        m5Sell += 10;

        r5s.push(
          "RSI bearish"
        );
      }
    }

    if (
      m5MACD?.bullish
    ) {
      m5Buy += 10;

      r5b.push(
        "MACD bullish"
      );
    }

    if (
      m5MACD?.bearish
    ) {
      m5Sell += 10;

      r5s.push(
        "MACD bearish"
      );
    }

    if (
      m5Struct.bullish
    ) {
      m5Buy += 12;

      r5b.push(
        "Structure bullish"
      );
    }

    if (
      m5Struct.bearish
    ) {
      m5Sell += 12;

      r5s.push(
        "Structure bearish"
      );
    }

    if (
      m5BOS.bullish
    ) {
      m5Buy += 15;

      r5b.push(
        "BOS bullish"
      );
    }

    if (
      m5BOS.bearish
    ) {
      m5Sell += 15;

      r5s.push(
        "BOS bearish"
      );
    }

    if (
      m5CHOCH.bullish
    ) {
      m5Buy += 12;

      r5b.push(
        "CHOCH bullish"
      );
    }

    if (
      m5CHOCH.bearish
    ) {
      m5Sell += 12;

      r5s.push(
        "CHOCH bearish"
      );
    }

    if (
      m5Sweep.bullish
    ) {
      m5Buy += 8;

      r5b.push(
        "Sell-side sweep"
      );
    }

    if (
      m5Sweep.bearish
    ) {
      m5Sell += 8;

      r5s.push(
        "Buy-side sweep"
      );
    }

    if (
      m5Mom.bullish
    ) {
      m5Buy += 5;

      r5b.push(
        "Momentum bullish"
      );
    }

    if (
      m5Mom.bearish
    ) {
      m5Sell += 5;

      r5s.push(
        "Momentum bearish"
      );
    }

    m5Buy =
      clamp(
        m5Buy,
        0,
        100
      );

    m5Sell =
      clamp(
        m5Sell,
        0,
        100
      );

    const m5BuyTriggered =
      m5Buy >= 50 &&
      m5Buy >=
        m5Sell + 8;

    const m5SellTriggered =
      m5Sell >= 50 &&
      m5Sell >=
        m5Buy + 8;

    const m5Trigger =
      m5BuyTriggered
        ? "BUY"
        : m5SellTriggered
          ? "SELL"
          : "WAIT";

    /*
     * ==========================================================
     * ALIGNMENT
     * ==========================================================
     */

    const rawBuyAlignment =
      m15BuyConfirmed &&
      m5BuyTriggered;

    const rawSellAlignment =
      m15SellConfirmed &&
      m5SellTriggered;

    /*
     * ==========================================================
     * S/R FILTER
     * ==========================================================
     */

    let srBuyAllowed = true;
    let srSellAllowed = true;

    let srBuyContext =
      "NEUTRAL";

    let srSellContext =
      "NEUTRAL";

    if (
      h1SupportResistance
        .nearResistance
    ) {
      srBuyAllowed =
        false;

      srBuyContext =
        "BLOCKED_NEAR_RESISTANCE";
    }

    if (
      h1SupportResistance
        .nearSupport
    ) {
      srSellAllowed =
        false;

      srSellContext =
        "BLOCKED_NEAR_SUPPORT";
    }

    if (
      h1SupportResistance
        .nearSupport
    ) {
      srBuyContext =
        "BUY_NEAR_SUPPORT";
    }

    if (
      h1SupportResistance
        .nearResistance
    ) {
      srSellContext =
        "SELL_NEAR_RESISTANCE";
    }

    /*
     * ==========================================================
     * REVERSAL / CONTINUATION
     * ==========================================================
     */

    let buySetupType =
      "NONE";

    let sellSetupType =
      "NONE";

    const buyContinuation =
      rawBuyAlignment &&
      h1Direction ===
        "BUY";

    const sellContinuation =
      rawSellAlignment &&
      h1Direction ===
        "SELL";

    const buyReversal =
      rawBuyAlignment &&
      h1SupportResistance
        .reversalAtSupport &&
      h1Direction !==
        "BUY";

    const sellReversal =
      rawSellAlignment &&
      h1SupportResistance
        .reversalAtResistance &&
      h1Direction !==
        "SELL";

    if (
      buyContinuation
    ) {
      buySetupType =
        "CONTINUATION";

    } else if (
      buyReversal
    ) {
      buySetupType =
        "REVERSAL";

    } else if (
      rawBuyAlignment
    ) {
      buySetupType =
        "COUNTER-TREND";
    }

    if (
      sellContinuation
    ) {
      sellSetupType =
        "CONTINUATION";

    } else if (
      sellReversal
    ) {
      sellSetupType =
        "REVERSAL";

    } else if (
      rawSellAlignment
    ) {
      sellSetupType =
        "COUNTER-TREND";
    }

    /*
     * ==========================================================
     * TARGET S/R
     * ==========================================================
     */

    let targetSR = null;
    let targetSRType = null;
    let targetSRDistance = null;

    if (
      rawBuyAlignment &&
      h1SupportResistance
        .resistance
    ) {
      targetSR =
        h1SupportResistance
          .resistance.price;

      targetSRType =
        "H1 RESISTANCE";

      targetSRDistance =
        Number(
          (
            targetSR -
            livePrice
          ).toFixed(2)
        );
    }

    if (
      rawSellAlignment &&
      h1SupportResistance
        .support
    ) {
      targetSR =
        h1SupportResistance
          .support.price;

      targetSRType =
        "H1 SUPPORT";

      targetSRDistance =
        Number(
          (
            livePrice -
            targetSR
          ).toFixed(2)
        );
    }

    /*
     * ==========================================================
     * FINAL SIGNAL
     * ==========================================================
     */

    let signal =
      "WAIT";

    let status =
      "WAIT";

    let execution =
      "WAIT";

    let setupType =
      "NO ALIGNMENT";

    let score =
      Math.round(
        Math.max(
          m15Buy,
          m15Sell,
          m5Buy,
          m5Sell
        )
      );

    let reasons = [];

    /*
     * BUY
     */

    if (
      rawBuyAlignment &&
      srBuyAllowed
    ) {
      signal =
        "BUY";

      status =
        "ENTRY";

      execution =
        "READY";

      setupType =
        buySetupType;

      score =
        Math.round(
          (
            m15Buy +
            m5Buy
          ) / 2
        );

      reasons = [
        "M15 BUY confirmed",
        "M5 BUY trigger confirmed",
        "M15 + M5 aligned",
        `SETUP: ${buySetupType}`,
        `H1 S/R: ${h1SupportResistance.position}`,

        h1SupportResistance
          .reversalAtSupport
          ? "Price located at/near H1 support"
          : "H1 support/resistance location valid"
      ];

      if (
        targetSR != null
      ) {
        reasons.push(
          `${targetSRType} target ${targetSR}`
        );
      }
    }

    /*
     * SELL
     */

    else if (
      rawSellAlignment &&
      srSellAllowed
    ) {
      signal =
        "SELL";

      status =
        "ENTRY";

      execution =
        "READY";

      setupType =
        sellSetupType;

      score =
        Math.round(
          (
            m15Sell +
            m5Sell
          ) / 2
        );

      reasons = [
        "M15 SELL confirmed",
        "M5 SELL trigger confirmed",
        "M15 + M5 aligned",
        `SETUP: ${sellSetupType}`,
        `H1 S/R: ${h1SupportResistance.position}`,

        h1SupportResistance
          .reversalAtResistance
          ? "Price located at/near H1 resistance"
          : "H1 support/resistance location valid"
      ];

      if (
        targetSR != null
      ) {
        reasons.push(
          `${targetSRType} target ${targetSR}`
        );
      }
    }

    /*
     * BUY blocked
     */

    else if (
      rawBuyAlignment &&
      !srBuyAllowed
    ) {
      reasons = [
        "M15 BUY confirmed",
        "M5 BUY trigger confirmed",
        "BUY BLOCKED",
        "Too close to H1 resistance",

        `Resistance ${
          h1SupportResistance
            .resistance?.price ??
          "N/A"
        }`
      ];
    }

    /*
     * SELL blocked
     */

    else if (
      rawSellAlignment &&
      !srSellAllowed
    ) {
      reasons = [
        "M15 SELL confirmed",
        "M5 SELL trigger confirmed",
        "SELL BLOCKED",
        "Too close to H1 support",

        `Support ${
          h1SupportResistance
            .support?.price ??
          "N/A"
        }`
      ];
    }

    /*
     * Conflict
     */

    else if (
      m15BuyConfirmed &&
      m5SellTriggered
    ) {
      reasons = [
        "M15 BUY vs M5 SELL — conflicting"
      ];
    }

    else if (
      m15SellConfirmed &&
      m5BuyTriggered
    ) {
      reasons = [
        "M15 SELL vs M5 BUY — conflicting"
      ];
    }

    /*
     * Partial
     */

    else if (
      m15BuyConfirmed ||
      m15SellConfirmed ||
      m5BuyTriggered ||
      m5SellTriggered
    ) {
      reasons = [
        "Waiting for timeframe alignment"
      ];
    }

    else {
      reasons = [
        "M15 + M5 not aligned"
      ];
    }

    /*
     * ==========================================================
     * H1 HOLD
     * ==========================================================
     */

    const holdBias =
      h1Direction ===
      "BUY"
        ? "BUY"
        : h1Direction ===
          "SELL"
          ? "SELL"
          : "NEUTRAL";

    const holdPermission =
      signal === "BUY" &&
      h1Direction ===
        "BUY"

        ? "HOLD BUY"

        : signal === "SELL" &&
          h1Direction ===
            "SELL"

          ? "HOLD SELL"

          : signal !==
              "WAIT"

            ? "SCALP ONLY"

            : "NO HOLD";

    const context =
      (
        signal === "BUY" &&
        h1Direction ===
          "BUY"
      ) ||
      (
        signal === "SELL" &&
        h1Direction ===
          "SELL"
      )

        ? "WITH_H1"

        : signal ===
            "WAIT"

          ? "NEUTRAL"

          : "COUNTER_H1";

    /*
     * ==========================================================
     * SIGNAL KEY
     * ==========================================================
     */

    const signalCandle =
      m5.at(-1)?.time ||
      new Date().toISOString();

    const signalKey =
      signal !== "WAIT"
        ? `XAUUSD|${signal}|${signalCandle}`
        : null;

    /*
     * ==========================================================
     * FIXED TRADE PLAN
     * ==========================================================
     */

    let entry = null;
    let stopLoss = null;
    let tp1 = null;
    let tp2 = null;
    let tp3 = null;
    let rr = null;

    let tradePlanLocked =
      false;

    let tradePlanSource =
      "NONE";

    let risk = null;

    let targetSRValid =
      false;

    /*
     * Existing locked plan
     */

    if (signalKey) {
      const locked =
        await getLockedTradePlan(
          signalKey
        );

      if (locked) {
        entry =
          locked.entry;

        stopLoss =
          locked.stopLoss;

        tp1 =
          locked.tp1;

        tp2 =
          locked.tp2;

        tp3 =
          locked.tp3;

        rr =
          locked.rr;

        risk =
          locked.risk ??
          null;

        targetSR =
          locked.targetSR ??
          targetSR;

        targetSRType =
          locked.targetSRType ??
          targetSRType;

        targetSRDistance =
          locked.targetSRDistance ??
          targetSRDistance;

        targetSRValid =
          locked.targetSRValid ??
          false;

        tradePlanLocked =
          true;

        tradePlanSource =
          "REDIS_LOCK";
      }
    }

    /*
     * ==========================================================
     * VALIDATE TARGET
     * ==========================================================
     */

    let candidateEntry =
      Number(
        livePrice.toFixed(2)
      );

    let candidateRisk =
      m5ATR != null
        ? Math.max(
            m5ATR * 1.25,
            0.8
          )
        : null;

    if (
      candidateRisk != null &&
      targetSR != null
    ) {
      if (
        signal === "BUY"
      ) {
        targetSRValid =
          (
            targetSR -
            candidateEntry
          ) >=
          candidateRisk *
            CFG.minTargetR;
      }

      if (
        signal === "SELL"
      ) {
        targetSRValid =
          (
            candidateEntry -
            targetSR
          ) >=
          candidateRisk *
            CFG.minTargetR;
      }
    }

    /*
     * Invalid S/R
     */

    if (
      status === "ENTRY" &&
      CFG.requireValidSRTarget &&
      !targetSRValid
    ) {
      execution =
        "BLOCKED";

      status =
        "WAIT";

      reasons.push(
        targetSR == null
          ? "NO VALID H1 S/R TARGET"
          : `H1 S/R TARGET TOO CLOSE — minimum ${CFG.minTargetR}R`
      );
    }

    /*
     * ==========================================================
     * CREATE FIXED PLAN
     * ==========================================================
     */

    if (
      status === "ENTRY" &&
      execution ===
        "READY" &&
      m5ATR != null &&
      signalKey &&
      !tradePlanLocked
    ) {
      entry =
        candidateEntry;

      risk =
        candidateRisk;

      if (
        signal === "BUY"
      ) {
        stopLoss =
          Number(
            (
              entry -
              risk
            ).toFixed(2)
          );

        tp1 =
          Number(
            targetSR.toFixed(2)
          );

        tp2 =
          Number(
            (
              entry +
              risk * 2.5
            ).toFixed(2)
          );

        tp3 =
          Number(
            (
              entry +
              risk * 4
            ).toFixed(2)
          );

      } else {
        stopLoss =
          Number(
            (
              entry +
              risk
            ).toFixed(2)
          );

        tp1 =
          Number(
            targetSR.toFixed(2)
          );

        tp2 =
          Number(
            (
              entry -
              risk * 2.5
            ).toFixed(2)
          );

        tp3 =
          Number(
            (
              entry -
              risk * 4
            ).toFixed(2)
          );
      }

      const tp1R =
        risk > 0
          ? Math.abs(
              tp1 - entry
            ) / risk
          : 0;

      rr =
        `1 : ${tp1R.toFixed(2)} / 2.5 / 4.0`;

      const newPlan = {
        entry,
        stopLoss,
        tp1,
        tp2,
        tp3,

        rr,

        risk,

        signal,

        signalKey,
        signalCandle,

        setupType,

        targetSR,
        targetSRType,
        targetSRDistance,
        targetSRValid,

        createdAt:
          new Date().toISOString()
      };

      await saveLockedTradePlan(
        signalKey,
        newPlan
      );

      tradePlanLocked =
        true;

      tradePlanSource =
        "NEW_REDIS_LOCK";
    }

    /*
     * ==========================================================
     * PUSH
     * ==========================================================
     */

    let pushSent =
      false;

    let pushSkipped =
      false;

    if (
      signalKey &&
      status === "ENTRY" &&
      execution ===
        "READY"
    ) {
      try {
        const lockKey =
          "xau_last_entry_notification";

        const alreadyNotified =
          await redis.get(
            lockKey
          );

        if (
          alreadyNotified !==
          signalKey
        ) {
          const title =
            signal === "BUY"
              ? "🟢 XAU/USD BUY ENTRY"
              : "🔴 XAU/USD SELL ENTRY";

          const srText =
            targetSR != null
              ? `TARGET ${targetSRType} ${targetSR}`
              : "NO H1 S/R TARGET";

          const body = [
            `${signal} • Score ${score}/100`,
            `Entry ${entry?.toFixed(2)}`,
            `SL ${stopLoss?.toFixed(2)}`,
            `TP1 ${tp1?.toFixed(2)}`,
            `TP2 ${tp2?.toFixed(2)}`,
            `TP3 ${tp3?.toFixed(2)}`,
            setupType,
            srText,
            `H1 ${h1Direction}`,
            holdPermission
          ].join(
            " • "
          );

          const delivery =
            await sendPushToAll({
              title,
              body,
              tag:
                signalKey,
              url: "/"
            });

          pushSent =
            Number(
              delivery?.sent || 0
            ) > 0;

          if (pushSent) {
            await redis.set(
              lockKey,
              signalKey,
              {
                ex:
                  CFG.tradeLockTTL
              }
            );
          }
        } else {
          pushSkipped =
            true;
        }

      } catch (
        pushError
      ) {
        console.error(
          "Automatic push error:",
          pushError
        );
      }
    }

    /*
     * ==========================================================
     * DATA SOURCE STATUS
     * ==========================================================
     */

    const sourceValues = [
      C.dataSource.m5,
      C.dataSource.m15,
      C.dataSource.h1,
      priceSource
    ];

    const usingCache =
      sourceValues.some(
        x =>
          x ===
            "REDIS_CACHE" ||
          x ===
            "STALE_LOCAL_CACHE" ||
          x ===
            "LOCAL_CACHE"
      );

    const usingLive =
      sourceValues.some(
        x =>
          x ===
          "TWELVE_DATA"
      );

    const stale =
      sourceValues.some(
        x =>
          x ===
            "REDIS_CACHE" ||
          x ===
            "STALE_LOCAL_CACHE"
      );

    /*
     * Cache age
     */

    const cacheAges = {
      m5:
        C.cacheAt.m5
          ? Math.round(
              (
                Date.now() -
                C.cacheAt.m5
              ) / 1000
            )
          : null,

      m15:
        C.cacheAt.m15
          ? Math.round(
              (
                Date.now() -
                C.cacheAt.m15
              ) / 1000
            )
          : null,

      h1:
        C.cacheAt.h1
          ? Math.round(
              (
                Date.now() -
                C.cacheAt.h1
              ) / 1000
            )
          : null,

      price:
        C.cacheAt.price
          ? Math.round(
              (
                Date.now() -
                C.cacheAt.price
              ) / 1000
            )
          : null
    };

    let overallDataSource =
      "LIVE";

    if (stale) {
      overallDataSource =
        "CACHE";
    } else if (
      usingLive
    ) {
      overallDataSource =
        "LIVE";
    } else if (
      usingCache
    ) {
      overallDataSource =
        "CACHE";
    }

    /*
     * ==========================================================
     * RESPONSE
     * ==========================================================
     */

    return res.status(200).json({
      ok: true,

      version:
        "V13-SCALP-PERSISTENT-CACHE",

      architecture:
        "M15+M5-ALIGNED-SIGNAL + REVERSAL/CONTINUATION + H1-HOLD + H1-SR-TARGET + FIXED-ENTRY-SL-TP + REDIS-FALLBACK",

      symbol:
        CFG.symbol,

      price:
        livePrice,

      candlePrice,

      /*
       * ========================================================
       * DATA SOURCE
       * ========================================================
       */

      dataSource:
        overallDataSource,

      stale,

      cache: {
        enabled:
          true,

        storage:
          "REDIS + LOCAL",

        redisTTLSeconds:
          CFG.redisCacheTTL,

        sources: {
          m5:
            C.dataSource.m5,

          m15:
            C.dataSource.m15,

          h1:
            C.dataSource.h1,

          price:
            priceSource
        },

        ageSeconds:
          cacheAges
      },

      livePrice: {
        price:
          livePrice,

        source:
          priceSource,

        ageSeconds:
          cacheAges.price
      },

      candles:
        m5.slice(-60),

      status,
      signal,

      signalType:
        signal === "WAIT"
          ? "NONE"
          : setupType,

      setupType,

      execution,

      score,

      context,

      reasons,

      signalKey,

      signalCandle,

      push: {
        attempted:
          Boolean(
            signalKey &&
            status ===
              "ENTRY" &&
            execution ===
              "READY"
          ),

        sent:
          pushSent,

        skipped:
          pushSkipped
      },

      /*
       * ========================================================
       * H1
       * ========================================================
       */

      h1: {
        direction:
          h1Direction,

        ema50:
          h1EMA50,

        ema200:
          h1EMA200,

        atr:
          h1ATR,

        holdBias,

        holdPermission,

        structure:
          h1Struct,

        supportResistance:
          h1SupportResistance,

        srFilter: {
          buyAllowed:
            srBuyAllowed,

          sellAllowed:
            srSellAllowed,

          buyContext:
            srBuyContext,

          sellContext:
            srSellContext,

          buyBlocked:
            !srBuyAllowed,

          sellBlocked:
            !srSellAllowed
        }
      },

      /*
       * ========================================================
       * M15
       * ========================================================
       */

      m15: {
        direction:
          m15Confirmation,

        confirmation:
          m15Confirmation,

        buyScore:
          m15Buy,

        sellScore:
          m15Sell,

        buyConfirmed:
          m15BuyConfirmed,

        sellConfirmed:
          m15SellConfirmed,

        ema20:
          m15EMA20,

        ema50:
          m15EMA50,

        rsi:
          m15RSI,

        macd:
          m15MACD,

        atr:
          m15ATR,

        bos:
          m15BOS,

        choch:
          m15CHOCH,

        sweep:
          m15Sweep,

        momentum:
          m15Mom,

        structure:
          m15Struct,

        buyReasons:
          rb,

        sellReasons:
          rs
      },

      /*
       * ========================================================
       * M5
       * ========================================================
       */

      m5: {
        trigger:
          m5Trigger,

        confirmation:
          m5Trigger,

        buyScore:
          m5Buy,

        sellScore:
          m5Sell,

        buyTriggered:
          m5BuyTriggered,

        sellTriggered:
          m5SellTriggered,

        ema9:
          m5EMA9,

        ema20:
          m5EMA20,

        ema50:
          m5EMA50,

        rsi:
          m5RSI,

        macd:
          m5MACD,

        atr:
          m5ATR,

        bos:
          m5BOS,

        choch:
          m5CHOCH,

        sweep:
          m5Sweep,

        momentum:
          m5Mom,

        structure:
          m5Struct,

        buyReasons:
          r5b,

        sellReasons:
          r5s
      },

      /*
       * ========================================================
       * SETUP ANALYSIS
       * ========================================================
       */

      setupAnalysis: {
        buy: {
          aligned:
            rawBuyAlignment,

          continuation:
            buyContinuation,

          reversal:
            buyReversal,

          type:
            buySetupType,

          location:
            h1SupportResistance
              .position,

          h1Bias:
            h1Direction,

          targetSR:
            rawBuyAlignment
              ? h1SupportResistance
                  .resistance
              : null
        },

        sell: {
          aligned:
            rawSellAlignment,

          continuation:
            sellContinuation,

          reversal:
            sellReversal,

          type:
            sellSetupType,

          location:
            h1SupportResistance
              .position,

          h1Bias:
            h1Direction,

          targetSR:
            rawSellAlignment
              ? h1SupportResistance
                  .support
              : null
        }
      },

      /*
       * ========================================================
       * TRADE PLAN
       * ========================================================
       */

      tradePlan: {
        entry,

        stopLoss,

        tp1,

        tp2,

        tp3,

        rr,

        risk,

        locked:
          tradePlanLocked,

        source:
          tradePlanSource,

        fixed:
          Boolean(
            signalKey &&
            entry != null
          ),

        targetSR,

        targetSRType,

        targetSRDistance,

        targetSRValid,

        targetMode:
          targetSR != null
            ? "NEAREST_H1_SR"
            : "NONE"
      },

      /*
       * ========================================================
       * S/R ANALYSIS
       * ========================================================
       */

      srAnalysis: {
        timeframe:
          "H1",

        currentPrice:
          livePrice,

        support:
          h1SupportResistance
            .support,

        resistance:
          h1SupportResistance
            .resistance,

        position:
          h1SupportResistance
            .position,

        zone:
          h1SupportResistance
            .zone,

        supportDistance:
          h1SupportResistance
            .supportDistance,

        resistanceDistance:
          h1SupportResistance
            .resistanceDistance,

        threshold:
          h1SupportResistance
            .threshold,

        reversalThreshold:
          h1SupportResistance
            .reversalThreshold,

        nearSupport:
          h1SupportResistance
            .nearSupport,

        nearResistance:
          h1SupportResistance
            .nearResistance,

        atSupport:
          h1SupportResistance
            .atSupport,

        atResistance:
          h1SupportResistance
            .atResistance,

        reversalAtSupport:
          h1SupportResistance
            .reversalAtSupport,

        reversalAtResistance:
          h1SupportResistance
            .reversalAtResistance,

        signalContext:
          h1SupportResistance
            .signalContext,

        buyAllowed:
          srBuyAllowed,

        sellAllowed:
          srSellAllowed,

        buyContext:
          srBuyContext,

        sellContext:
          srSellContext,

        scalpTarget:
          targetSR,

        scalpTargetType:
          targetSRType,

        scalpTargetDistance:
          targetSRDistance,

        scalpTargetValid:
          targetSRValid
      },

      /*
       * ========================================================
       * DATA
       * ========================================================
       */

      data: {
        m5Candles:
          m5.length,

        m15Candles:
          m15.length,

        h1Candles:
          h1.length
      },

      timestamp:
        new Date().toISOString()
    });

  } catch (e) {
    console.error(
      "SCALP API ERROR",
      e
    );

    return res.status(502).json({
      ok: false,

      error:
        e.message ||
        "SCALP API ERROR",

      dataSource:
        "NONE",

      stale:
        false,

      cache: {
        enabled:
          true,

        message:
          "Twelve Data gagal dan cache yang diperlukan tidak tersedia."
      }
    });
  }
}
