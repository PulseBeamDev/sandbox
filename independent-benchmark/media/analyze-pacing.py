import numpy as np
import pandas as pd


def calculate_pacer_delay(
    file_path: str,
    pacer_rate_bps: float = 5_000_000,
    start_time_col: str = None,
    end_time_col: str = None,
):
    """Calculates the end-to-end delay added by the pacer per frame.

    :param file_path: Path to the CSV file
    :param pacer_rate_bps: Pacing send rate in bits per second (used if
        timestamps aren't provided)
    :param start_time_col: Column name for frame arrival at pacer (optional, in
        ms)
    :param end_time_col: Column name for frame exit from pacer (optional, in ms)
    """
    try:
        df = pd.read_csv(file_path)
    except FileNotFoundError:
        print(f"Error: File not found at '{file_path}'")
        return None

    # CASE 1: Explicit timestamps in CSV (e.g., pacer_entry_ms, pacer_exit_ms)
    if start_time_col and end_time_col:
        df["pacer_delay_ms"] = df[end_time_col] - df[start_time_col]

    # CASE 2: Calculated from frame size and pacing bandwidth rate
    else:
        # Convert total bytes to bits
        df["total_bits"] = df["total_bytes"] * 8
        # Delay (ms) = (Bits / Rate) * 1000
        df["pacer_delay_ms"] = (df["total_bits"] / pacer_rate_bps) * 1000.0

    # Calculate P50 and P99
    p50_delay = np.percentile(df["pacer_delay_ms"], 50)
    p99_delay = np.percentile(df["pacer_delay_ms"], 99)

    # Print clean report
    print("========================================")
    print("       PACER END-TO-END DELAY           ")
    print("========================================")
    print(f"Total Frames Analyzed : {len(df)}")
    print("----------------------------------------")
    print(f"P50 (Median Pacer Delay) : {p50_delay:.3f} ms")
    print(f"P99 (Tail Pacer Delay)   : {p99_delay:.3f} ms")
    print("========================================")

    return df


# --- Usage Examples ---

# Option A: Calculated from total bytes & pacing send rate (e.g., 5 Mbps)
df_results = calculate_pacer_delay("frame_data.csv", pacer_rate_bps=5_000_000)

# Option B: Measured directly from timestamp columns in your CSV (if you have them)
# df_results = calculate_pacer_delay(
#     "frame_data.csv",
#     start_time_col="pacer_in_ms",
#     end_time_col="pacer_out_ms"
# )
