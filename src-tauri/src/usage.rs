use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    env,
    fs::{self, File},
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const LOOKBACK_DAYS: u64 = 30;
const LEDGER_SCHEMA_VERSION: i64 = 2;
const PREFIX_HASH_BYTES: u64 = 4096;

#[derive(Debug, Clone, Default, Serialize)]
struct TokenCounts {
    input_tokens: u64,
    cached_input_tokens: u64,
    output_tokens: u64,
    reasoning_output_tokens: u64,
    total_tokens: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
struct MinuteBucket {
    minute: String,
    input_tokens: u64,
    cached_input_tokens: u64,
    output_tokens: u64,
    reasoning_output_tokens: u64,
    total_tokens: u64,
    events: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
struct Totals {
    input_tokens: u64,
    cached_input_tokens: u64,
    output_tokens: u64,
    reasoning_output_tokens: u64,
    total_tokens: u64,
    events: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
struct CreditsSnapshot {
    has_credits: bool,
    unlimited: bool,
    balance: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
struct RateLimitSnapshot {
    used_percent: Option<f64>,
    window_minutes: Option<u64>,
    resets_at: Option<i64>,
    plan_type: Option<String>,
    credits: Option<CreditsSnapshot>,
}

#[derive(Debug, Clone, Default, Serialize)]
struct RateLimitPoint {
    minute: String,
    used_percent: f64,
    remaining_percent: f64,
    window_minutes: Option<u64>,
    resets_at: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize)]
struct LatestUsage {
    timestamp: String,
    minute: String,
    last: TokenCounts,
    total: TokenCounts,
    model_context_window: Option<u64>,
    rate_limit: Option<RateLimitSnapshot>,
}

#[derive(Debug, Clone, Default, Serialize)]
struct SessionSummary {
    id: String,
    first_seen: Option<String>,
    last_seen: Option<String>,
    total_tokens: u64,
    input_tokens: u64,
    cached_input_tokens: u64,
    output_tokens: u64,
    reasoning_output_tokens: u64,
    events: u64,
    last_cumulative_total: u64,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct UsageDashboard {
    scanned_at_ms: u64,
    lookback_days: u64,
    codex_sessions_path: String,
    storage_path: String,
    totals: Totals,
    latest: Option<LatestUsage>,
    buckets: Vec<MinuteBucket>,
    rate_limit_points: Vec<RateLimitPoint>,
    sessions: Vec<SessionSummary>,
    errors: Vec<String>,
}

#[derive(Debug)]
struct SessionCursor {
    processed_offset: u64,
    prefix_length: u64,
    prefix_hash: Vec<u8>,
    active_model: Option<String>,
}

pub(crate) fn scan_codex_usage() -> Result<UsageDashboard, String> {
    scan_usage_at(&codex_home_dir(), &ledger_path())
}

pub(crate) fn reset_token_history() -> Result<UsageDashboard, String> {
    reset_token_history_at(&codex_home_dir(), &ledger_path())
}

fn scan_usage_at(codex_home: &Path, storage_path: &Path) -> Result<UsageDashboard, String> {
    let mut connection = open_ledger(storage_path)?;
    let mut errors = Vec::new();
    let files = collect_codex_jsonl_files(codex_home, &mut errors);

    ingest_files(&mut connection, &files, &mut errors)?;
    query_dashboard(&connection, codex_home, storage_path, errors)
}

fn reset_token_history_at(
    codex_home: &Path,
    storage_path: &Path,
) -> Result<UsageDashboard, String> {
    let mut connection = open_ledger(storage_path)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute("DELETE FROM token_events", [])
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO meta(key, value)
             VALUES('token_history_floor', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;

    scan_usage_at(codex_home, storage_path)
}

fn open_ledger(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| error.to_string())?;
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(|error| error.to_string())?;
    connection
        .pragma_update(None, "synchronous", "NORMAL")
        .map_err(|error| error.to_string())?;

    initialize_schema(&connection)?;
    Ok(connection)
}

fn initialize_schema(connection: &Connection) -> Result<(), String> {
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;

    if version > LEDGER_SCHEMA_VERSION {
        return Err(format!(
            "Usage ledger schema {} is newer than supported schema {}",
            version, LEDGER_SCHEMA_VERSION
        ));
    }

    if version == 0 {
        connection
            .execute_batch(
                "BEGIN;
                 CREATE TABLE token_events (
                     event_key BLOB PRIMARY KEY,
                     session_id TEXT NOT NULL,
                     timestamp TEXT NOT NULL,
                     minute TEXT NOT NULL,
                     input_tokens INTEGER NOT NULL,
                     cached_input_tokens INTEGER NOT NULL,
                     output_tokens INTEGER NOT NULL,
                     reasoning_output_tokens INTEGER NOT NULL,
                     total_tokens INTEGER NOT NULL,
                     cumulative_input_tokens INTEGER NOT NULL,
                     cumulative_cached_input_tokens INTEGER NOT NULL,
                     cumulative_output_tokens INTEGER NOT NULL,
                     cumulative_reasoning_output_tokens INTEGER NOT NULL,
                     cumulative_total_tokens INTEGER NOT NULL,
                     model_context_window INTEGER
                 );
                 CREATE INDEX token_events_timestamp_idx ON token_events(timestamp);
                 CREATE INDEX token_events_session_timestamp_idx
                     ON token_events(session_id, timestamp);
                 CREATE TABLE quota_snapshots (
                     event_key BLOB PRIMARY KEY,
                     timestamp TEXT NOT NULL,
                     minute TEXT NOT NULL,
                     used_percent REAL,
                     window_minutes INTEGER,
                     resets_at INTEGER,
                     plan_type TEXT,
                     credits_has INTEGER,
                     credits_unlimited INTEGER,
                     credits_balance TEXT
                 );
                 CREATE INDEX quota_snapshots_timestamp_idx ON quota_snapshots(timestamp);
                 CREATE TABLE session_cursors (
                     session_id TEXT PRIMARY KEY,
                     processed_offset INTEGER NOT NULL,
                     prefix_length INTEGER NOT NULL,
                     prefix_hash BLOB NOT NULL,
                     active_model TEXT,
                     source_path TEXT NOT NULL,
                     updated_at_ms INTEGER NOT NULL
                 );
                 CREATE TABLE meta (
                     key TEXT PRIMARY KEY,
                     value TEXT NOT NULL
                 );
                 PRAGMA user_version = 2;
                 COMMIT;",
            )
            .map_err(|error| error.to_string())?;

        return Ok(());
    }

    if version == 1 {
        connection
            .execute_batch(
                "BEGIN;
                 DELETE FROM quota_snapshots;
                 DELETE FROM session_cursors;
                 PRAGMA user_version = 2;
                 COMMIT;",
            )
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

fn ingest_files(
    connection: &mut Connection,
    files: &[PathBuf],
    errors: &mut Vec<String>,
) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let history_floor = transaction
        .query_row(
            "SELECT value FROM meta WHERE key = 'token_history_floor'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .unwrap_or_default();

    for path in files {
        if let Err(error) = ingest_session_file(&transaction, path, &history_floor) {
            errors.push(format!("{}: {}", path.display(), error));
        }
    }

    transaction.commit().map_err(|error| error.to_string())
}

fn ingest_session_file(
    transaction: &Transaction<'_>,
    path: &Path,
    history_floor: &str,
) -> Result<(), String> {
    let session_id = session_id_from_path(path);
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    let file_length = metadata.len();
    let cursor = load_session_cursor(transaction, &session_id)?;

    let (start_offset, mut active_model, prefix_length, prefix_hash) = match cursor {
        Some(cursor)
            if cursor.processed_offset <= file_length
                && cursor.prefix_length <= file_length
                && file_prefix_hash(path, cursor.prefix_length)? == cursor.prefix_hash =>
        {
            (
                cursor.processed_offset,
                cursor.active_model,
                cursor.prefix_length,
                cursor.prefix_hash,
            )
        }
        _ => {
            let prefix_length = file_length.min(PREFIX_HASH_BYTES);
            (
                0,
                None,
                prefix_length,
                file_prefix_hash(path, prefix_length)?,
            )
        }
    };

    let mut file = File::open(path).map_err(|error| error.to_string())?;
    file.seek(SeekFrom::Start(start_offset))
        .map_err(|error| error.to_string())?;
    let mut reader = BufReader::new(file);
    let mut processed_offset = start_offset;

    loop {
        let mut raw_line = Vec::new();
        let bytes_read = reader
            .read_until(b'\n', &mut raw_line)
            .map_err(|error| error.to_string())?;
        if bytes_read == 0 {
            break;
        }
        if raw_line.last() != Some(&b'\n') {
            break;
        }

        processed_offset = processed_offset.saturating_add(bytes_read as u64);
        raw_line.pop();
        if raw_line.last() == Some(&b'\r') {
            raw_line.pop();
        }

        if !raw_line
            .windows(b"\"token_count\"".len())
            .any(|window| window == b"\"token_count\"")
            && !raw_line
                .windows(b"\"turn_context\"".len())
                .any(|window| window == b"\"turn_context\"")
        {
            continue;
        }

        let value: Value = match serde_json::from_slice(&raw_line) {
            Ok(value) => value,
            Err(_) => continue,
        };

        if value.get("type").and_then(Value::as_str) == Some("turn_context") {
            active_model = value
                .get("payload")
                .and_then(|payload| payload.get("model"))
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
            continue;
        }

        if value.get("type").and_then(Value::as_str) != Some("event_msg") {
            continue;
        }
        let payload = value.get("payload").unwrap_or(&Value::Null);
        if payload.get("type").and_then(Value::as_str) != Some("token_count") {
            continue;
        }

        let timestamp = match value.get("timestamp").and_then(Value::as_str) {
            Some(timestamp) => timestamp,
            None => continue,
        };
        let minute = minute_key(timestamp);
        let info = payload.get("info").unwrap_or(&Value::Null);
        let last = token_counts(info.get("last_token_usage").unwrap_or(&Value::Null));
        let cumulative = token_counts(info.get("total_token_usage").unwrap_or(&Value::Null));
        let model_context_window = info.get("model_context_window").and_then(Value::as_u64);
        let event_key = event_key(&session_id, &raw_line);

        if history_floor.is_empty() || timestamp > history_floor {
            insert_token_event(
                transaction,
                &event_key,
                &session_id,
                timestamp,
                &minute,
                &last,
                &cumulative,
                model_context_window,
            )?;
        }

        if let Some(snapshot) = rate_limit_snapshot(
            payload.get("rate_limits").unwrap_or(&Value::Null),
            active_model.as_deref(),
            model_context_window,
        ) {
            insert_quota_snapshot(transaction, &event_key, timestamp, &minute, &snapshot)?;
        }
    }

    transaction
        .execute(
            "INSERT INTO session_cursors(
                 session_id, processed_offset, prefix_length, prefix_hash,
                 active_model, source_path, updated_at_ms
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(session_id) DO UPDATE SET
                 processed_offset = excluded.processed_offset,
                 prefix_length = excluded.prefix_length,
                 prefix_hash = excluded.prefix_hash,
                 active_model = excluded.active_model,
                 source_path = excluded.source_path,
                 updated_at_ms = excluded.updated_at_ms",
            params![
                session_id,
                processed_offset as i64,
                prefix_length as i64,
                prefix_hash,
                active_model,
                path.to_string_lossy(),
                now_ms() as i64,
            ],
        )
        .map_err(|error| error.to_string())?;

    Ok(())
}

fn load_session_cursor(
    transaction: &Transaction<'_>,
    session_id: &str,
) -> Result<Option<SessionCursor>, String> {
    transaction
        .query_row(
            "SELECT processed_offset, prefix_length, prefix_hash, active_model
             FROM session_cursors WHERE session_id = ?1",
            [session_id],
            |row| {
                Ok(SessionCursor {
                    processed_offset: nonnegative_u64(row.get::<_, i64>(0)?),
                    prefix_length: nonnegative_u64(row.get::<_, i64>(1)?),
                    prefix_hash: row.get(2)?,
                    active_model: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())
}

#[allow(clippy::too_many_arguments)]
fn insert_token_event(
    transaction: &Transaction<'_>,
    event_key: &[u8],
    session_id: &str,
    timestamp: &str,
    minute: &str,
    last: &TokenCounts,
    cumulative: &TokenCounts,
    model_context_window: Option<u64>,
) -> Result<(), String> {
    transaction
        .execute(
            "INSERT OR IGNORE INTO token_events(
                 event_key, session_id, timestamp, minute,
                 input_tokens, cached_input_tokens, output_tokens,
                 reasoning_output_tokens, total_tokens,
                 cumulative_input_tokens, cumulative_cached_input_tokens,
                 cumulative_output_tokens, cumulative_reasoning_output_tokens,
                 cumulative_total_tokens, model_context_window
             ) VALUES(
                 ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
                 ?10, ?11, ?12, ?13, ?14, ?15
             )",
            params![
                event_key,
                session_id,
                timestamp,
                minute,
                last.input_tokens as i64,
                last.cached_input_tokens as i64,
                last.output_tokens as i64,
                last.reasoning_output_tokens as i64,
                last.total_tokens as i64,
                cumulative.input_tokens as i64,
                cumulative.cached_input_tokens as i64,
                cumulative.output_tokens as i64,
                cumulative.reasoning_output_tokens as i64,
                cumulative.total_tokens as i64,
                model_context_window.map(|value| value as i64),
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn insert_quota_snapshot(
    transaction: &Transaction<'_>,
    event_key: &[u8],
    timestamp: &str,
    minute: &str,
    snapshot: &RateLimitSnapshot,
) -> Result<(), String> {
    let credits_has = snapshot
        .credits
        .as_ref()
        .map(|credits| i64::from(credits.has_credits));
    let credits_unlimited = snapshot
        .credits
        .as_ref()
        .map(|credits| i64::from(credits.unlimited));
    let credits_balance = snapshot
        .credits
        .as_ref()
        .and_then(|credits| credits.balance.as_deref());

    transaction
        .execute(
            "INSERT OR IGNORE INTO quota_snapshots(
                 event_key, timestamp, minute, used_percent, window_minutes,
                 resets_at, plan_type, credits_has, credits_unlimited, credits_balance
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                event_key,
                timestamp,
                minute,
                snapshot.used_percent,
                snapshot.window_minutes.map(|value| value as i64),
                snapshot.resets_at,
                snapshot.plan_type,
                credits_has,
                credits_unlimited,
                credits_balance,
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn query_dashboard(
    connection: &Connection,
    codex_home: &Path,
    storage_path: &Path,
    errors: Vec<String>,
) -> Result<UsageDashboard, String> {
    let scanned_at_ms = now_ms();
    let totals = connection
        .query_row(
            "SELECT
                 COALESCE(SUM(input_tokens), 0),
                 COALESCE(SUM(cached_input_tokens), 0),
                 COALESCE(SUM(output_tokens), 0),
                 COALESCE(SUM(reasoning_output_tokens), 0),
                 COALESCE(SUM(total_tokens), 0),
                 COUNT(*)
             FROM token_events
             WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')",
            [],
            |row| {
                Ok(Totals {
                    input_tokens: nonnegative_u64(row.get(0)?),
                    cached_input_tokens: nonnegative_u64(row.get(1)?),
                    output_tokens: nonnegative_u64(row.get(2)?),
                    reasoning_output_tokens: nonnegative_u64(row.get(3)?),
                    total_tokens: nonnegative_u64(row.get(4)?),
                    events: nonnegative_u64(row.get(5)?),
                })
            },
        )
        .map_err(|error| error.to_string())?;

    let mut bucket_statement = connection
        .prepare(
            "SELECT minute,
                    SUM(input_tokens), SUM(cached_input_tokens), SUM(output_tokens),
                    SUM(reasoning_output_tokens), SUM(total_tokens), COUNT(*)
             FROM token_events
             WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')
             GROUP BY minute ORDER BY minute",
        )
        .map_err(|error| error.to_string())?;
    let buckets = bucket_statement
        .query_map([], |row| {
            Ok(MinuteBucket {
                minute: row.get(0)?,
                input_tokens: nonnegative_u64(row.get(1)?),
                cached_input_tokens: nonnegative_u64(row.get(2)?),
                output_tokens: nonnegative_u64(row.get(3)?),
                reasoning_output_tokens: nonnegative_u64(row.get(4)?),
                total_tokens: nonnegative_u64(row.get(5)?),
                events: nonnegative_u64(row.get(6)?),
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;

    let mut latest = query_latest_usage(connection)?;
    let current_quota = query_current_quota(connection, scanned_at_ms)?;
    if let Some((timestamp, minute, rate_limit)) = current_quota {
        if let Some(latest_usage) = latest.as_mut() {
            latest_usage.rate_limit = Some(rate_limit);
        } else {
            latest = Some(LatestUsage {
                timestamp,
                minute,
                rate_limit: Some(rate_limit),
                ..LatestUsage::default()
            });
        }
    }

    let rate_limit_points = query_rate_limit_points(connection)?;
    let sessions = query_sessions(connection)?;
    let session_paths = session_storage_dirs(codex_home)
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join("; ");

    Ok(UsageDashboard {
        scanned_at_ms,
        lookback_days: LOOKBACK_DAYS,
        codex_sessions_path: session_paths,
        storage_path: storage_path.to_string_lossy().to_string(),
        totals,
        latest,
        buckets,
        rate_limit_points,
        sessions,
        errors,
    })
}

fn query_latest_usage(connection: &Connection) -> Result<Option<LatestUsage>, String> {
    connection
        .query_row(
            "SELECT timestamp, minute,
                    input_tokens, cached_input_tokens, output_tokens,
                    reasoning_output_tokens, total_tokens,
                    cumulative_input_tokens, cumulative_cached_input_tokens,
                    cumulative_output_tokens, cumulative_reasoning_output_tokens,
                    cumulative_total_tokens, model_context_window
             FROM token_events ORDER BY timestamp DESC, event_key DESC LIMIT 1",
            [],
            |row| {
                Ok(LatestUsage {
                    timestamp: row.get(0)?,
                    minute: row.get(1)?,
                    last: TokenCounts {
                        input_tokens: nonnegative_u64(row.get(2)?),
                        cached_input_tokens: nonnegative_u64(row.get(3)?),
                        output_tokens: nonnegative_u64(row.get(4)?),
                        reasoning_output_tokens: nonnegative_u64(row.get(5)?),
                        total_tokens: nonnegative_u64(row.get(6)?),
                    },
                    total: TokenCounts {
                        input_tokens: nonnegative_u64(row.get(7)?),
                        cached_input_tokens: nonnegative_u64(row.get(8)?),
                        output_tokens: nonnegative_u64(row.get(9)?),
                        reasoning_output_tokens: nonnegative_u64(row.get(10)?),
                        total_tokens: nonnegative_u64(row.get(11)?),
                    },
                    model_context_window: row.get::<_, Option<i64>>(12)?.map(nonnegative_u64),
                    rate_limit: None,
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn query_current_quota(
    connection: &Connection,
    scanned_at_ms: u64,
) -> Result<Option<(String, String, RateLimitSnapshot)>, String> {
    connection
        .query_row(
            "SELECT timestamp, minute, used_percent, window_minutes, resets_at,
                    plan_type, credits_has, credits_unlimited, credits_balance
             FROM quota_snapshots
             WHERE resets_at IS NULL OR (resets_at > 0 AND resets_at * 1000 > ?1)
             ORDER BY timestamp DESC, event_key DESC LIMIT 1",
            [scanned_at_ms as i64],
            |row| {
                let credits_has = row.get::<_, Option<i64>>(6)?;
                let credits_unlimited = row.get::<_, Option<i64>>(7)?;
                let credits_balance = row.get::<_, Option<String>>(8)?;
                let credits = if credits_has.is_some()
                    || credits_unlimited.is_some()
                    || credits_balance.is_some()
                {
                    Some(CreditsSnapshot {
                        has_credits: credits_has.unwrap_or_default() != 0,
                        unlimited: credits_unlimited.unwrap_or_default() != 0,
                        balance: credits_balance,
                    })
                } else {
                    None
                };

                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    RateLimitSnapshot {
                        used_percent: row.get(2)?,
                        window_minutes: row.get::<_, Option<i64>>(3)?.map(nonnegative_u64),
                        resets_at: row.get(4)?,
                        plan_type: row.get(5)?,
                        credits,
                    },
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn query_rate_limit_points(connection: &Connection) -> Result<Vec<RateLimitPoint>, String> {
    let mut statement = connection
        .prepare(
            "SELECT minute, used_percent, window_minutes, resets_at
             FROM quota_snapshots
             WHERE used_percent IS NOT NULL
               AND timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')
             ORDER BY timestamp",
        )
        .map_err(|error| error.to_string())?;
    let points = statement
        .query_map([], |row| {
            let used_percent = row.get::<_, f64>(1)?;
            Ok(RateLimitPoint {
                minute: row.get(0)?,
                used_percent,
                remaining_percent: (100.0 - used_percent).clamp(0.0, 100.0),
                window_minutes: row.get::<_, Option<i64>>(2)?.map(nonnegative_u64),
                resets_at: row.get(3)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(points)
}

fn query_sessions(connection: &Connection) -> Result<Vec<SessionSummary>, String> {
    let mut statement = connection
        .prepare(
            "SELECT event.session_id,
                    MIN(event.timestamp), MAX(event.timestamp),
                    SUM(event.total_tokens), SUM(event.input_tokens),
                    SUM(event.cached_input_tokens), SUM(event.output_tokens),
                    SUM(event.reasoning_output_tokens), COUNT(*),
                    (SELECT latest.cumulative_total_tokens
                     FROM token_events latest
                     WHERE latest.session_id = event.session_id
                     ORDER BY latest.timestamp DESC, latest.event_key DESC LIMIT 1)
             FROM token_events event
             WHERE event.timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')
             GROUP BY event.session_id
             ORDER BY MAX(event.timestamp) DESC LIMIT 20",
        )
        .map_err(|error| error.to_string())?;
    let sessions = statement
        .query_map([], |row| {
            Ok(SessionSummary {
                id: row.get(0)?,
                first_seen: row.get(1)?,
                last_seen: row.get(2)?,
                total_tokens: nonnegative_u64(row.get(3)?),
                input_tokens: nonnegative_u64(row.get(4)?),
                cached_input_tokens: nonnegative_u64(row.get(5)?),
                output_tokens: nonnegative_u64(row.get(6)?),
                reasoning_output_tokens: nonnegative_u64(row.get(7)?),
                events: nonnegative_u64(row.get(8)?),
                last_cumulative_total: nonnegative_u64(row.get(9)?),
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(sessions)
}

fn collect_jsonl_files(dir: &Path, files: &mut Vec<PathBuf>, errors: &mut Vec<String>) {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) => {
            errors.push(format!("Failed to read {}: {}", dir.display(), error));
            return;
        }
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl_files(&path, files, errors);
        } else if path.extension().and_then(|extension| extension.to_str()) == Some("jsonl") {
            files.push(path);
        }
    }
}

fn collect_codex_jsonl_files(codex_home: &Path, errors: &mut Vec<String>) -> Vec<PathBuf> {
    let session_dirs = session_storage_dirs(codex_home);
    let mut files = Vec::new();
    let mut found_directory = false;

    for dir in &session_dirs {
        if dir.exists() {
            found_directory = true;
            collect_jsonl_files(dir, &mut files, errors);
        }
    }

    if !found_directory {
        errors.push(format!(
            "Codex session directories were not found: {}",
            session_dirs
                .iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }

    deduplicate_session_files(files)
}

fn session_storage_dirs(codex_home: &Path) -> [PathBuf; 2] {
    [
        codex_home.join("sessions"),
        codex_home.join("archived_sessions"),
    ]
}

fn deduplicate_session_files(files: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut unique: BTreeMap<String, PathBuf> = BTreeMap::new();
    for path in files {
        let session_id = session_id_from_path(&path);
        match unique.get(&session_id) {
            Some(current) if !prefer_session_file(&path, current) => {}
            _ => {
                unique.insert(session_id, path);
            }
        }
    }
    unique.into_values().collect()
}

fn prefer_session_file(candidate: &Path, current: &Path) -> bool {
    let candidate_metadata = fs::metadata(candidate).ok();
    let current_metadata = fs::metadata(current).ok();
    let candidate_length = candidate_metadata
        .as_ref()
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let current_length = current_metadata
        .as_ref()
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    if candidate_length != current_length {
        return candidate_length > current_length;
    }
    let candidate_modified = candidate_metadata.and_then(|metadata| metadata.modified().ok());
    let current_modified = current_metadata.and_then(|metadata| metadata.modified().ok());
    candidate_modified > current_modified
}

fn file_prefix_hash(path: &Path, length: u64) -> Result<Vec<u8>, String> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    let mut bytes = Vec::new();
    file.take(length)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    Ok(Sha256::digest(bytes).to_vec())
}

fn event_key(session_id: &str, raw_line: &[u8]) -> Vec<u8> {
    let mut hasher = Sha256::new();
    hasher.update(session_id.as_bytes());
    hasher.update([0]);
    hasher.update(raw_line);
    hasher.finalize().to_vec()
}

fn token_counts(value: &Value) -> TokenCounts {
    TokenCounts {
        input_tokens: value
            .get("input_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        cached_input_tokens: value
            .get("cached_input_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        output_tokens: value
            .get("output_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        reasoning_output_tokens: value
            .get("reasoning_output_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        total_tokens: value
            .get("total_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
    }
}

fn rate_limit_snapshot(
    value: &Value,
    model: Option<&str>,
    model_context_window: Option<u64>,
) -> Option<RateLimitSnapshot> {
    if !value.is_object()
        || is_spark_rate_limit(value)
        || is_spark_model(model, model_context_window)
    {
        return None;
    }

    let weekly = value
        .get("secondary")
        .filter(|candidate| is_weekly_rate_limit(candidate))
        .or_else(|| {
            value
                .get("primary")
                .filter(|candidate| is_weekly_rate_limit(candidate))
        })?;
    let credits_value = value.get("credits").unwrap_or(&Value::Null);
    let credits = credits_value.is_object().then(|| CreditsSnapshot {
        has_credits: credits_value
            .get("has_credits")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        unlimited: credits_value
            .get("unlimited")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        balance: credits_value
            .get("balance")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
    });

    Some(RateLimitSnapshot {
        used_percent: weekly.get("used_percent").and_then(Value::as_f64),
        window_minutes: weekly.get("window_minutes").and_then(Value::as_u64),
        resets_at: weekly.get("resets_at").and_then(Value::as_i64).or_else(|| {
            weekly
                .get("resets_at")
                .and_then(Value::as_u64)
                .map(|value| value as i64)
        }),
        plan_type: value
            .get("plan_type")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        credits,
    })
}

fn is_spark_rate_limit(value: &Value) -> bool {
    value
        .get("limit_id")
        .and_then(Value::as_str)
        .is_some_and(|limit_id| limit_id.eq_ignore_ascii_case("codex_bengalfox"))
        || value
            .get("limit_name")
            .and_then(Value::as_str)
            .is_some_and(|limit_name| limit_name.to_ascii_lowercase().contains("spark"))
}

fn is_spark_model(model: Option<&str>, model_context_window: Option<u64>) -> bool {
    model
        .map(|value| value.eq_ignore_ascii_case("gpt-5.3-codex-spark"))
        .unwrap_or(false)
        || model_context_window.is_some_and(|window| window <= 128_000)
}

fn is_weekly_rate_limit(value: &Value) -> bool {
    value
        .get("window_minutes")
        .and_then(Value::as_u64)
        .map(|minutes| minutes >= 7 * 24 * 60)
        .unwrap_or(false)
}

fn minute_key(timestamp: &str) -> String {
    if timestamp.len() >= 16 {
        format!("{}:00Z", &timestamp[..16])
    } else {
        timestamp.to_string()
    }
}

fn session_id_from_path(path: &Path) -> String {
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("unknown-session");
    if stem.len() >= 36 {
        stem[stem.len() - 36..].to_string()
    } else {
        stem.to_string()
    }
}

fn nonnegative_u64(value: i64) -> u64 {
    value.max(0) as u64
}

fn ledger_path() -> PathBuf {
    app_data_dir().join("usage-ledger.sqlite")
}

fn codex_home_dir() -> PathBuf {
    env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".codex"))
}

fn app_data_dir() -> PathBuf {
    if let Some(path) = env::var_os("CODEX_QUOTA_MONITOR_HOME") {
        return PathBuf::from(path);
    }

    if cfg!(target_os = "windows") {
        env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(home_dir)
            .join("CodexQuotaMonitor")
    } else if cfg!(target_os = "macos") {
        home_dir()
            .join("Library")
            .join("Application Support")
            .join("CodexQuotaMonitor")
    } else {
        env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join(".config"))
            .join("CodexQuotaMonitor")
    }
}

fn home_dir() -> PathBuf {
    env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;

    struct TestEnvironment {
        root: PathBuf,
        codex_home: PathBuf,
        ledger_path: PathBuf,
    }

    impl TestEnvironment {
        fn new(name: &str) -> Self {
            let root = env::temp_dir().join(format!(
                "codex-quota-monitor-{name}-{}-{}",
                std::process::id(),
                now_ms()
            ));
            let codex_home = root.join("codex-home");
            let ledger_path = root.join("app-data").join("usage-ledger.sqlite");
            fs::create_dir_all(codex_home.join("sessions").join("2026").join("07"))
                .expect("sessions directory should be created");
            fs::create_dir_all(codex_home.join("archived_sessions"))
                .expect("archive directory should be created");
            Self {
                root,
                codex_home,
                ledger_path,
            }
        }

        fn active_file(&self) -> PathBuf {
            self.codex_home
                .join("sessions")
                .join("2026")
                .join("07")
                .join("rollout-2026-07-17T10-00-00-019f68a9-adf2-7090-b9de-16acdba46e08.jsonl")
        }

        fn archived_file(&self) -> PathBuf {
            self.codex_home
                .join("archived_sessions")
                .join("rollout-2026-07-17T10-00-00-019f68a9-adf2-7090-b9de-16acdba46e08.jsonl")
        }

        fn scan(&self) -> UsageDashboard {
            scan_usage_at(&self.codex_home, &self.ledger_path).expect("scan should succeed")
        }
    }

    impl Drop for TestEnvironment {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn persisted_usage_survives_archive_move_and_source_deletion() {
        let environment = TestEnvironment::new("delete");
        let timestamp = sqlite_timestamp("-1 minute");
        let contents = format!(
            "{}\n{}\n",
            turn_context_line(),
            token_line(&timestamp, 10, 10, true)
        );
        fs::write(environment.active_file(), &contents).expect("active file should be written");
        fs::write(environment.archived_file(), &contents).expect("duplicate should be written");

        assert_eq!(environment.scan().totals.total_tokens, 10);
        fs::remove_file(environment.active_file()).expect("active file should be removed");
        assert_eq!(environment.scan().totals.total_tokens, 10);
        fs::remove_file(environment.archived_file()).expect("archive should be removed");
        assert_eq!(environment.scan().totals.total_tokens, 10);
    }

    #[test]
    fn first_import_includes_archived_only_sessions() {
        let environment = TestEnvironment::new("archived-only");
        let timestamp = sqlite_timestamp("-1 minute");
        fs::write(
            environment.archived_file(),
            format!(
                "{}\n{}\n",
                turn_context_line(),
                token_line(&timestamp, 15, 15, false)
            ),
        )
        .expect("archived file should be written");

        assert_eq!(environment.scan().totals.total_tokens, 15);
    }

    #[test]
    fn incremental_scan_waits_for_complete_line_and_never_double_counts() {
        let environment = TestEnvironment::new("partial");
        let first_timestamp = sqlite_timestamp("-2 minutes");
        let second_timestamp = sqlite_timestamp("-1 minute");
        let contents = format!(
            "{}\n{}\n",
            turn_context_line(),
            token_line(&first_timestamp, 10, 10, false)
        );
        fs::write(environment.active_file(), contents).expect("initial file should be written");

        assert_eq!(environment.scan().totals.total_tokens, 10);
        assert_eq!(environment.scan().totals.total_tokens, 10);

        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(environment.active_file())
            .expect("file should open for append");
        write!(file, "{}", token_line(&second_timestamp, 20, 30, false))
            .expect("partial line should be written");
        file.flush().expect("partial line should be flushed");
        assert_eq!(environment.scan().totals.total_tokens, 10);

        writeln!(file).expect("newline should be written");
        file.flush().expect("newline should be flushed");
        assert_eq!(environment.scan().totals.total_tokens, 30);
        assert_eq!(environment.scan().totals.total_tokens, 30);
    }

    #[test]
    fn rescan_after_truncation_preserves_existing_events() {
        let environment = TestEnvironment::new("truncate");
        let first_timestamp = sqlite_timestamp("-2 minutes");
        let second_timestamp = sqlite_timestamp("-1 minute");
        let first = token_line(&first_timestamp, 10, 10, false);
        let second = token_line(&second_timestamp, 20, 30, false);
        fs::write(
            environment.active_file(),
            format!("{}\n{}\n{}\n", turn_context_line(), first, second),
        )
        .expect("file should be written");
        assert_eq!(environment.scan().totals.total_tokens, 30);

        fs::write(
            environment.active_file(),
            format!("{}\n{}\n", turn_context_line(), first),
        )
        .expect("file should be truncated");
        assert_eq!(environment.scan().totals.total_tokens, 30);
    }

    #[test]
    fn reset_uses_history_floor_and_preserves_quota() {
        let environment = TestEnvironment::new("reset");
        let old_timestamp = sqlite_timestamp("-1 minute");
        fs::write(
            environment.active_file(),
            format!(
                "{}\n{}\n",
                turn_context_line(),
                token_line(&old_timestamp, 10, 10, true)
            ),
        )
        .expect("file should be written");
        let initial = environment.scan();
        assert_eq!(initial.totals.total_tokens, 10);
        assert!(initial
            .latest
            .and_then(|latest| latest.rate_limit)
            .is_some());

        let reset = reset_token_history_at(&environment.codex_home, &environment.ledger_path)
            .expect("reset should succeed");
        assert_eq!(reset.totals.total_tokens, 0);
        assert!(reset.latest.and_then(|latest| latest.rate_limit).is_some());
        assert_eq!(environment.scan().totals.total_tokens, 0);

        let new_timestamp = sqlite_timestamp("+1 minute");
        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(environment.active_file())
            .expect("file should open for append");
        writeln!(file, "{}", token_line(&new_timestamp, 20, 30, true))
            .expect("new event should be written");
        assert_eq!(environment.scan().totals.total_tokens, 20);
    }

    #[test]
    fn corrupt_ledger_is_reported_without_destructive_recreation() {
        let environment = TestEnvironment::new("corrupt");
        let corrupt_contents = b"this is not a sqlite database";
        fs::create_dir_all(
            environment
                .ledger_path
                .parent()
                .expect("ledger should have a parent"),
        )
        .expect("app data directory should be created");
        fs::write(&environment.ledger_path, corrupt_contents)
            .expect("corrupt ledger should be written");

        let error = scan_usage_at(&environment.codex_home, &environment.ledger_path)
            .expect_err("corrupt ledger should fail");
        assert!(!error.is_empty());
        assert_eq!(
            fs::read(&environment.ledger_path).expect("ledger should still exist"),
            corrupt_contents
        );
    }

    #[test]
    fn ledger_never_stores_conversation_body() {
        let environment = TestEnvironment::new("privacy");
        let timestamp = sqlite_timestamp("-1 minute");
        let secret = "PRIVATE-CONVERSATION-BODY-DO-NOT-STORE";
        let conversation_line = json!({
            "timestamp": timestamp,
            "type": "response_item",
            "payload": { "text": secret }
        });
        fs::write(
            environment.active_file(),
            format!(
                "{}\n{}\n{}\n",
                conversation_line,
                turn_context_line(),
                token_line(&timestamp, 10, 10, false)
            ),
        )
        .expect("source file should be written");
        environment.scan();

        let database_bytes = fs::read(&environment.ledger_path).expect("ledger should be readable");
        assert!(!database_bytes
            .windows(secret.len())
            .any(|window| window == secret.as_bytes()));
    }

    #[test]
    fn spark_quota_is_not_persisted() {
        let value = json!({
            "primary": { "used_percent": 5.0, "window_minutes": 10080, "resets_at": 42 },
            "secondary": null
        });
        assert!(rate_limit_snapshot(&value, Some("gpt-5.3-codex-spark"), Some(121_600)).is_none());
    }

    #[test]
    fn spark_rate_limit_is_rejected_even_for_a_non_spark_model() {
        let value = json!({
            "limit_id": "codex_bengalfox",
            "limit_name": "GPT-5.3-Codex-Spark",
            "primary": { "used_percent": 0.0, "window_minutes": 10080, "resets_at": 42 },
            "secondary": null
        });

        assert!(rate_limit_snapshot(&value, Some("gpt-5.6-sol"), Some(258_400)).is_none());
    }

    #[test]
    fn main_codex_rate_limit_is_kept() {
        let value = json!({
            "limit_id": "codex",
            "limit_name": null,
            "primary": { "used_percent": 9.0, "window_minutes": 10080, "resets_at": 42 },
            "secondary": null
        });

        let snapshot = rate_limit_snapshot(&value, Some("gpt-5.6-sol"), Some(258_400))
            .expect("main Codex quota should be retained");
        assert_eq!(snapshot.used_percent, Some(9.0));
    }

    #[test]
    fn schema_v2_rebuilds_quota_snapshots() {
        let environment = TestEnvironment::new("quota-schema-v2");
        let timestamp = sqlite_timestamp("-1 minute");
        fs::write(
            environment.active_file(),
            format!(
                "{}\n{}\n",
                turn_context_line(),
                token_line(&timestamp, 10, 10, true)
            ),
        )
        .expect("source file should be written");
        assert_eq!(
            environment
                .scan()
                .latest
                .and_then(|latest| latest.rate_limit)
                .and_then(|snapshot| snapshot.used_percent),
            Some(27.0)
        );

        {
            let connection = Connection::open(&environment.ledger_path)
                .expect("ledger should be opened for downgrade simulation");
            connection
                .execute(
                    "INSERT INTO quota_snapshots(
                         event_key, timestamp, minute, used_percent, window_minutes, resets_at
                     ) VALUES(?1, ?2, ?3, 0, 10080, ?4)",
                    params![
                        b"stale-spark-snapshot",
                        sqlite_timestamp("+1 minute"),
                        sqlite_timestamp("+1 minute"),
                        (now_ms() / 1000 + 3600) as i64,
                    ],
                )
                .expect("stale Spark snapshot should be inserted");
            connection
                .pragma_update(None, "user_version", 1)
                .expect("schema should be downgraded for migration test");
        }

        assert_eq!(
            environment
                .scan()
                .latest
                .and_then(|latest| latest.rate_limit)
                .and_then(|snapshot| snapshot.used_percent),
            Some(27.0)
        );

        let connection =
            Connection::open(&environment.ledger_path).expect("migrated ledger should be opened");
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("schema version should be readable");
        let stale_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM quota_snapshots WHERE used_percent = 0",
                [],
                |row| row.get(0),
            )
            .expect("stale snapshot count should be readable");
        assert_eq!(version, 2);
        assert_eq!(stale_count, 0);
    }

    fn sqlite_timestamp(modifier: &str) -> String {
        let connection = Connection::open_in_memory().expect("in-memory database should open");
        let sql = format!(
            "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '{}')",
            modifier.replace('\'', "''")
        );
        connection
            .query_row(&sql, [], |row| row.get(0))
            .expect("timestamp should be generated")
    }

    fn turn_context_line() -> String {
        json!({
            "timestamp": sqlite_timestamp("-3 minutes"),
            "type": "turn_context",
            "payload": { "model": "gpt-5.5" }
        })
        .to_string()
    }

    fn token_line(timestamp: &str, last_total: u64, cumulative_total: u64, quota: bool) -> String {
        let rate_limits = quota.then(|| {
            json!({
                "limit_id": "codex",
                "limit_name": null,
                "primary": { "used_percent": 2.0, "window_minutes": 300, "resets_at": 1 },
                "secondary": {
                    "used_percent": 27.0,
                    "window_minutes": 10080,
                    "resets_at": (now_ms() / 1000 + 3600) as i64
                },
                "plan_type": "pro",
                "credits": { "has_credits": true, "unlimited": false, "balance": "1" }
            })
        });
        json!({
            "timestamp": timestamp,
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": {
                    "last_token_usage": {
                        "input_tokens": last_total,
                        "cached_input_tokens": 0,
                        "output_tokens": 0,
                        "reasoning_output_tokens": 0,
                        "total_tokens": last_total
                    },
                    "total_token_usage": {
                        "input_tokens": cumulative_total,
                        "cached_input_tokens": 0,
                        "output_tokens": 0,
                        "reasoning_output_tokens": 0,
                        "total_tokens": cumulative_total
                    },
                    "model_context_window": 258400
                },
                "rate_limits": rate_limits
            }
        })
        .to_string()
    }
}
