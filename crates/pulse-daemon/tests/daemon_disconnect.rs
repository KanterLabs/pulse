use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use pulse_daemon::{
    BUS_NAME, CacheLimits, CacheRepository, CachedResponse, INTERFACE, OBJECT_PATH,
};
use tokio::io::AsyncBufReadExt;
use tokio::process::{Child, Command};
use tokio::time::{sleep, timeout};
use zbus::Connection;
use zbus::connection::Builder;

const START_TIMEOUT: Duration = Duration::from_secs(10);
const EXIT_TIMEOUT: Duration = Duration::from_secs(5);
const CONFIG: &str = "[server]\npoll_interval_seconds = 3600\n";

fn isolated_command(program: &str, root: &Path) -> Command {
    let mut command = Command::new(program);
    command
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("HOME", root.join("home"))
        .env("XDG_CONFIG_HOME", root.join("config"))
        .env("XDG_DATA_HOME", root.join("data"))
        .env("XDG_CACHE_HOME", root.join("cache"))
        .env("XDG_RUNTIME_DIR", root.join("runtime"))
        .stdin(Stdio::null())
        .kill_on_drop(true);
    command
}

async fn start_bus(root: &Path, address: &str) -> Child {
    // A killed test bus may leave its socket behind. Only the test-owned socket is removed.
    let socket = root.join("runtime/bus");
    if socket.exists() {
        std::fs::remove_file(socket).unwrap();
    }
    let mut bus = isolated_command("dbus-daemon", root)
        .args(["--session", "--nofork", "--print-address=1"])
        .arg(format!("--address={address}"))
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("dbus-daemon must be installed for the isolated daemon test");
    let stdout = bus.stdout.take().unwrap();
    let mut stdout = tokio::io::BufReader::new(stdout);
    let mut published_address = String::new();
    timeout(START_TIMEOUT, stdout.read_line(&mut published_address))
        .await
        .expect("private bus did not start in time")
        .expect("private bus address could not be read");
    assert!(
        !published_address.trim().is_empty(),
        "private bus failed to start"
    );
    bus
}

async fn call_json(connection: &Connection, method: &str) -> zbus::Result<serde_json::Value> {
    let reply = connection
        .call_method(Some(BUS_NAME), OBJECT_PATH, Some(INTERFACE), method, &())
        .await?;
    let payload = reply.body().deserialize::<String>()?;
    Ok(serde_json::from_str(&payload).expect("daemon must return valid JSON"))
}

async fn wait_until_ready(connection: &Connection, daemon: &mut Child, log: &Path) {
    let dbus = zbus::fdo::DBusProxy::new(connection).await.unwrap();
    let result = timeout(START_TIMEOUT, async {
        loop {
            assert!(
                daemon.try_wait().unwrap().is_none(),
                "daemon exited during startup: {}",
                std::fs::read_to_string(log).unwrap()
            );
            // Check ownership first so the test never activates a service from the host.
            if dbus
                .name_has_owner(BUS_NAME.try_into().unwrap())
                .await
                .unwrap()
                && let Ok(health) = call_json(connection, "Health").await
                && health["last_refresh"].as_i64().is_some()
            {
                let auth = call_json(connection, "GetAuthState").await.unwrap();
                assert_eq!(auth["configured"], false);
                return;
            }
            sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    assert!(
        result.is_ok(),
        "daemon did not become ready: {}",
        std::fs::read_to_string(log).unwrap()
    );
}

#[tokio::test]
async fn bus_loss_exits_without_waiting_for_poll_and_restart_preserves_data() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    for name in ["home", "config/pulse", "data/pulse", "cache", "runtime"] {
        std::fs::create_dir_all(root.join(name)).unwrap();
    }
    std::fs::set_permissions(root.join("runtime"), std::fs::Permissions::from_mode(0o700)).unwrap();
    let config = root.join("config/pulse/config.toml");
    std::fs::write(&config, CONFIG).unwrap();
    let cache = CacheRepository::open(
        root.join("data/pulse/pulse.sqlite3"),
        CacheLimits::default(),
    )
    .unwrap();
    let saved = CachedResponse {
        key: "preserved-response".into(),
        source_url: "https://example.invalid/test-fixture".into(),
        payload: br#"{"items":[{"name":"Saved music"}]}"#.to_vec(),
        etag: Some("existing-etag".into()),
        fetched_at: 1,
        expires_at: i64::MAX,
    };
    cache.put_response(&saved).unwrap();

    // Restart the private bus at the same address, as a supervised daemon would see it.
    let address = format!("unix:path={}", root.join("runtime/bus").display());
    for cycle in 0..2 {
        let mut bus = start_bus(root, &address).await;
        let log = root.join(format!("daemon-{cycle}.log"));
        let mut daemon = isolated_command(env!("CARGO_BIN_EXE_pulse-daemon"), root)
            .env("DBUS_SESSION_BUS_ADDRESS", &address)
            .stdout(Stdio::null())
            .stderr(std::fs::File::create(&log).unwrap())
            .spawn()
            .expect("actual Pulse daemon should start");
        let connection = timeout(
            START_TIMEOUT,
            Builder::address(address.as_str())
                .unwrap()
                .method_timeout(Duration::from_secs(1))
                .build(),
        )
        .await
        .unwrap()
        .unwrap();
        wait_until_ready(&connection, &mut daemon, &log).await;

        timeout(EXIT_TIMEOUT, bus.kill()).await.unwrap().unwrap();
        let status = timeout(EXIT_TIMEOUT, daemon.wait()).await;
        assert!(
            status.is_ok(),
            "daemon stayed alive after its session bus died; restart would never run: {}",
            std::fs::read_to_string(&log).unwrap()
        );
        let status = status.unwrap().unwrap();
        assert!(
            !status.success() && status.code().is_some(),
            "daemon must return an error exit status for Restart=on-failure, got {status}: {}",
            std::fs::read_to_string(&log).unwrap()
        );
        assert_eq!(std::fs::read_to_string(&config).unwrap(), CONFIG);
        assert_eq!(cache.get_response(&saved.key).unwrap(), Some(saved.clone()));
    }
}
