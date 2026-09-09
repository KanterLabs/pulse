use std::collections::HashMap;
use std::process::Stdio;
use std::time::Duration;

use pulse_daemon::{DaemonState, MprisClient, PlaybackStatus};
use tokio::io::AsyncBufReadExt;
use tokio::time::{sleep, timeout};
use zbus::connection::{Builder, Connection};
use zbus::zvariant::OwnedValue;

const MPRIS_PATH: &str = "/org/mpris/MediaPlayer2";
const PRIMARY_NAME: &str = "org.mpris.MediaPlayer2.spotify";
const REPLACEMENT_NAME: &str = "org.mpris.MediaPlayer2.spotify.instance2";

#[derive(Debug, Default)]
struct FakePlayer;

#[zbus::interface(name = "org.mpris.MediaPlayer2.Player")]
#[allow(clippy::unused_self)] // D-Bus property getters require a receiver, even for fixed fixtures.
impl FakePlayer {
    #[zbus(property)]
    fn playback_status(&self) -> String {
        "Paused".into()
    }

    #[zbus(property)]
    fn metadata(&self) -> HashMap<String, OwnedValue> {
        HashMap::new()
    }

    #[zbus(property)]
    fn position(&self) -> i64 {
        0
    }

    #[zbus(property)]
    fn can_control(&self) -> bool {
        true
    }

    #[zbus(property)]
    fn can_go_next(&self) -> bool {
        true
    }

    #[zbus(property)]
    fn can_go_previous(&self) -> bool {
        true
    }

    #[zbus(property)]
    fn can_seek(&self) -> bool {
        true
    }
}

async fn connect_to(address: &str) -> zbus::Result<Connection> {
    Builder::address(address)?.build().await
}

async fn start_player(address: &str, name: &str) -> zbus::Result<Connection> {
    let connection = connect_to(address).await?;
    connection.request_name(name).await?;
    connection
        .object_server()
        .at(MPRIS_PATH, FakePlayer)
        .await?;
    Ok(connection)
}

async fn wait_for_owner(connection: &Connection, name: &str, expected: bool) -> zbus::Result<()> {
    let dbus = zbus::fdo::DBusProxy::new(connection).await?;
    let name = zbus::names::BusName::try_from(name).expect("test MPRIS bus name must be valid");
    timeout(Duration::from_secs(5), async {
        loop {
            if dbus.name_has_owner(name.as_ref()).await? == expected {
                return Ok(());
            }
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .map_err(|error| zbus::Error::Failure(error.to_string()))?
}

#[tokio::test]
async fn disappearing_mpris_owner_is_disconnected_and_replaced_owner_is_found() {
    let mut bus = tokio::process::Command::new("dbus-daemon")
        .args(["--session", "--nofork", "--print-address=1"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .expect("dbus-daemon must be installed for the isolated MPRIS test");
    let stdout = bus
        .stdout
        .take()
        .expect("isolated dbus-daemon stdout must be piped");
    let mut stdout = tokio::io::BufReader::new(stdout);
    let mut address = String::new();
    timeout(Duration::from_secs(5), stdout.read_line(&mut address))
        .await
        .expect("isolated dbus-daemon did not print an address in time")
        .expect("reading isolated dbus-daemon address failed");
    let address = address.trim().to_owned();
    assert!(!address.is_empty(), "isolated dbus-daemon address is empty");

    let service = start_player(&address, PRIMARY_NAME)
        .await
        .expect("primary fake MPRIS service should start");
    let client_connection = connect_to(&address)
        .await
        .expect("MPRIS client should connect to the private bus");
    let client = MprisClient::new(client_connection.clone());
    let state = DaemonState::new(Some(client.clone()), None, None);
    let initial = state
        .refresh()
        .await
        .expect("initial fake MPRIS snapshot should succeed");
    assert_eq!(initial.status, PlaybackStatus::Paused);
    assert!(!initial.offline);
    assert!(initial.can_control);
    assert!(state.health().mpris_available);

    drop(service);
    wait_for_owner(&client_connection, PRIMARY_NAME, false)
        .await
        .expect("private bus should release the primary MPRIS owner");
    let disconnected = state
        .refresh()
        .await
        .expect("owner loss should become a disconnected snapshot");
    assert_eq!(disconnected.status, PlaybackStatus::Disconnected);
    assert!(disconnected.offline);
    assert!(!disconnected.can_control);
    assert!(!state.health().mpris_available);
    assert_eq!(client.player_name(), None);

    let replacement = start_player(&address, REPLACEMENT_NAME)
        .await
        .expect("replacement fake MPRIS service should start");
    wait_for_owner(&client_connection, REPLACEMENT_NAME, true)
        .await
        .expect("private bus should expose the replacement MPRIS owner");
    let reconnected = state
        .refresh()
        .await
        .expect("replacement owner snapshot should succeed");
    assert_eq!(reconnected.status, PlaybackStatus::Paused);
    assert!(!reconnected.offline);
    assert!(reconnected.can_control);
    assert!(state.health().mpris_available);
    assert_eq!(client.player_name().as_deref(), Some(REPLACEMENT_NAME));

    drop(replacement);
    client_connection
        .close()
        .await
        .expect("MPRIS client connection should close");
    bus.kill().await.expect("isolated dbus-daemon should stop");
    let _ = bus.wait().await;
}
