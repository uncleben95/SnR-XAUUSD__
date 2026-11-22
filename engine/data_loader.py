from pathlib import Path
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "public" / "data"


def load_ohlcv(path: str | Path) -> pd.DataFrame:
    """Load whitespace-delimited MT-style rows: date time open high low close volume."""
    path = Path(path)
    raw = pd.read_csv(path, sep=r"\s+", header=None, names=["date", "time", "open", "high", "low", "close", "volume"], engine="python")
    raw["timestamp"] = pd.to_datetime(raw["date"].astype(str) + " " + raw["time"].astype(str), errors="coerce")
    for col in ("open", "high", "low", "close", "volume"):
        raw[col] = pd.to_numeric(raw[col], errors="coerce")
    df = raw.dropna(subset=["timestamp", "open", "high", "low", "close"]).copy()
    df = df[(df.high >= df[["open", "close", "low"]].max(axis=1)) & (df.low <= df[["open", "close", "high"]].min(axis=1))]
    return df.drop_duplicates("timestamp").sort_values("timestamp").set_index("timestamp")[["open", "high", "low", "close", "volume"]]


def load_all(data_dir: str | Path = DATA_DIR):
    data_dir = Path(data_dir)
    return {
        "M5": load_ohlcv(data_dir / "XAUUSD5.csv"),
        "M15": load_ohlcv(data_dir / "XAUUSD15.csv"),
        "H4": load_ohlcv(data_dir / "XAUUSD240.csv"),
    }
