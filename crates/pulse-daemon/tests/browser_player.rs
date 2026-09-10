use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use pulse_daemon::{BrowserPlayer, PlaybackSnapshot, PlaybackStatus, PulseError};
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;

const SECRET_ONE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SECRET_TWO: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

#[derive(Clone, Default)]
struct BridgeState {
    requests: Arc<Mutex<Vec<RequestRecord>>>,
    snapshot: Arc<Mutex<String>>,
    delay_commands: bool,
}

#[derive(Debug, Clone)]
struct RequestRecord {
    path: String,
    authorization: String,
    body: String,
}

async fn spawn_bridge(state: BridgeState) -> (u16, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };
            let state = state.clone();
            tokio::spawn(async move {
                handle_request(stream, state).await;
            });
        }
    });
    (port, task)
}

async fn handle_request(mut stream: TcpStream, state: BridgeState) {
    let Some((headers, body)) = read_request(&mut stream).await else {
        return;
    };
    let mut lines = headers.lines();
    let Some(request_line) = lines.next() else {
        return;
    };
    let mut request_parts = request_line.split_whitespace();
    let _method = request_parts.next().unwrap_or_default().to_owned();
    let path = request_parts.next().unwrap_or_default().to_owned();
    let authorization = lines
        .find_map(|line| {
            line.strip_prefix("Authorization: ")
                .or_else(|| line.strip_prefix("authorization: "))
        })
        .unwrap_or_default()
        .to_owned();
    state.requests.lock().await.push(RequestRecord {
        path: path.clone(),
        authorization,
        body,
    });

    if path == "/bridge/command" && state.delay_commands {
        tokio::time::sleep(Duration::from_secs(6)).await;
        return;
    }
    let (status, response) = if path == "/bridge/snapshot" {
        (200, state.snapshot.lock().await.clone())
    } else if path == "/bridge/auth" {
        (
            200,
            r#"{"configured":true,"authenticated":true}"#.to_owned(),
        )
    } else if path == "/bridge/token" {
        (
            200,
            r#"{"access_token":"short-lived","expires_in":3600,"scope":"streaming"}"#.to_owned(),
        )
    } else if path == "/bridge/login" {
        (200, r#"{"url":"http://127.0.0.1:39999/"}"#.to_owned())
    } else if path == "/bridge/command" || path == "/bridge/logout" {
        (200, r#"{"ok":true}"#.to_owned())
    } else {
        (404, r#"{"error":"not_found"}"#.to_owned())
    };
    let status_text = if status == 200 { "OK" } else { "Not Found" };
    let response = format!(
        "HTTP/1.1 {status} {status_text}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",
        response.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
}

async fn read_request(stream: &mut TcpStream) -> Option<(String, String)> {
    let mut bytes = Vec::new();
    let header_end;
    loop {
        let mut chunk = [0_u8; 1024];
        let count = stream.read(&mut chunk).await.ok()?;
        if count == 0 {
            return None;
        }
        bytes.extend_from_slice(&chunk[..count]);
        if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            header_end = index;
            break;
        }
        if bytes.len() > 16 * 1024 {
            return None;
        }
    }
    let headers = String::from_utf8_lossy(&bytes[..header_end]).into_owned();
    let content_length = headers
        .lines()
        .find_map(|line| line.strip_prefix("Content-Length: "))
        .or_else(|| {
            headers
                .lines()
                .find_map(|line| line.strip_prefix("content-length: "))
        })
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    let body_start = header_end + 4;
    while bytes.len().saturating_sub(body_start) < content_length {
        let mut chunk = [0_u8; 1024];
        let count = stream.read(&mut chunk).await.ok()?;
        if count == 0 {
            return None;
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
    let body_end = body_start + content_length;
    Some((
        headers,
        String::from_utf8_lossy(&bytes[body_start..body_end]).into_owned(),
    ))
}

fn playing_snapshot(title: &str) -> String {
    PlaybackSnapshot {
        status: PlaybackStatus::Playing,
        title: Some(title.into()),
        artist: Some("Artist".into()),
        album: Some("Album".into()),
        art_url: None,
        spotify_url: Some("spotify:track:1234567890123456789012".into()),
        length_us: Some(100),
        position_us: Some(5),
        playing: true,
        can_control: true,
        can_go_next: true,
        can_go_previous: true,
        can_seek: true,
        offline: false,
        error: None,
    }
    .to_json()
}

fn runtime_root() -> (TempDir, PathBuf) {
    let root = tempfile::tempdir().unwrap();
    let runtime = root.path().join("runtime");
    std::fs::create_dir(&runtime).unwrap();
    std::fs::set_permissions(&runtime, std::fs::Permissions::from_mode(0o700)).unwrap();
    let bridge = runtime.join("pulse-player");
    std::fs::create_dir(&bridge).unwrap();
    std::fs::set_permissions(&bridge, std::fs::Permissions::from_mode(0o700)).unwrap();
    (root, runtime)
}

fn write_descriptor(runtime: &Path, port: u16, secret: &str) -> PathBuf {
    let descriptor = runtime.join("pulse-player/bridge.json");
    std::fs::write(
        &descriptor,
        format!(r#"{{"port":{port},"secret":"{secret}"}}"#),
    )
    .unwrap();
    std::fs::set_permissions(&descriptor, std::fs::Permissions::from_mode(0o600)).unwrap();
    descriptor
}

#[tokio::test]
async fn descriptor_auth_commands_and_fresh_restart_are_supported() {
    let (_root, runtime) = runtime_root();
    let state = BridgeState {
        snapshot: Arc::new(Mutex::new(playing_snapshot("First"))),
        ..BridgeState::default()
    };
    let (port, server) = spawn_bridge(state.clone()).await;
    let descriptor = write_descriptor(&runtime, port, SECRET_ONE);
    let player = BrowserPlayer::new_with_runtime_dir(&runtime).unwrap();

    let snapshot = player.snapshot().await.unwrap();
    assert_eq!(snapshot.title.as_deref(), Some("First"));
    player.play_pause().await.unwrap();
    player.seek(20).await.unwrap();
    player
        .open_uri("spotify:track:1234567890123456789012")
        .await
        .unwrap();
    assert!(player.auth_state().await.unwrap().authenticated);
    assert_eq!(player.token().await.unwrap().expires_in, 3600);
    assert!(
        player
            .begin_login()
            .await
            .unwrap()
            .starts_with("http://127.0.0.1:")
    );
    player.logout().await.unwrap();

    let requests = state.requests.lock().await.clone();
    assert!(
        requests
            .iter()
            .all(|request| request.authorization == format!("Bearer {SECRET_ONE}"))
    );
    let command_bodies: Vec<_> = requests
        .iter()
        .filter(|request| request.path == "/bridge/command")
        .map(|request| request.body.clone())
        .collect();
    assert!(
        command_bodies
            .iter()
            .any(|body| body.contains("play_pause"))
    );
    assert!(
        command_bodies
            .iter()
            .any(|body| body.contains("\"position_us\":20"))
    );
    assert!(command_bodies.iter().any(|body| body.contains("open_uri")));

    *state.snapshot.lock().await = playing_snapshot("Restarted");
    write_descriptor(&runtime, port, SECRET_TWO);
    assert_eq!(
        player.snapshot().await.unwrap().title.as_deref(),
        Some("Restarted")
    );
    let requests = state.requests.lock().await.clone();
    assert_eq!(
        requests.last().unwrap().authorization,
        format!("Bearer {SECRET_TWO}")
    );
    std::fs::remove_file(descriptor).unwrap();
    let disconnected = player.snapshot().await.unwrap();
    assert_eq!(disconnected.status, PlaybackStatus::Disconnected);
    assert!(disconnected.error.unwrap().contains("browser player"));
    server.abort();
}

#[tokio::test]
async fn unsafe_descriptor_and_external_uri_are_rejected_without_network_fallback() {
    let (_root, runtime) = runtime_root();
    let state = BridgeState {
        snapshot: Arc::new(Mutex::new(playing_snapshot("Safe"))),
        ..BridgeState::default()
    };
    let (port, server) = spawn_bridge(state.clone()).await;
    let descriptor = write_descriptor(&runtime, port, SECRET_ONE);
    let player = BrowserPlayer::new_with_runtime_dir(&runtime).unwrap();

    let error = player
        .open_uri("https://open.spotify.com/track/1234567890123456789012")
        .await
        .unwrap_err();
    assert!(matches!(error, PulseError::InvalidInput(_)));
    assert!(state.requests.lock().await.is_empty());

    std::fs::set_permissions(&descriptor, std::fs::Permissions::from_mode(0o644)).unwrap();
    let disconnected = player.snapshot().await.unwrap();
    assert_eq!(disconnected.status, PlaybackStatus::Disconnected);
    assert!(
        disconnected
            .error
            .as_deref()
            .is_some_and(|error| error.contains("permissions"))
    );
    server.abort();
}

#[tokio::test]
async fn command_timeout_is_bounded() {
    let (_root, runtime) = runtime_root();
    let state = BridgeState {
        snapshot: Arc::new(Mutex::new(playing_snapshot("Slow"))),
        delay_commands: true,
        ..BridgeState::default()
    };
    let (port, server) = spawn_bridge(state).await;
    write_descriptor(&runtime, port, SECRET_ONE);
    let player = BrowserPlayer::new_with_runtime_dir(&runtime).unwrap();

    let started = Instant::now();
    let error = player.play_pause().await.unwrap_err();
    assert!(started.elapsed() < Duration::from_secs(6));
    assert!(error.to_string().contains("did not respond"));

    server.abort();
}

#[tokio::test]
async fn oversized_snapshot_response_is_rejected() {
    let (_root, runtime) = runtime_root();
    let state = BridgeState {
        snapshot: Arc::new(Mutex::new("x".repeat(1024 * 1024 + 1))),
        ..BridgeState::default()
    };
    let (port, server) = spawn_bridge(state).await;
    write_descriptor(&runtime, port, SECRET_ONE);
    let player = BrowserPlayer::new_with_runtime_dir(&runtime).unwrap();

    let error = player.snapshot().await.unwrap_err();
    assert!(matches!(error, PulseError::PayloadTooLarge { .. }));
    server.abort();
}
