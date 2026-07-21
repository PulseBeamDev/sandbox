use std::{
    collections::HashSet,
    path::PathBuf,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result};
use bytes::Bytes;
use clap::{Parser, ValueEnum};
use moq_net::{Broadcast, Origin, Track, TrackConsumer, TrackProducer};
use serde::Serialize;
use tokio::time::sleep_until;

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
enum Role {
    A,
    B,
}

#[derive(Debug, Parser)]
#[command(about = "Split-host moq.dev latest-state application-RTT benchmark")]
struct Cli {
    #[arg(long, env = "MOQ_ROLE", value_enum)]
    role: Role,

    #[command(flatten)]
    client: moq_native::ClientConfig,

    #[arg(long, env = "MOQ_RUN_ID")]
    run_id: String,

    #[arg(long, env = "MOQ_CORRIDOR", default_value = "unspecified")]
    corridor: String,

    #[arg(long, env = "MOQ_NAMESPACE")]
    namespace: Option<String>,

    /// Use two flat broadcast names instead of a hierarchical path. The public
    /// moq.dev CDN's media CLI uses flat names, so this keeps the control test
    /// on the same routing shape while preserving distinct control/telemetry
    /// broadcasts.
    #[arg(long, env = "MOQ_FLAT_BROADCAST_NAMES", default_value_t = false)]
    flat_broadcast_names: bool,

    #[arg(long, env = "MOQ_PROVIDER", default_value = "moq-dev-relay")]
    provider: String,

    #[arg(long, env = "MOQ_IMPLEMENTATION", default_value = "moq.dev/moq")]
    implementation: String,

    #[arg(long, env = "MOQ_SAMPLES", default_value_t = 36_000)]
    samples: u32,

    #[arg(long, env = "MOQ_WARMUP", default_value_t = 1_200)]
    warmup: u32,

    #[arg(long, env = "MOQ_RATE_HZ", default_value_t = 120.0)]
    rate_hz: f64,

    #[arg(long, env = "MOQ_PAYLOAD_BYTES", default_value_t = 1_100)]
    payload_bytes: usize,

    #[arg(long, env = "MOQ_START_DELAY_MS", default_value_t = 3_000)]
    start_delay_ms: u64,

    #[arg(long, env = "MOQ_SETUP_TIMEOUT_MS", default_value_t = 45_000)]
    setup_timeout_ms: u64,

    /// Give the peer's namespace subscription time to become active before announcing.
    #[arg(long, env = "MOQ_PUBLISH_DELAY_MS", default_value_t = 5_000)]
    publish_delay_ms: u64,

    #[arg(long, env = "MOQ_LATE_GRACE_MS", default_value_t = 5_000)]
    late_grace_ms: u64,

    #[arg(long, env = "MOQ_REFLECTOR_SHUTDOWN_GRACE_MS", default_value_t = 1_000)]
    reflector_shutdown_grace_ms: u64,

    #[arg(long, env = "MOQ_OUTPUT_DIR", default_value = "results-moq-dev")]
    output_dir: PathBuf,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Sample {
    provider: String,
    run_id: String,
    corridor: String,
    sequence: u32,
    round_trip_ms: f64,
    received_at_unix_ms: u64,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct NumericSummary {
    min: f64,
    mean: f64,
    p50: f64,
    p90: f64,
    p95: f64,
    p99: f64,
    p999: f64,
    max: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OriginSummary {
    provider: String,
    implementation: String,
    protocol: &'static str,
    delivery: &'static str,
    role: &'static str,
    run_id: String,
    corridor: String,
    mode: &'static str,
    relay_url: String,
    payload_bytes: usize,
    rate_hz: f64,
    expected: u32,
    received: usize,
    lost: i64,
    loss_percent: f64,
    duplicates: u64,
    out_of_order: u64,
    send_failures: u64,
    setup_ms: f64,
    round_trip_ms: NumericSummary,
    send_schedule_lag_ms: NumericSummary,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReflectorSummary {
    provider: String,
    implementation: String,
    protocol: &'static str,
    delivery: &'static str,
    role: &'static str,
    run_id: String,
    corridor: String,
    mode: &'static str,
    relay_url: String,
    payload_bytes: usize,
    rate_hz: f64,
    received: u64,
    duplicates: u64,
    out_of_order: u64,
    echo_failures: u64,
    setup_ms: f64,
}

struct Connection {
    publisher: TrackProducer,
    subscriber: TrackConsumer,
    _broadcast: moq_net::BroadcastProducer,
    _publish_session: moq_native::Reconnect,
    _consume_session: moq_native::Reconnect,
    setup_ms: f64,
    relay_url: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn")),
        )
        .with_writer(std::io::stderr)
        .init();

    let cli = Cli::parse();
    anyhow::ensure!(cli.samples > 0, "MOQ_SAMPLES must be positive");
    anyhow::ensure!(
        cli.rate_hz.is_finite() && cli.rate_hz > 0.0,
        "MOQ_RATE_HZ must be positive"
    );
    anyhow::ensure!(
        cli.payload_bytes >= 16,
        "MOQ_PAYLOAD_BYTES must be at least 16"
    );
    tokio::fs::create_dir_all(&cli.output_dir).await?;

    let namespace = cli
        .namespace
        .clone()
        .unwrap_or_else(|| format!("transport-benchmark/{}", cli.run_id));
    let names = if cli.flat_broadcast_names {
        (
            format!("{namespace}-control"),
            format!("{namespace}-telemetry"),
        )
    } else {
        (
            format!("{namespace}/control"),
            format!("{namespace}/telemetry"),
        )
    };
    let (published, subscribed) = match cli.role {
        Role::A => names,
        Role::B => (names.1, names.0),
    };
    let connection = connect(&cli, &published, &subscribed).await?;
    match cli.role {
        Role::A => run_origin(&cli, connection).await,
        Role::B => run_reflector(&cli, connection).await,
    }
}

async fn connect(cli: &Cli, published: &str, subscribed: &str) -> Result<Connection> {
    let started = Instant::now();
    let relay_url = cli
        .client
        .connect
        .as_ref()
        .context("--client-connect is required")?
        .to_string();
    let client = cli.client.clone().init()?;

    // moq.dev's public interop relay does not necessarily replay namespace
    // announcements. Connect the consuming side first on both peers, then wait
    // briefly before announcing either local broadcast.
    let consume_origin = Origin::random().produce();
    let mut consume_session = client
        .clone()
        .consume(consume_origin.clone())
        .context("--client-connect is required for subscriber")?;
    wait_connected(&mut consume_session, cli.setup_timeout_ms, "subscriber").await?;

    tokio::time::sleep(Duration::from_millis(cli.publish_delay_ms)).await;
    let publish_origin = Origin::random().produce();
    let mut published_broadcast = Broadcast::new().produce();
    let publisher = published_broadcast.create_track(Track::new("snapshots"))?;
    anyhow::ensure!(
        publish_origin.publish_broadcast(published, published_broadcast.consume()),
        "failed to publish local broadcast"
    );
    let mut publish_session = client
        .publish(publish_origin.consume())
        .context("--client-connect is required for publisher")?;
    wait_connected(&mut publish_session, cli.setup_timeout_ms, "publisher").await?;

    let subscribed_broadcast = tokio::time::timeout(
        Duration::from_millis(cli.setup_timeout_ms),
        consume_origin.consume().announced_broadcast(subscribed),
    )
    .await
    .context("timed out waiting for remote broadcast announcement")?
    .context("remote broadcast announcement stream closed")?;
    let subscriber = subscribed_broadcast.subscribe_track(&Track::new("snapshots"))?;

    Ok(Connection {
        publisher,
        subscriber,
        _broadcast: published_broadcast,
        _publish_session: publish_session,
        _consume_session: consume_session,
        setup_ms: started.elapsed().as_secs_f64() * 1_000.0,
        relay_url,
    })
}

async fn wait_connected(
    session: &mut moq_native::Reconnect,
    timeout_ms: u64,
    label: &str,
) -> Result<()> {
    if session.connected() {
        return Ok(());
    }
    let status = tokio::time::timeout(Duration::from_millis(timeout_ms), session.status())
        .await
        .with_context(|| format!("timed out connecting {label} session"))??;
    anyhow::ensure!(
        status == moq_native::Status::Connected,
        "{label} session disconnected during setup"
    );
    Ok(())
}

async fn next_frame(track: &mut TrackConsumer) -> Result<Option<Bytes>> {
    loop {
        let Some(mut group) = track.recv_group().await? else {
            return Ok(None);
        };
        if let Some(frame) = group.read_frame().await? {
            return Ok(Some(frame));
        }
    }
}

async fn run_origin(cli: &Cli, mut connection: Connection) -> Result<()> {
    let process_start = Instant::now();
    let send_epoch = tokio::time::Instant::now() + Duration::from_millis(cli.start_delay_ms);
    let interval = Duration::from_secs_f64(1.0 / cli.rate_hz);
    let total = cli.warmup + cli.samples;
    let (sample_send, mut sample_recv) = tokio::sync::mpsc::unbounded_channel::<Sample>();
    let mut subscriber = connection.subscriber;
    let provider = cli.provider.clone();
    let run_id = cli.run_id.clone();
    let corridor = cli.corridor.clone();
    let warmup = cli.warmup;
    let receive_task = tokio::spawn(async move {
        loop {
            let frame = match next_frame(&mut subscriber).await {
                Ok(Some(frame)) => frame,
                Ok(None) => break,
                Err(error) => {
                    tracing::warn!(%error, "origin receive path ended");
                    break;
                }
            };
            if frame.len() < 16 {
                continue;
            }
            let sequence = u32::from_be_bytes(frame[0..4].try_into().unwrap());
            if sequence < warmup {
                continue;
            }
            let sent_ns = u64::from_be_bytes(frame[8..16].try_into().unwrap());
            let now_ns = process_start.elapsed().as_nanos() as u64;
            if sample_send
                .send(Sample {
                    provider: provider.clone(),
                    run_id: run_id.clone(),
                    corridor: corridor.clone(),
                    sequence: sequence - warmup,
                    round_trip_ms: now_ns.saturating_sub(sent_ns) as f64 / 1_000_000.0,
                    received_at_unix_ms: unix_time_ms(),
                })
                .is_err()
            {
                break;
            }
        }
    });

    let mut send_failures = 0_u64;
    let mut schedule_lags = Vec::with_capacity(total as usize);
    for sequence in 0..total {
        let target = send_epoch + interval.mul_f64(sequence as f64);
        sleep_until(target).await;
        let send_started = tokio::time::Instant::now();
        schedule_lags.push(send_started.saturating_duration_since(target).as_secs_f64() * 1_000.0);
        let mut payload = vec![0_u8; cli.payload_bytes];
        payload[0..4].copy_from_slice(&sequence.to_be_bytes());
        payload[8..16].copy_from_slice(&(process_start.elapsed().as_nanos() as u64).to_be_bytes());
        if connection.publisher.write_frame(payload).is_err() {
            send_failures += 1;
        }
    }

    let deadline = tokio::time::Instant::now() + Duration::from_millis(cli.late_grace_ms);
    let mut raw = Vec::with_capacity(cli.samples as usize);
    while raw.len() < cli.samples as usize {
        match tokio::time::timeout_at(deadline, sample_recv.recv()).await {
            Ok(Some(sample)) => raw.push(sample),
            _ => break,
        }
    }
    receive_task.abort();
    let _ = receive_task.await;

    let mut seen = HashSet::new();
    let mut duplicates = 0_u64;
    let mut out_of_order = 0_u64;
    let mut highest = None;
    let mut unique = Vec::with_capacity(raw.len());
    for sample in raw {
        if !seen.insert(sample.sequence) {
            duplicates += 1;
            continue;
        }
        if highest.is_some_and(|value| sample.sequence < value) {
            out_of_order += 1;
        }
        highest = Some(highest.map_or(sample.sequence, |value: u32| value.max(sample.sequence)));
        unique.push(sample);
    }
    unique.sort_by_key(|sample| sample.sequence);
    let round_trips: Vec<f64> = unique.iter().map(|sample| sample.round_trip_ms).collect();
    let received = unique.len();
    let lost = cli.samples as i64 - received as i64;
    let summary = OriginSummary {
        provider: cli.provider.clone(),
        implementation: cli.implementation.clone(),
        protocol: "moq-lite/ietf negotiated",
        delivery: "one-frame latest-state groups over QUIC streams",
        role: "A",
        run_id: cli.run_id.clone(),
        corridor: cli.corridor.clone(),
        mode: "application-round-trip",
        relay_url: connection.relay_url,
        payload_bytes: cli.payload_bytes,
        rate_hz: cli.rate_hz,
        expected: cli.samples,
        received,
        lost,
        loss_percent: lost.max(0) as f64 / cli.samples as f64 * 100.0,
        duplicates,
        out_of_order,
        send_failures,
        setup_ms: connection.setup_ms,
        round_trip_ms: numeric_summary(&round_trips),
        send_schedule_lag_ms: numeric_summary(&schedule_lags),
    };
    write_origin(cli, &unique, &summary).await?;
    anyhow::ensure!(
        summary.lost == 0 && summary.duplicates == 0 && summary.send_failures == 0,
        "benchmark integrity failure: lost={}, duplicates={}, send_failures={} (out_of_order={} is reported, not fatal)",
        summary.lost,
        summary.duplicates,
        summary.send_failures,
        summary.out_of_order
    );
    Ok(())
}

async fn run_reflector(cli: &Cli, mut connection: Connection) -> Result<()> {
    let runtime = Duration::from_millis(cli.start_delay_ms)
        + Duration::from_secs_f64((cli.warmup + cli.samples) as f64 / cli.rate_hz)
        + Duration::from_millis(cli.late_grace_ms + cli.reflector_shutdown_grace_ms);
    let deadline = tokio::time::Instant::now() + runtime;
    let mut received = 0_u64;
    let mut duplicates = 0_u64;
    let mut out_of_order = 0_u64;
    let mut echo_failures = 0_u64;
    let mut sequences = HashSet::new();
    let mut highest = None;
    loop {
        let frame =
            match tokio::time::timeout_at(deadline, next_frame(&mut connection.subscriber)).await {
                Ok(Ok(Some(frame))) => frame,
                Ok(Ok(None)) | Err(_) => break,
                Ok(Err(error)) => return Err(error).context("reflector receive path failed"),
            };
        if frame.len() < 16 {
            continue;
        }
        let sequence = u32::from_be_bytes(frame[0..4].try_into().unwrap());
        if !sequences.insert(sequence) {
            duplicates += 1;
        }
        if highest.is_some_and(|value| sequence < value) {
            out_of_order += 1;
        }
        highest = Some(highest.map_or(sequence, |value: u32| value.max(sequence)));
        received += 1;
        if connection.publisher.write_frame(frame).is_err() {
            echo_failures += 1;
        }
    }

    let summary = ReflectorSummary {
        provider: cli.provider.clone(),
        implementation: cli.implementation.clone(),
        protocol: "moq-lite/ietf negotiated",
        delivery: "one-frame latest-state groups over QUIC streams",
        role: "B",
        run_id: cli.run_id.clone(),
        corridor: cli.corridor.clone(),
        mode: "reflector",
        relay_url: connection.relay_url,
        payload_bytes: cli.payload_bytes,
        rate_hz: cli.rate_hz,
        received,
        duplicates,
        out_of_order,
        echo_failures,
        setup_ms: connection.setup_ms,
    };
    let file = cli.output_dir.join(format!(
        "{}-{}-B.summary.json",
        cli.run_id,
        safe_name(&cli.provider)
    ));
    tokio::fs::write(file, serde_json::to_string_pretty(&summary)? + "\n").await?;
    println!("{}", serde_json::to_string(&summary)?);
    Ok(())
}

async fn write_origin(cli: &Cli, samples: &[Sample], summary: &OriginSummary) -> Result<()> {
    let stem = format!("{}-{}-A", cli.run_id, safe_name(&cli.provider));
    let raw = samples
        .iter()
        .map(serde_json::to_string)
        .collect::<std::result::Result<Vec<_>, _>>()?
        .join("\n")
        + "\n";
    tokio::fs::write(cli.output_dir.join(format!("{stem}.jsonl")), raw).await?;
    tokio::fs::write(
        cli.output_dir.join(format!("{stem}.summary.json")),
        serde_json::to_string_pretty(summary)? + "\n",
    )
    .await?;
    println!("{}", serde_json::to_string(summary)?);
    Ok(())
}

fn safe_name(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '-'
            }
        })
        .collect()
}

fn numeric_summary(values: &[f64]) -> NumericSummary {
    if values.is_empty() {
        return NumericSummary::default();
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    NumericSummary {
        min: sorted[0],
        mean: sorted.iter().sum::<f64>() / sorted.len() as f64,
        p50: percentile(&sorted, 0.50),
        p90: percentile(&sorted, 0.90),
        p95: percentile(&sorted, 0.95),
        p99: percentile(&sorted, 0.99),
        p999: percentile(&sorted, 0.999),
        max: *sorted.last().unwrap(),
    }
}

fn percentile(sorted: &[f64], quantile: f64) -> f64 {
    if sorted.len() == 1 {
        return sorted[0];
    }
    let position = quantile * (sorted.len() - 1) as f64;
    let lower = position.floor() as usize;
    let upper = position.ceil() as usize;
    if lower == upper {
        sorted[lower]
    } else {
        sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower as f64)
    }
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
