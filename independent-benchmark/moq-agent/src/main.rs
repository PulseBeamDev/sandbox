use std::{
    collections::HashSet,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result};
use bytes::Bytes;
use clap::{Parser, ValueEnum};
use moq_native_ietf::{quic, tls};
use moq_transport::{
    coding::TrackNamespace,
    serve::{self, Datagram, DatagramsWriter, TrackReader, TrackReaderMode},
    session::{Publisher, Subscriber},
};
use serde::Serialize;
use tokio::{task::JoinHandle, time::sleep_until};
use url::Url;

#[cfg(not(feature = "draft14"))]
const PROVIDER: &str = "moq";
#[cfg(feature = "draft14")]
const PROVIDER: &str = "cloudflare-managed-moq";
#[cfg(not(feature = "draft14"))]
const IMPLEMENTATION: &str = "cloudflare/moq-rs";
#[cfg(feature = "draft14")]
const IMPLEMENTATION: &str = "Cloudflare Managed MoQ; cloudflare/moq-rs draft-14 client";
#[cfg(not(feature = "draft14"))]
const DRAFT: &str = "draft-ietf-moq-transport-16";
#[cfg(feature = "draft14")]
const DRAFT: &str = "draft-ietf-moq-transport-14";

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
enum Role {
    A,
    B,
}

#[derive(Debug, Parser)]
#[command(about = "Split-host MoQ datagram application-RTT benchmark")]
struct Cli {
    #[arg(long, env = "MOQ_ROLE", value_enum)]
    role: Role,

    #[arg(long, env = "MOQ_URL")]
    url: Url,

    #[arg(long, env = "MOQ_RUN_ID")]
    run_id: String,

    #[arg(long, env = "MOQ_CORRIDOR", default_value = "unspecified")]
    corridor: String,

    #[arg(long, env = "MOQ_NAMESPACE")]
    namespace: Option<String>,

    #[arg(long, env = "MOQ_SAMPLES", default_value_t = 7_200)]
    samples: u32,

    #[arg(long, env = "MOQ_WARMUP", default_value_t = 1_200)]
    warmup: u32,

    #[arg(long, env = "MOQ_RATE_HZ", default_value_t = 120.0)]
    rate_hz: f64,

    #[arg(long, env = "MOQ_PAYLOAD_BYTES", default_value_t = 1_100)]
    payload_bytes: usize,

    #[arg(long, env = "MOQ_START_DELAY_MS", default_value_t = 3_000)]
    start_delay_ms: u64,

    /// Optional delay before the first subscription attempt.
    #[arg(long, env = "MOQ_SUBSCRIBE_DELAY_MS", default_value_t = 0)]
    subscribe_delay_ms: u64,

    #[arg(long, env = "MOQ_PUBLISH_READY_TIMEOUT_MS", default_value_t = 15_000)]
    publish_ready_timeout_ms: u64,

    #[arg(long, env = "MOQ_SUBSCRIBE_TIMEOUT_MS", default_value_t = 30_000)]
    subscribe_timeout_ms: u64,

    #[arg(long, env = "MOQ_SUBSCRIBE_RETRY_INITIAL_MS", default_value_t = 50)]
    subscribe_retry_initial_ms: u64,

    #[arg(long, env = "MOQ_SUBSCRIBE_RETRY_MAX_MS", default_value_t = 1_000)]
    subscribe_retry_max_ms: u64,

    #[arg(long, env = "MOQ_LATE_GRACE_MS", default_value_t = 5_000)]
    late_grace_ms: u64,

    /// Record datagram loss as a benchmark result instead of rejecting the run.
    #[arg(long, env = "MOQ_ALLOW_LOSS", default_value_t = false)]
    allow_loss: bool,

    /// Extra time the reflector stays alive after the expected send window.
    #[arg(long, env = "MOQ_REFLECTOR_SHUTDOWN_GRACE_MS", default_value_t = 1_000)]
    reflector_shutdown_grace_ms: u64,

    #[arg(long, env = "MOQ_OUTPUT_DIR", default_value = "results-moq")]
    output_dir: PathBuf,

    #[arg(long, env = "MOQ_TLS_DISABLE_VERIFY", default_value_t = false)]
    tls_disable_verify: bool,

    /// Trust a benchmark-specific CA instead of disabling TLS verification.
    #[arg(long, env = "MOQ_TLS_ROOT")]
    tls_root: Option<PathBuf>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Sample {
    provider: &'static str,
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
    provider: &'static str,
    implementation: &'static str,
    draft: &'static str,
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
    publish_ack_ms: f64,
    subscribe_ready_ms: f64,
    subscribe_attempts: u32,
    round_trip_ms: NumericSummary,
    send_schedule_lag_ms: NumericSummary,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReflectorSummary {
    provider: &'static str,
    implementation: &'static str,
    draft: &'static str,
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
    publish_ack_ms: f64,
    subscribe_ready_ms: f64,
    subscribe_attempts: u32,
}

struct MoqConnection {
    _publisher_endpoint: quic::Endpoint,
    _subscriber_endpoint: quic::Endpoint,
    publisher: DatagramsWriter,
    subscriber: Option<TrackReader>,
    setup_ms: f64,
    publish_ack_ms: f64,
    subscribe_ready_ms: f64,
    subscribe_attempts: u32,
    tasks: MoqTasks,
}

struct MoqTasks {
    publisher_session: JoinHandle<()>,
    publisher_track: JoinHandle<()>,
    subscriber_session: JoinHandle<()>,
    subscriber_track: JoinHandle<()>,
}

impl MoqConnection {
    async fn shutdown(&mut self) {
        self.tasks.publisher_track.abort();
        self.tasks.subscriber_track.abort();
        let _ = (&mut self.tasks.publisher_track).await;
        let _ = (&mut self.tasks.subscriber_track).await;

        // Give the live control sessions a scheduling turn to flush PUBLISH_DONE
        // and UNSUBSCRIBE before closing their QUIC endpoints.
        tokio::time::sleep(Duration::from_millis(10)).await;
        self.tasks.publisher_session.abort();
        self.tasks.subscriber_session.abort();
        let _ = (&mut self.tasks.publisher_session).await;
        let _ = (&mut self.tasks.subscriber_session).await;
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,quinn=warn")),
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
    let namespace_root = cli
        .namespace
        .clone()
        .unwrap_or_else(|| format!("benchmark/{}", cli.run_id));
    let (published_name, subscribed_name) = match cli.role {
        Role::A => ("control", "telemetry"),
        Role::B => ("telemetry", "control"),
    };
    let published_url = channel_url(&cli.url, published_name);
    let subscribed_url = channel_url(&cli.url, subscribed_name);

    tracing::info!(
        role = ?cli.role,
        relay = %cli.url,
        corridor = %cli.corridor,
        payload_bytes = cli.payload_bytes,
        rate_hz = cli.rate_hz,
        "connecting MoQ datagram tracks"
    );

    let connection = connect(
        &published_url,
        &subscribed_url,
        cli.tls_disable_verify,
        cli.tls_root.clone(),
        &format!("{namespace_root}/{published_name}"),
        &format!("{namespace_root}/{subscribed_name}"),
        cli.subscribe_delay_ms,
        cli.publish_ready_timeout_ms,
        cli.subscribe_timeout_ms,
        cli.subscribe_retry_initial_ms,
        cli.subscribe_retry_max_ms,
    )
    .await?;

    match cli.role {
        Role::A => run_origin(&cli, connection).await,
        Role::B => run_reflector(&cli, connection).await,
    }
}

async fn connect(
    publisher_url: &Url,
    subscriber_url: &Url,
    tls_disable_verify: bool,
    tls_root: Option<PathBuf>,
    published_namespace: &str,
    subscribed_namespace: &str,
    subscribe_delay_ms: u64,
    _publish_ready_timeout_ms: u64,
    subscribe_timeout_ms: u64,
    subscribe_retry_initial_ms: u64,
    subscribe_retry_max_ms: u64,
) -> Result<MoqConnection> {
    let setup_started = Instant::now();
    let tls_args = tls::Args {
        root: tls_root.into_iter().collect(),
        disable_verify: tls_disable_verify,
        ..Default::default()
    };
    let publisher_endpoint = new_endpoint(tls_args.clone())?;

    let (publisher_session, publisher_cid, publisher_transport) = publisher_endpoint
        .client
        .connect(publisher_url, None)
        .await
        .context("publisher failed to connect to relay")?;
    let (publisher_session, mut publisher) =
        Publisher::connect(publisher_session, publisher_transport)
            .await
            .context("publisher failed MoQT setup")?;

    #[cfg(not(feature = "draft14"))]
    let (publisher_writer, track_reader) = {
        let (track_writer, track_reader) = serve::Track::new(
            TrackNamespace::from_utf8_path(published_namespace),
            "snapshots",
        )
        .produce();
        let publisher_writer = track_writer
            .datagrams()
            .context("failed to create publisher datagram writer")?;
        (publisher_writer, track_reader)
    };

    #[cfg(feature = "draft14")]
    let (publisher_writer, tracks_reader) = {
        let (mut tracks_writer, _, tracks_reader) = serve::Tracks {
            namespace: TrackNamespace::from_utf8_path(published_namespace),
        }
        .produce();
        let track_writer = tracks_writer
            .create("snapshots")
            .context("failed to create publisher track")?;
        let publisher_writer = track_writer
            .datagrams()
            .context("failed to create publisher datagram writer")?;
        (publisher_writer, tracks_reader)
    };

    let publisher_session_task = tokio::spawn(async move {
        if let Err(error) = publisher_session.run().await {
            tracing::warn!(%error, "publisher session ended");
        }
    });
    #[cfg(not(feature = "draft14"))]
    let (publish_ack_ms, publisher_track_task) = {
        let publish_ack_started = Instant::now();
        let mut published = publisher
            .publish(track_reader, Default::default())
            .await
            .context("failed to send exact-track PUBLISH")?;
        tokio::time::timeout(
            Duration::from_millis(_publish_ready_timeout_ms),
            published.ok(),
        )
        .await
        .context("timed out waiting for PUBLISH_OK")?
        .context("relay rejected exact-track PUBLISH")?;
        let publish_ack_ms = publish_ack_started.elapsed().as_secs_f64() * 1_000.0;
        let publisher_track_task = tokio::spawn(async move {
            if let Err(error) = published.serve().await {
                tracing::warn!(%error, "published track ended");
            }
        });
        (publish_ack_ms, publisher_track_task)
    };

    #[cfg(feature = "draft14")]
    let (publish_ack_ms, publisher_track_task) = {
        let publish_ack_started = Instant::now();
        let publisher_track_task = tokio::spawn(async move {
            if let Err(error) = publisher.announce(tracks_reader).await {
                tracing::warn!(%error, "published namespace ended");
            }
        });
        // draft-14's public API does not expose PUBLISH_NAMESPACE_OK. An
        // immediate rejection completes this task; successful announcements
        // stay pending while serving subscriptions. Subscription readiness
        // below is the definitive end-to-end gate.
        tokio::time::sleep(Duration::from_millis(250)).await;
        anyhow::ensure!(
            !publisher_track_task.is_finished(),
            "relay rejected draft-14 namespace announcement"
        );
        (
            publish_ack_started.elapsed().as_secs_f64() * 1_000.0,
            publisher_track_task,
        )
    };

    tokio::time::sleep(Duration::from_millis(subscribe_delay_ms)).await;

    let subscriber_endpoint = new_endpoint(tls_args)?;
    let (subscriber_session, subscriber_cid, subscriber_transport) = subscriber_endpoint
        .client
        .connect(subscriber_url, None)
        .await
        .context("subscriber failed to connect to relay")?;
    #[allow(unused_mut)]
    let (subscriber_session, mut subscriber) =
        Subscriber::connect(subscriber_session, subscriber_transport)
            .await
            .context("subscriber failed MoQT setup")?;

    let subscriber_session_task = tokio::spawn(async move {
        if let Err(error) = subscriber_session.run().await {
            tracing::warn!(%error, "subscriber session ended");
        }
    });

    let subscribe_started = Instant::now();
    let subscribe_deadline =
        tokio::time::Instant::now() + Duration::from_millis(subscribe_timeout_ms);
    let mut subscribe_attempts = 0_u32;
    let mut retry_delay_ms = subscribe_retry_initial_ms.max(1);
    #[cfg(not(feature = "draft14"))]
    let (subscriber_track_task, track_reader) = {
        let (subscription, track_reader) = loop {
            subscribe_attempts += 1;
            let (track_writer, track_reader) = serve::Track::new(
                TrackNamespace::from_utf8_path(subscribed_namespace),
                "snapshots",
            )
            .produce();
            let remaining =
                subscribe_deadline.saturating_duration_since(tokio::time::Instant::now());
            anyhow::ensure!(
                !remaining.is_zero(),
                "timed out waiting for SUBSCRIBE_OK after {subscribe_attempts} attempts"
            );

            match tokio::time::timeout(remaining, subscriber.subscribe_open(track_writer)).await {
                Ok(Ok(subscription)) => break (subscription, track_reader),
                Ok(Err(error)) => {
                    if tokio::time::Instant::now() >= subscribe_deadline {
                        return Err(error).context(format!(
                            "timed out waiting for SUBSCRIBE_OK after {subscribe_attempts} attempts"
                        ));
                    }
                    tracing::debug!(
                        attempt = subscribe_attempts,
                        retry_delay_ms,
                        %error,
                        "subscription not ready; retrying"
                    );
                    let delay = Duration::from_millis(retry_delay_ms).min(
                        subscribe_deadline.saturating_duration_since(tokio::time::Instant::now()),
                    );
                    tokio::time::sleep(delay).await;
                    retry_delay_ms = retry_delay_ms
                        .saturating_mul(2)
                        .min(subscribe_retry_max_ms.max(1));
                }
                Err(_) => anyhow::bail!(
                    "timed out waiting for SUBSCRIBE_OK after {subscribe_attempts} attempts"
                ),
            }
        };
        let subscriber_track_task = tokio::spawn(async move {
            if let Err(error) = subscription.closed().await {
                tracing::warn!(%error, "subscriber track ended");
            }
        });
        (subscriber_track_task, track_reader)
    };

    #[cfg(feature = "draft14")]
    let (subscriber_track_task, track_reader) = loop {
        subscribe_attempts += 1;
        let (track_writer, track_reader) = serve::Track::new(
            TrackNamespace::from_utf8_path(subscribed_namespace),
            "snapshots".to_string(),
        )
        .produce();
        let remaining = subscribe_deadline.saturating_duration_since(tokio::time::Instant::now());
        anyhow::ensure!(
            !remaining.is_zero(),
            "timed out waiting for draft-14 SUBSCRIBE_OK after {subscribe_attempts} attempts"
        );
        let mut subscriber_attempt = subscriber.clone();
        let mut subscriber_track_task = tokio::spawn(async move {
            if let Err(error) = subscriber_attempt.subscribe(track_writer).await {
                tracing::warn!(%error, "draft-14 subscriber track ended");
            }
        });
        // In draft-14, TrackReader::mode() remains pending after SUBSCRIBE_OK
        // until the first datagram arrives. Waiting for mode here would
        // deadlock the application before it can send that first datagram.
        // A rejected/not-found subscription closes promptly; an accepted
        // subscription stays live while awaiting data.
        let probation = Duration::from_secs(2).min(remaining);
        let closed_during_probation = tokio::time::timeout(probation, &mut subscriber_track_task)
            .await
            .is_ok();
        if !closed_during_probation && !track_reader.is_closed() {
            break (subscriber_track_task, track_reader);
        }
        if !closed_during_probation {
            subscriber_track_task.abort();
            let _ = subscriber_track_task.await;
        }
        anyhow::ensure!(
            tokio::time::Instant::now() < subscribe_deadline,
            "timed out waiting for draft-14 SUBSCRIBE_OK after {subscribe_attempts} attempts"
        );
        let delay = Duration::from_millis(retry_delay_ms)
            .min(subscribe_deadline.saturating_duration_since(tokio::time::Instant::now()));
        tokio::time::sleep(delay).await;
        retry_delay_ms = retry_delay_ms
            .saturating_mul(2)
            .min(subscribe_retry_max_ms.max(1));
    };
    let subscribe_ready_ms = subscribe_started.elapsed().as_secs_f64() * 1_000.0;

    let setup_ms = setup_started.elapsed().as_secs_f64() * 1_000.0;

    tracing::info!(
        publisher_cid = %publisher_cid,
        subscriber_cid = %subscriber_cid,
        setup_ms,
        publish_ack_ms,
        subscribe_ready_ms,
        subscribe_attempts,
        "MoQ tracks ready"
    );

    Ok(MoqConnection {
        _publisher_endpoint: publisher_endpoint,
        _subscriber_endpoint: subscriber_endpoint,
        publisher: publisher_writer,
        subscriber: Some(track_reader),
        setup_ms,
        publish_ack_ms,
        subscribe_ready_ms,
        subscribe_attempts,
        tasks: MoqTasks {
            publisher_session: publisher_session_task,
            publisher_track: publisher_track_task,
            subscriber_session: subscriber_session_task,
            subscriber_track: subscriber_track_task,
        },
    })
}

fn new_endpoint(tls_args: tls::Args) -> Result<quic::Endpoint> {
    let tls = tls_args.load()?;
    let bind = SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0);
    quic::Endpoint::new(quic::Config::new(bind, None, tls)?)
        .context("failed to create QUIC endpoint")
}

fn channel_url(base: &Url, channel: &str) -> Url {
    #[cfg(feature = "draft14")]
    {
        // Cloudflare Managed MoQ authenticates the JWT at the root path. Any
        // appended segment falls through to the public relay instead.
        let _ = channel;
        return base.clone();
    }

    #[cfg(not(feature = "draft14"))]
    let mut url = base.clone();
    #[cfg(not(feature = "draft14"))]
    let path = format!("{}/{}", base.path().trim_end_matches('/'), channel);
    #[cfg(not(feature = "draft14"))]
    url.set_path(&path);
    #[cfg(not(feature = "draft14"))]
    url
}

async fn run_origin(cli: &Cli, mut connection: MoqConnection) -> Result<()> {
    let process_start = Instant::now();
    let send_epoch = tokio::time::Instant::now() + Duration::from_millis(cli.start_delay_ms);
    let interval = Duration::from_secs_f64(1.0 / cli.rate_hz);
    let total = cli.warmup + cli.samples;
    let (sample_send, mut sample_recv) = tokio::sync::mpsc::unbounded_channel::<Sample>();
    let run_id = cli.run_id.clone();
    let corridor = cli.corridor.clone();
    let warmup = cli.warmup;

    let subscriber = connection
        .subscriber
        .take()
        .context("origin subscriber track was already taken")?;
    let receive_task = tokio::spawn(async move {
        let mut subscriber = match subscriber.mode().await {
            Ok(TrackReaderMode::Datagrams(reader)) => reader,
            Ok(_) => {
                tracing::warn!("relay selected a non-datagram delivery mode");
                return;
            }
            Err(error) => {
                tracing::warn!(%error, "origin subscriber track failed");
                return;
            }
        };
        while let Ok(Some(datagram)) = subscriber.read().await {
            if datagram.payload.len() < 16 {
                continue;
            }
            let payload = datagram.payload.as_ref();
            let sequence = u32::from_be_bytes(payload[0..4].try_into().unwrap());
            if sequence < warmup {
                continue;
            }
            let sent_elapsed_ns = u64::from_be_bytes(payload[8..16].try_into().unwrap());
            let now_elapsed_ns = process_start.elapsed().as_nanos() as u64;
            let sample = Sample {
                provider: PROVIDER,
                run_id: run_id.clone(),
                corridor: corridor.clone(),
                sequence: sequence - warmup,
                round_trip_ms: now_elapsed_ns.saturating_sub(sent_elapsed_ns) as f64 / 1_000_000.0,
                received_at_unix_ms: unix_time_ms(),
            };
            if sample_send.send(sample).is_err() {
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
        if connection
            .publisher
            .write(Datagram {
                group_id: sequence as u64,
                object_id: 0,
                priority: 0,
                payload: Bytes::from(payload),
                extension_headers: Default::default(),
            })
            .is_err()
        {
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
    connection.shutdown().await;

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
        provider: PROVIDER,
        implementation: IMPLEMENTATION,
        draft: DRAFT,
        delivery: "quic-datagram",
        role: "A",
        run_id: cli.run_id.clone(),
        corridor: cli.corridor.clone(),
        mode: "application-round-trip",
        relay_url: relay_url_for_summary(&cli.url),
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
        publish_ack_ms: connection.publish_ack_ms,
        subscribe_ready_ms: connection.subscribe_ready_ms,
        subscribe_attempts: connection.subscribe_attempts,
        round_trip_ms: numeric_summary(&round_trips),
        send_schedule_lag_ms: numeric_summary(&schedule_lags),
    };

    let stem = format!("{}-moq-A", cli.run_id);
    let raw_path = cli.output_dir.join(format!("{stem}.jsonl"));
    let summary_path = cli.output_dir.join(format!("{stem}.summary.json"));
    let raw_text = unique
        .iter()
        .map(serde_json::to_string)
        .collect::<std::result::Result<Vec<_>, _>>()?
        .join("\n")
        + "\n";
    tokio::fs::write(raw_path, raw_text).await?;
    tokio::fs::write(summary_path, serde_json::to_string_pretty(&summary)? + "\n").await?;
    println!("{}", serde_json::to_string(&summary)?);
    anyhow::ensure!(
        (cli.allow_loss || summary.lost == 0)
            && summary.duplicates == 0
            && summary.out_of_order == 0
            && summary.send_failures == 0,
        "benchmark integrity failure: lost={}, duplicates={}, out_of_order={}, send_failures={}",
        summary.lost,
        summary.duplicates,
        summary.out_of_order,
        summary.send_failures
    );
    Ok(())
}

async fn run_reflector(cli: &Cli, mut connection: MoqConnection) -> Result<()> {
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
    let subscriber = connection
        .subscriber
        .take()
        .context("reflector subscriber track was already taken")?;
    let mut subscriber = match subscriber
        .mode()
        .await
        .context("reflector subscriber track failed")?
    {
        TrackReaderMode::Datagrams(reader) => reader,
        _ => anyhow::bail!("relay selected a non-datagram delivery mode"),
    };

    loop {
        let datagram = match tokio::time::timeout_at(deadline, subscriber.read()).await {
            Ok(Ok(Some(datagram))) => datagram,
            Ok(Ok(None)) => break,
            Ok(Err(serve::ServeError::Done)) => break,
            #[cfg(feature = "draft14")]
            Ok(Err(serve::ServeError::Closed(0))) => break,
            Ok(Err(error)) => return Err(error).context("reflector subscriber failed"),
            Err(_) => break,
        };
        if datagram.payload.len() < 16 {
            continue;
        }
        let sequence = u32::from_be_bytes(datagram.payload[0..4].try_into().unwrap());
        if !sequences.insert(sequence) {
            duplicates += 1;
        }
        if highest.is_some_and(|value| sequence < value) {
            out_of_order += 1;
        }
        highest = Some(highest.map_or(sequence, |value: u32| value.max(sequence)));
        received += 1;

        if connection
            .publisher
            .write(Datagram {
                group_id: sequence as u64,
                object_id: 0,
                priority: 0,
                payload: datagram.payload,
                extension_headers: Default::default(),
            })
            .is_err()
        {
            echo_failures += 1;
        }
    }

    connection.shutdown().await;

    let summary = ReflectorSummary {
        provider: PROVIDER,
        implementation: IMPLEMENTATION,
        draft: DRAFT,
        delivery: "quic-datagram",
        role: "B",
        run_id: cli.run_id.clone(),
        corridor: cli.corridor.clone(),
        mode: "reflector",
        relay_url: relay_url_for_summary(&cli.url),
        payload_bytes: cli.payload_bytes,
        rate_hz: cli.rate_hz,
        received,
        duplicates,
        out_of_order,
        echo_failures,
        setup_ms: connection.setup_ms,
        publish_ack_ms: connection.publish_ack_ms,
        subscribe_ready_ms: connection.subscribe_ready_ms,
        subscribe_attempts: connection.subscribe_attempts,
    };
    let summary_path = cli
        .output_dir
        .join(format!("{}-moq-B.summary.json", cli.run_id));
    tokio::fs::write(summary_path, serde_json::to_string_pretty(&summary)? + "\n").await?;
    println!("{}", serde_json::to_string(&summary)?);
    Ok(())
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

fn relay_url_for_summary(url: &Url) -> String {
    #[cfg(feature = "draft14")]
    {
        let mut redacted = url.clone();
        redacted.set_path("/[managed-credential]");
        redacted.set_query(None);
        redacted.set_fragment(None);
        return redacted.to_string();
    }

    #[cfg(not(feature = "draft14"))]
    url.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_url_preserves_scope_and_appends_channel() {
        let base = Url::parse("https://relay.example/benchmark/run/").unwrap();
        #[cfg(not(feature = "draft14"))]
        assert_eq!(
            channel_url(&base, "control").as_str(),
            "https://relay.example/benchmark/run/control"
        );
        #[cfg(feature = "draft14")]
        assert_eq!(channel_url(&base, "control"), base);
    }

    #[test]
    fn numeric_summary_interpolates_percentiles() {
        let summary = numeric_summary(&[4.0, 1.0, 3.0, 2.0]);
        assert_eq!(summary.min, 1.0);
        assert_eq!(summary.mean, 2.5);
        assert_eq!(summary.p50, 2.5);
        assert_eq!(summary.max, 4.0);
    }

    #[test]
    fn relay_summary_redacts_managed_credential() {
        let url = Url::parse("https://relay.example/header.payload.signature").unwrap();
        #[cfg(feature = "draft14")]
        assert_eq!(
            relay_url_for_summary(&url),
            "https://relay.example/[managed-credential]"
        );
        #[cfg(not(feature = "draft14"))]
        assert_eq!(relay_url_for_summary(&url), url.to_string());
    }
}
