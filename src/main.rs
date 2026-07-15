use std::time::{Duration, UNIX_EPOCH};

use tokio::{net::UdpSocket, task::JoinSet, time::Instant};

use pulsebeam_agent::{
    actor::{AgentBuilder, AgentEvent},
    agent::{DataPublisher, DataSubscriber},
    api::HttpApiClient,
    wallclock_at,
};

fn main() {
    tracing_subscriber::fmt::init();
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(run());
}

async fn run() {
    let mut join_set = JoinSet::new();
    join_set.spawn(run_pulsebeam_publisher());
    join_set.spawn(run_pulsebeam_subscriber());
    join_set.join_all().await;
}

async fn run_pulsebeam_publisher() -> anyhow::Result<()> {
    let http_client = Box::new(reqwest::Client::new());
    let api = HttpApiClient::new(http_client, "http://localhost:7070")?;
    let socket = UdpSocket::bind("0.0.0.0:0").await?;
    let mut driver = AgentBuilder::new(api, socket).connect("demo").await?;

    driver.declare_publish_topic("ping")?;
    let mut join_set = JoinSet::new();

    while let Some(ev) = driver.poll().await {
        match ev {
            AgentEvent::DataPublisherDeclared(publisher) => {
                join_set.spawn(handle_data_publisher(publisher));
            }
            _ev => {
                tracing::warn!("unhandled event");
            }
        }
    }
    join_set.join_all().await;

    Ok(())
}

async fn handle_data_publisher(publisher: DataPublisher) {
    loop {
        let elapsed = wallclock_at(Instant::now())
            .duration_since(UNIX_EPOCH)
            .unwrap();
        let payload = elapsed.as_micros().to_be_bytes();
        publisher.send(payload.to_vec()).await.unwrap();
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

async fn run_pulsebeam_subscriber() -> anyhow::Result<()> {
    let http_client = Box::new(reqwest::Client::new());
    let api = HttpApiClient::new(http_client, "http://localhost:7070")?;
    let socket = UdpSocket::bind("0.0.0.0:0").await?;
    let mut driver = AgentBuilder::new(api, socket).connect("demo").await?;

    driver.declare_subscribe_topic("ping")?;
    let mut join_set = JoinSet::new();

    while let Some(ev) = driver.poll().await {
        match ev {
            AgentEvent::DataSubscriberDeclared(subscriber) => {
                join_set.spawn(handle_data_subscriber(subscriber));
            }
            _ev => {
                tracing::warn!("unhandled event");
            }
        }
    }
    join_set.join_all().await;

    Ok(())
}

async fn handle_data_subscriber(mut subscriber: DataSubscriber) {
    while let Ok(payload) = subscriber.recv().await {
        let bytes: [u8; 16] = payload[..16].try_into().unwrap();
        let us = u128::from_be_bytes(bytes);
        let started_at = Duration::from_micros(us as u64);
        let now = wallclock_at(Instant::now())
            .duration_since(UNIX_EPOCH)
            .unwrap();
        let elapsed = now - started_at;
        tracing::info!("latency: {:.3}ms", elapsed.as_secs_f64() * 1000.0);
    }
}
