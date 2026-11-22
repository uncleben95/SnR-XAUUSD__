"""Historical indicator research; reports descriptive forward-direction statistics only."""
import json
from pathlib import Path
import pandas as pd
from .data_loader import load_all, DATA_DIR
from .indicators import add_indicators


def build_research(data_dir=DATA_DIR, output_dir=None, horizons=(1, 2, 4, 8)):
    data = load_all(data_dir)
    m15 = add_indicators(data["M15"]).reset_index().rename(columns={"timestamp": "time"})
    h4 = add_indicators(data["H4"]).reset_index().rename(columns={"timestamp": "time"})
    # CSV timestamps label candle opens: indicators become available only at candle close.
    m15["time"] = m15["time"] + pd.Timedelta(minutes=15)
    h4["time"] = h4["time"] + pd.Timedelta(hours=4)
    # Only use H4 bars whose timestamps are at or before each M15 observation.
    h4_cols = ["time", "ema20", "ema50", "adx14", "rsi14"]
    h4 = h4[h4_cols].rename(columns={c: f"h4_{c}" for c in h4_cols if c != "time"})
    frame = pd.merge_asof(m15.sort_values("time"), h4.sort_values("time"), on="time", direction="backward")
    frame["m15_bias"] = (frame.ema20 > frame.ema50).map({True: "up", False: "down"})
    frame["h4_bias"] = (frame.h4_ema20 > frame.h4_ema50).map({True: "up", False: "down"})
    frame["aligned"] = frame.m15_bias == frame.h4_bias
    frame["strong_adx"] = frame.adx14 >= 20
    frame["aligned_strong"] = frame.aligned & frame.strong_adx
    frame["future_return_1bar"] = frame.close.shift(-1) / frame.close - 1
    rows = []
    for horizon in horizons:
        future = frame.close.shift(-horizon)
        valid = future.notna() & frame.ema20.notna() & frame.h4_ema20.notna()
        direction_up = future > frame.close
        groups = {
            "all_valid": valid,
            "m15_ema_alignment": valid,
            "h4_m15_aligned": valid & frame.aligned,
            "aligned_and_adx20_plus": valid & frame.aligned_strong,
        }
        expected_up = {
            "all_valid": None,
            "m15_ema_alignment": frame.m15_bias.eq("up"),
            "h4_m15_aligned": frame.m15_bias.eq("up"),
            "aligned_and_adx20_plus": frame.m15_bias.eq("up"),
        }
        for name, mask in groups.items():
            count = int(mask.sum())
            if name == "all_valid":
                correct = None
                rate = None
            else:
                correct = int((direction_up[mask] == expected_up[name][mask]).sum())
                rate = round(100 * correct / count, 2) if count else None
            rows.append({"horizon_m15_bars": horizon, "group": name, "observations": count,
                         "directional_match_pct": rate,
                         "definition": "future close direction matches EMA bias; descriptive statistic, not trade win rate"})
    summary = pd.DataFrame(rows)
    if output_dir:
        out = Path(output_dir); out.mkdir(parents=True, exist_ok=True)
        summary.to_csv(out / "historical_research_summary.csv", index=False)
        # Compact metadata; no signal feed or live polling is generated.
        meta = {"engine": "Historical Indicator Research Engine", "timeframes": {k: {"rows": len(v), "start": str(v.index.min()), "end": str(v.index.max())} for k,v in data.items()},
                "note": "Directional match is not trade win rate and does not include costs or execution."}
        (out / "research_metadata.json").write_text(json.dumps(meta, indent=2))
    return summary


def main():
    root = Path(__file__).resolve().parents[1]
    result = build_research(output_dir=root / "research_results")
    print(result.to_string(index=False))
    print(f"\nSaved results to: {root / 'research_results'}")

if __name__ == "__main__":
    main()
