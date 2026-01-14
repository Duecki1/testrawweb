use anyhow::Result;
use serde::{Deserialize, Serialize};
use sqlx::{sqlite::SqliteRow, Row, SqlitePool};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileMeta {
    pub path: String,
    pub camera_rating: Option<i32>,
    pub user_rating: Option<i32>,
    pub tags: Vec<String>,
    pub gps_lat: Option<f64>,
    pub gps_lon: Option<f64>,
    pub taken_at: Option<String>,
    pub file_size: i64,
    pub last_modified: i64,
}

pub async fn init_db(pool: &SqlitePool) -> Result<()> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS config (\
            key TEXT PRIMARY KEY,\
            value TEXT NOT NULL\
        );",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS files (\
            path TEXT PRIMARY KEY,\
            camera_rating INTEGER,\
            user_rating INTEGER,\
            tags TEXT,\
            gps_lat REAL,\
            gps_lon REAL,\
            taken_at TEXT,\
            file_size INTEGER NOT NULL,\
            last_modified INTEGER NOT NULL\
        );",
    )
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn get_config(pool: &SqlitePool, key: &str) -> Result<Option<String>> {
    let row = sqlx::query("SELECT value FROM config WHERE key = ?")
        .bind(key)
        .fetch_optional(pool)
        .await?;

    Ok(row.map(|r| r.get::<String, _>("value")))
}

pub async fn set_config(pool: &SqlitePool, key: &str, value: &str) -> Result<()> {
    sqlx::query(
        "INSERT INTO config (key, value) VALUES (?, ?)\
        ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
    )
    .bind(key)
    .bind(value)
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn get_file_meta(pool: &SqlitePool, path: &str) -> Result<Option<FileMeta>> {
    let row = sqlx::query(
        "SELECT path, camera_rating, user_rating, tags, gps_lat, gps_lon, taken_at, file_size, last_modified \
        FROM files WHERE path = ?",
    )
    .bind(path)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(row_to_meta))
}

pub async fn upsert_file_meta(pool: &SqlitePool, meta: &FileMeta) -> Result<()> {
    let tags_json = serde_json::to_string(&meta.tags)?;
    sqlx::query(
        "INSERT INTO files (path, camera_rating, user_rating, tags, gps_lat, gps_lon, taken_at, file_size, last_modified)\
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)\
        ON CONFLICT(path) DO UPDATE SET\
            camera_rating = excluded.camera_rating,\
            user_rating = excluded.user_rating,\
            tags = excluded.tags,\
            gps_lat = excluded.gps_lat,\
            gps_lon = excluded.gps_lon,\
            taken_at = excluded.taken_at,\
            file_size = excluded.file_size,\
            last_modified = excluded.last_modified;",
    )
    .bind(&meta.path)
    .bind(meta.camera_rating)
    .bind(meta.user_rating)
    .bind(tags_json)
    .bind(meta.gps_lat)
    .bind(meta.gps_lon)
    .bind(&meta.taken_at)
    .bind(meta.file_size)
    .bind(meta.last_modified)
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn upsert_user_rating(
    pool: &SqlitePool,
    path: &str,
    rating: Option<i32>,
    file_size: i64,
    last_modified: i64,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO files (path, user_rating, tags, file_size, last_modified)\
        VALUES (?, ?, ?, ?, ?)\
        ON CONFLICT(path) DO UPDATE SET\
            user_rating = excluded.user_rating,\
            file_size = excluded.file_size,\
            last_modified = excluded.last_modified;",
    )
    .bind(path)
    .bind(rating)
    .bind("[]")
    .bind(file_size)
    .bind(last_modified)
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn upsert_tags(
    pool: &SqlitePool,
    path: &str,
    tags: &[String],
    file_size: i64,
    last_modified: i64,
) -> Result<()> {
    let tags_json = serde_json::to_string(tags)?;
    sqlx::query(
        "INSERT INTO files (path, user_rating, tags, file_size, last_modified)\
        VALUES (?, ?, ?, ?, ?)\
        ON CONFLICT(path) DO UPDATE SET\
            tags = excluded.tags,\
            file_size = excluded.file_size,\
            last_modified = excluded.last_modified;",
    )
    .bind(path)
    .bind(None::<i32>)
    .bind(tags_json)
    .bind(file_size)
    .bind(last_modified)
    .execute(pool)
    .await?;

    Ok(())
}

fn row_to_meta(row: SqliteRow) -> FileMeta {
    let tags_raw: Option<String> = row.get("tags");
    let tags: Vec<String> = tags_raw
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();

    FileMeta {
        path: row.get("path"),
        camera_rating: row.get("camera_rating"),
        user_rating: row.get("user_rating"),
        tags,
        gps_lat: row.get("gps_lat"),
        gps_lon: row.get("gps_lon"),
        taken_at: row.get("taken_at"),
        file_size: row.get("file_size"),
        last_modified: row.get("last_modified"),
    }
}
